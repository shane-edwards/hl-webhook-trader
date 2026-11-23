import { withTradingLock } from '@/lib/trading-lock';
// Managed exits: split take-profit, stop to break-even after the first target,
// and a trailing stop.
//
// Hyperliquid has no native trailing or "move my stop" order. The stop and
// targets themselves rest on the exchange, but moving the stop is done by this
// app: by the fast scan about every ten seconds while anything is open, and by
// the five-minute scan as a fallback. Between passes the last stop placed still
// protects the position.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient, TriggerLeg } from '@/lib/hyperliquid/client';
import { MIN_ORDER_USD } from '@/lib/hyperliquid/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
type Side = 'long' | 'short';

export interface ExitOptions {
  /** Share of the position closed at the (first) target, 0-1. 1 or undefined = all of it. */
  tp1Fraction?: number | null;
  /** Second target for the remainder, percent from entry. */
  takeProfit2Pct?: number | null;
  /** Once target 1 has filled, move the stop to the entry price. */
  breakevenAfterTp1?: boolean;
  /** Trail the stop this far (percent) behind the best price. Starts after target 1 when there is a split, otherwise at once. */
  trailPct?: number | null;
}

/** Does this trade need the scan to manage it, or will plain exchange orders do? */
export function isManaged(e: ExitOptions | null | undefined, hasTarget: boolean): boolean {
  if (!e) return false;
  const split = hasTarget && e.tp1Fraction != null && e.tp1Fraction > 0 && e.tp1Fraction < 1;
  return split || (!!e.breakevenAfterTp1 && split) || (e.trailPct != null && e.trailPct > 0);
}

export interface PlanFields {
  side: Side;
  entry_price: number;
  initial_size: number;
  stop_px: number | null;
  tp1_px: number | null;
  tp1_fraction: number | null;
  tp2_px: number | null;
  breakeven_after_tp1: boolean;
  trail_pct: number | null;
}

const floorTo = (x: number, decimals: number) => Math.floor(x * 10 ** decimals + 1e-9) / 10 ** decimals;

/**
 * The orders to rest on the exchange for a freshly opened position, and the
 * plan the scan will follow. A split is dropped (with a warning) when either
 * part would be under the exchange's $10 minimum.
 */
export function buildExitLegs(p: {
  side: Side; entryPrice: number; size: number; szDecimals: number;
  stopLossPct: number | null; takeProfitPct: number | null; exit: ExitOptions;
}): { legs: TriggerLeg[]; plan: PlanFields; warning: string | null } {
  const dir = p.side === 'long' ? 1 : -1;
  const px = (pct: number) => p.entryPrice * (1 + (dir * pct) / 100);
  const trail = p.exit.trailPct != null && p.exit.trailPct > 0 ? p.exit.trailPct : null;
  let warning: string | null = null;

  // A trailing stop with no fixed stop starts one trail-distance from entry.
  const stopPct = p.stopLossPct ?? trail;
  const stopPx = stopPct != null ? px(-stopPct) : null;

  let fraction = p.takeProfitPct != null && p.exit.tp1Fraction != null && p.exit.tp1Fraction > 0 && p.exit.tp1Fraction < 1 ? p.exit.tp1Fraction : null;
  let tp1Size = p.size, restSize = 0;
  if (fraction != null) {
    tp1Size = floorTo(p.size * fraction, p.szDecimals);
    restSize = floorTo(p.size - tp1Size, p.szDecimals);
    if (tp1Size * p.entryPrice < MIN_ORDER_USD || restSize * p.entryPrice < MIN_ORDER_USD) {
      warning = `Position too small to split (each part must be at least $${MIN_ORDER_USD}); one target was placed for the whole position`;
      fraction = null; tp1Size = p.size; restSize = 0;
    }
  }
  const tp2Pct = fraction != null && p.exit.takeProfit2Pct != null && p.exit.takeProfit2Pct > 0 ? p.exit.takeProfit2Pct : null;

  const legs: TriggerLeg[] = [];
  if (stopPx != null) legs.push({ kind: 'sl', triggerPx: stopPx, size: p.size });
  if (p.takeProfitPct != null) legs.push({ kind: 'tp', triggerPx: px(p.takeProfitPct), size: tp1Size });
  if (tp2Pct != null) legs.push({ kind: 'tp', triggerPx: px(tp2Pct), size: restSize });

  return {
    legs,
    warning,
    plan: {
      side: p.side, entry_price: p.entryPrice, initial_size: p.size, stop_px: stopPx,
      tp1_px: p.takeProfitPct != null ? px(p.takeProfitPct) : null,
      tp1_fraction: fraction,
      tp2_px: tp2Pct != null ? px(tp2Pct) : null,
      breakeven_after_tp1: !!p.exit.breakevenAfterTp1 && fraction != null,
      trail_pct: trail,
    },
  };
}

