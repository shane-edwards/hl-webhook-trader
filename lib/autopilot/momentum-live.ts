import { accountResource, liveEntryReservation } from '@/lib/trading-lock';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closePositionFully, openPosition } from '@/lib/execution';
import { estimateFill, liquidityVerdict } from '@/lib/liquidity';
import { attributeCosts, exitFromFills } from '@/lib/reconcile';
import { getUserFills, getUserFunding } from '@/lib/hyperliquid/public';
import type { AutopilotConfig } from './run';
import { DAY_MS, MOMENTUM_HOLD_DAYS, MOMENTUM_ID, MOMENTUM_STOP_PCT, momentumOrderPlan, momentumPlanKey, rankMomentum, type MomentumEvent } from './momentum';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
type Leg = { account_resource: string; side: string; entry_order_id?: string; recovery_pending?: boolean; id: string; symbol: string; entry_time: string; size: number; stop_price: number; exit_reason: string | null; entry_reason: string };
const ABORTED = 'Basket closed after a stop or incomplete entry';
const ATTEMPTED = 'Weekly basket order sent or pending';

/** Called under the live trading lock. Pending legs persist across worker timeouts. */
export async function runMomentumLive(hl: HyperliquidClient, db: Db, userId: string, cfg: AutopilotConfig, equity: number, canOpen: boolean, now: number, events: MomentumEvent[], manualPlan?: string) {
  const book = () => db.from('autopilot_positions').select('*').eq('user_id', userId).eq('mode', 'live').eq('strategy_id', MOMENTUM_ID);
  const { data, error } = await book().eq('status', 'open');
  if (error) throw new Error(error.message);
  const legs: Leg[] = data ?? [];
  const resource = accountResource(hl, userId);
  if (legs.some(leg => leg.account_resource !== resource)) throw new Error('Basket recovery requires the verified original wallet and network');
  if (manualPlan && legs.length) return false;
  if (!legs.length && !canOpen) return;

  const positions = new Map((await hl.getPositions()).map(p => [p.symbol, p]));
  const lastEntry = Math.max(0, ...legs.map(leg => Date.parse(leg.entry_time)));
  const interrupted = legs.some(leg => leg.recovery_pending || !positions.has(leg.symbol) || Number(leg.stop_price) === 0 || leg.exit_reason === ABORTED);
  if (legs.length && !interrupted && now - lastEntry < MOMENTUM_HOLD_DAYS * DAY_MS) return;

  async function closeBasket(rows: Leg[], reason: string) {
    // Mark the entire batch before sending any close. A retry resumes the unwind.
    for (const leg of rows) {
      const { error } = await db.from('autopilot_positions').update({ exit_reason: reason, recovery_pending: leg.entry_reason === ATTEMPTED }).eq('id', leg.id);
      if (error) throw new Error(error.message);
    }
    const failures: string[] = [];
    for (const leg of rows) {
      try {
        if (leg.entry_reason !== ATTEMPTED) {
          const { error } = await db.from('autopilot_positions').update({ status: 'closed', exit_time: new Date(now).toISOString(), pnl: 0 }).eq('id', leg.id);
          if (error) throw new Error(error.message);
          continue;
        }
        const position = await hl.getPosition(leg.symbol);
        if (position && position.side !== leg.side) throw new Error('Basket position changed side. Check the original account.');
        if (position) await closePositionFully(hl, db, userId, leg.symbol, cfg.slippagePercent, reason);
        const since = Date.parse(leg.entry_time);
        const [{ fills, truncated }, funding] = await Promise.all([
          getUserFills(hl.address, since - 5000, hl.isTestnet), getUserFunding(hl.address, since, hl.isTestnet),
        ]);
        if (truncated) throw new Error('Waiting for complete exchange fill history');
        const exit = exitFromFills(fills, leg.symbol, since - 5000);
        if (!exit && (leg.entry_order_id || Number(leg.stop_price) > 0 || now - since < 180_000 ||
            fills.some(f => f.coin === leg.symbol && f.time >= since))) throw new Error('Waiting for closing fill');
        const net = exit ? attributeCosts([{ id: leg.id, symbol: leg.symbol, size: Number(leg.size), entryTime: since, exitTime: exit.time }], fills, funding).get(leg.id)!.netPnl : null;
        const { error } = await db.from('autopilot_positions').update({ status: 'closed', recovery_pending: false, exit_price: exit?.price ?? null, exit_time: new Date(now).toISOString(), pnl: net }).eq('id', leg.id);
        if (error) throw new Error(error.message);
      } catch (err) {
        failures.push(`${leg.symbol}: ${err instanceof Error ? err.message : 'could not close leg'}`);
      }
    }
    if (failures.length) throw new Error(failures.join(' · '));
  }

  if (legs.length) {
    await closeBasket(legs, interrupted ? ABORTED : 'Weekly rebalance');
    events.push({ level: interrupted ? 'warn' : 'trade', message: interrupted ? ABORTED : 'Closed the previous momentum basket' });
    if (interrupted || !canOpen) return;
  }

  const recent = await book().eq('exit_reason', ABORTED).gte('entry_time', new Date(now - MOMENTUM_HOLD_DAYS * DAY_MS).toISOString()).limit(1);
  if (recent.error) throw new Error(recent.error.message);
  if (recent.data?.length) return;
  const [ranked, accountPositions, orders] = await Promise.all([rankMomentum(hl, now), hl.getPositions(), hl.getOpenOrders()]);
  const gross = accountPositions.reduce((sum, p) => sum + p.size * p.markPrice, 0) + orders.filter(o => !o.reduceOnly).reduce((sum, o) => sum + o.size * o.limitPx, 0);
  const occupied = new Set([...accountPositions.map(p => p.symbol), ...orders.map(o => o.coin)]);
  if (cfg.reservedSymbol) occupied.add(cfg.reservedSymbol);
  const maxExposure = equity * (cfg.portfolio?.maxGrossExposureX ?? 3);
  const basketRiskCap = equity * cfg.risk.riskPerTradePct / MOMENTUM_STOP_PCT;
  const plan = momentumOrderPlan(ranked, Math.min(equity, basketRiskCap), maxExposure - gross, cfg.risk.maxPositions - accountPositions.length);
  if (manualPlan && momentumPlanKey(plan) !== manualPlan) return false;
  if (plan.length === 0 || plan.some(leg => occupied.has(leg.symbol))) {
    events.push({ level: 'info', message: 'Basket entry needs sufficient risk budget and at least four free markets' });
    return;
  }
  for (const leg of plan) {
    const execution = liquidityVerdict(estimateFill(await hl.getBook(leg.symbol), leg.side === 'long' ? 'buy' : 'sell', leg.notional), cfg.slippagePercent);
    if (execution.level === 'block') {
      events.push({ level: 'info', symbol: leg.symbol, message: execution.message ?? 'Selected basket market is too thin' });
      return false;
    }
  }
  if (cfg.checkEntries && !await cfg.checkEntries()) return false;
  const rows = plan.map(leg => ({
    user_id: userId, account_resource: resource, mode: 'live', status: 'open', strategy_id: MOMENTUM_ID, symbol: leg.symbol, side: leg.side,
    entry_price: leg.price, notional_usd: leg.notional, size: leg.notional / leg.price, stop_price: 0,
    entry_bar_t: Math.floor(now / DAY_MS) * DAY_MS, entry_time: new Date(now).toISOString(), entry_reason: 'Weekly momentum basket',
  }));
  const reserved = await db.from('autopilot_positions').insert(rows).select('id, symbol, side, account_resource, entry_order_id, entry_time, size, stop_price, exit_reason, entry_reason');
  if (reserved.error?.code === '23505') return;
  if (reserved.error || !reserved.data) throw new Error(reserved.error?.message ?? 'Cannot reserve basket entries');

  try {
    for (const leg of plan) {
      const row = reserved.data.find(item => item.symbol === leg.symbol)!;
      if (cfg.checkEntries && !await cfg.checkEntries()) throw new Error('Basket setup changed during entry');
      if (await hl.getPosition(leg.symbol) || (await hl.getOpenOrders(leg.symbol)).some(o => !o.reduceOnly)) throw new Error(`${leg.symbol} already has a position or order`);
      const recorded = await db.from('autopilot_positions').update({ entry_reason: ATTEMPTED, recovery_pending: true }).eq('id', row.id);
      if (recorded.error) throw new Error(recorded.error.message);
      row.entry_reason = ATTEMPTED;
      const opened = await liveEntryReservation.run(row.id, () => openPosition(hl, db, {
        userId, symbol: leg.symbol, side: leg.side, sizeUsd: leg.notional, leverage: 1,
        slippagePercent: cfg.slippagePercent, stopLossPct: MOMENTUM_STOP_PCT, takeProfitPct: null, closeIfUnprotected: true,
        source: 'autopilot', payload: { strategy: MOMENTUM_ID }, limits: cfg.portfolio,
      }));
      row.size = opened.size;
      row.entry_order_id = opened.orderId;
      const needsExit = !!opened.protectionError || opened.stopLossPx == null || opened.size * opened.fillPrice < leg.notional * 0.9;
      row.stop_price = opened.stopLossPx ?? 0;
      const saved = await db.from('autopilot_positions').update({
        entry_order_id: opened.orderId, recovery_pending: needsExit, entry_price: opened.fillPrice, size: opened.size,
        notional_usd: opened.size * opened.fillPrice, stop_price: row.stop_price,
      }).eq('id', row.id);
      if (saved.error) throw new Error(saved.error.message);
      if (needsExit) throw new Error(`${leg.symbol} could not fill with full protection and size`);
    }
    events.push({ level: 'trade', message: `Momentum basket opened across ${plan.length} protected positions` });
    return true;
  } catch (err) {
    await closeBasket(reserved.data, ABORTED);
    throw err;
  }
}