export interface PlanRow extends PlanFields {
  id: string; symbol: string; tp1_done: boolean; high_water: number | null; stop_oid: string | null;
}

export type ExitStep =
  | { type: 'done' }
  /** The stop should already have fired (price is through it and no stop order exists): close now. */
  | { type: 'close'; reason: string }
  | { type: 'hold'; tp1Done: boolean; highWater: number | null }
  | { type: 'move_stop'; tp1Done: boolean; highWater: number | null; stopPx: number; reason: string };

/**
 * What to do with a managed position on this scan. Pure: the same inputs
 * always give the same step, so it can be tested against a simulated exchange.
 */
export function nextExitStep(plan: PlanRow, pos: { side: Side; size: number; markPrice: number } | null, hasStopOrder: boolean, szDecimals: number): ExitStep {
  if (!pos || pos.side !== plan.side) return { type: 'done' };
  const dir = plan.side === 'long' ? 1 : -1;
  const better = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : dir * (b - a) > 0 ? b : a);
  const dust = 0.51 * 10 ** -szDecimals;

  const split = plan.tp1_px != null && plan.tp1_fraction != null && plan.tp1_fraction < 1;
  const tp1Done = plan.tp1_done || (split && pos.size <= plan.initial_size * (1 - plan.tp1_fraction!) + dust);

  let stop = plan.stop_px;
  const reasons: string[] = [];
  if (tp1Done && plan.breakeven_after_tp1) {
    const s = better(stop, plan.entry_price);
    if (s !== stop) { stop = s; reasons.push('target 1 filled: stop moved to break-even'); }
  }
  let highWater = plan.high_water;
  if (plan.trail_pct != null && (!split || tp1Done)) {
    highWater = highWater == null ? pos.markPrice : dir * (pos.markPrice - highWater) > 0 ? pos.markPrice : highWater;
    const s = better(stop, highWater * (1 - (dir * plan.trail_pct) / 100));
    if (s !== stop) { stop = s; reasons.push(`trailing ${plan.trail_pct}% behind ${highWater}`); }
  }
  if (stop == null) return { type: 'hold', tp1Done, highWater };

  if (!hasStopOrder && dir * (pos.markPrice - stop) <= 0) {
    return { type: 'close', reason: 'price is through the stop and no stop order is resting' };
  }
  // Ignore improvements under 0.1% so the stop is not re-sent on every scan.
  const moved = plan.stop_px == null || dir * (stop - plan.stop_px) > 0.001 * pos.markPrice;
  if (!hasStopOrder) return { type: 'move_stop', tp1Done, highWater, stopPx: moved ? stop : plan.stop_px!, reason: 'stop order was missing: placed again' };
  if (moved) return { type: 'move_stop', tp1Done, highWater, stopPx: stop, reason: reasons.join('; ') || 'stop improved' };
  return { type: 'hold', tp1Done, highWater };
}

export interface ExitEvent { symbol: string; level: 'info' | 'error'; message: string }

/** One management pass over every managed position of a user. Never throws; problems come back as events. */
export async function manageExits(hl: HyperliquidClient, db: Db, userId: string, slippagePercent: number): Promise<ExitEvent[]> {
  return withTradingLock(hl, db, userId, () => manageExitsLocked(hl, db, userId, slippagePercent));
}

async function manageExitsLocked(hl: HyperliquidClient, db: Db, userId: string, slippagePercent: number): Promise<ExitEvent[]> {
  const events: ExitEvent[] = [];
  const { data: plans, error } = await db.from('position_plans').select('*').eq('user_id', userId).eq('status', 'active');
  if (error || !plans?.length) return events; // no table yet (migration 006) or nothing managed

  const [positions, orders] = await Promise.all([hl.getPositions(), hl.getOpenOrders()]);
  const now = new Date().toISOString();
  for (const raw of plans) {
    const plan: PlanRow = {
      ...raw, entry_price: +raw.entry_price, initial_size: +raw.initial_size,
      stop_px: raw.stop_px == null ? null : +raw.stop_px, tp1_px: raw.tp1_px == null ? null : +raw.tp1_px,
      tp1_fraction: raw.tp1_fraction == null ? null : +raw.tp1_fraction, tp2_px: raw.tp2_px == null ? null : +raw.tp2_px,
      trail_pct: raw.trail_pct == null ? null : +raw.trail_pct, high_water: raw.high_water == null ? null : +raw.high_water,
    };
    try {
      const pos = positions.find(p => p.symbol === plan.symbol) ?? null;
      const stops = orders.filter(o => o.coin === plan.symbol && o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType));
      const { meta } = await hl.getAsset(plan.symbol);
      const step = nextExitStep(plan, pos, stops.length > 0, meta.szDecimals);

      if (step.type === 'done') {
        // Position gone (stopped, target 2 filled, or closed by hand): clear what is left of its orders.
        if (!pos) await hl.cancelProtectiveOrders(plan.symbol).catch(() => {});
        await db.from('position_plans').update({ status: 'done', updated_at: now }).eq('id', plan.id);
        events.push({ symbol: plan.symbol, level: 'info', message: `${plan.symbol} ${plan.side} is closed on the exchange (stop, target or by hand); its exit plan has ended` });
        continue;
      }
      if (step.type === 'close') {
        const closed = await hl.closePosition(plan.symbol, slippagePercent);
        if (!closed.fullyClosed || await hl.getPosition(plan.symbol)) {
          throw new Error(`Only ${closed.filledSize} closed. The exit plan remains active for the remainder`);
        }
        await hl.cancelProtectiveOrders(plan.symbol).catch(() => {});
        await db.from('position_plans').update({ status: 'done', last_note: step.reason, updated_at: now }).eq('id', plan.id);
        events.push({ symbol: plan.symbol, level: 'error', message: `Closed ${plan.symbol} at ${closed.fillPrice}: ${step.reason}` });
        continue;
      }
      const patch: Record<string, unknown> = { tp1_done: step.tp1Done, high_water: step.highWater, updated_at: now };
      if (step.type === 'move_stop') {
        // New stop first, then cancel the old one: the position is never without a stop.
        const [oid] = await hl.placeTriggerOrders({ coin: plan.symbol, side: plan.side, legs: [{ kind: 'sl', triggerPx: step.stopPx, size: pos!.size }], grouping: 'na' });
        const verified = (await hl.getOpenOrders(plan.symbol)).some(o => String(o.oid) === oid && o.isTrigger && o.reduceOnly && o.size >= pos!.size * 0.999);
        if (!oid || !verified) throw new Error('Replacement stop is unconfirmed. Existing stops were retained');
        await hl.cancelOrders(plan.symbol, stops.map(s => s.oid)).catch(() => {});
        Object.assign(patch, { stop_px: step.stopPx, stop_oid: oid, last_note: step.reason });
        events.push({ symbol: plan.symbol, level: 'info', message: `${plan.symbol} stop now ${step.stopPx.toPrecision(6)} (${step.reason})` });
      }
      await db.from('position_plans').update(patch).eq('id', plan.id);
    } catch (err) {
      events.push({ symbol: plan.symbol, level: 'error', message: `Could not manage the ${plan.symbol} exit plan: ${err instanceof Error ? err.message : err}` });
    }
  }
  return events;
}
