import { getUserFills, getUserFunding } from '@/lib/hyperliquid/public';
import { attributeCosts, exitFromFills } from '@/lib/reconcile';
import { withTradingLock } from '@/lib/trading-lock';
// The Autopilot scan: look at every watched market, manage positions it owns,
// and open new ones when a strategy fires and the risk rules allow it.
//
// Paper mode runs the identical logic against live prices but only records
// what it would have done, building a forward-test track record.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closePositionFully, openPosition } from '@/lib/execution';
import { notify } from '@/lib/notify';
import evidenceFile from './evidence.json';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar, type StrategyDef } from './strategies';
import { MOMENTUM_ID, runMomentumPaper } from './momentum';
import { portfolioLimitsFromSettings, type PortfolioLimits } from '@/lib/risk/portfolio';
import { canOpenPosition, checkRisk, DEFAULT_RISK, sizeNotional, type RiskConfig, type RiskState } from './risk';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
export type Mode = 'paper' | 'live';

const HOUR_MS = 3_600_000;
/** Cost charged to paper fills so the paper record is not flattering: taker fee + slippage. */
const PAPER_COST = 0.00065;
const BARS_NEEDED = WARMUP_BARS + 30;

export interface AutopilotConfig {
  mode: Mode;
  symbols: string[];
  strategies: string[];
  allowShort: boolean;
  risk: RiskConfig;
  slippagePercent: number;
  /** Symbol reserved by the built-in daily strategy, if that is trading live. */
  reservedSymbol: string | null;
  /** Account-wide limits shared with manual and webhook trades (live mode only). */
  portfolio?: PortfolioLimits;
}

export interface AutopilotEvent { level: 'info' | 'trade' | 'warn' | 'error'; symbol?: string; strategyId?: string; message: string }

/** May this strategy trade real money? Decided by the backtest evidence, not by the user. */
export function isLiveEligible(strategyId: string, allowShort: boolean): boolean {
  return evidenceFile.accountingVersion === 2 && evidenceFile.strategies.some(e => e.id === strategyId && e.allowShort === allowShort && e.liveEligible);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function configFromSettings(s: Record<string, any>): AutopilotConfig {
  const n = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    mode: s.autopilot_mode === 'live' ? 'live' : 'paper',
    symbols: (Array.isArray(s.autopilot_symbols) ? s.autopilot_symbols : ['BTC', 'ETH', 'SOL']).map((x: unknown) => String(x).toUpperCase()).slice(0, 20),
    strategies: Array.isArray(s.autopilot_strategies) ? s.autopilot_strategies.map(String) : ['trend_breakout'],
    allowShort: s.autopilot_allow_short === true,
    risk: {
      riskPerTradePct: n(s.autopilot_risk_per_trade_pct, DEFAULT_RISK.riskPerTradePct),
      maxPositions: n(s.autopilot_max_positions, DEFAULT_RISK.maxPositions),
      maxLeveragePerPosition: n(s.autopilot_max_leverage, DEFAULT_RISK.maxLeveragePerPosition),
      dailyLossLimitPct: n(s.autopilot_daily_loss_limit_pct, DEFAULT_RISK.dailyLossLimitPct),
      maxDrawdownPct: n(s.autopilot_max_drawdown_pct, DEFAULT_RISK.maxDrawdownPct),
    },
    slippagePercent: n(s.slippage_percent, 2),
    portfolio: portfolioLimitsFromSettings(s),
    reservedSymbol: s.strategy_enabled === true && s.strategy_dry_run === false ? String(s.strategy_symbol ?? 'BTC') : null,
  };
}

interface PositionRow {
  id: string; symbol: string; strategy_id: string; side: 'long' | 'short';
  entry_price: number; size: number; notional_usd: number; stop_price: number; entry_bar_t: number; entry_time: string; funding_paid?: number; last_funding_time?: number;
}

export interface ScanResult { mode: Mode; equity: number; canOpen: boolean; haltReason: string | null; events: AutopilotEvent[] }

export async function runAutopilot(hl: HyperliquidClient, db: Db, userId: string, cfg: AutopilotConfig, now = Date.now()): Promise<ScanResult> {
  return withTradingLock(hl, db, userId, () => runAutopilotLocked(hl, db, userId, cfg, now), cfg.mode === 'paper');
}

async function runAutopilotLocked(hl: HyperliquidClient, db: Db, userId: string, cfg: AutopilotConfig, now = Date.now()): Promise<ScanResult> {
  const { mode } = cfg;
  const events: AutopilotEvent[] = [];
  const log = (e: AutopilotEvent) => { events.push(e); };

  // ---- state and equity ----
  const { data: stateRow, error: stateError } = await db.from('autopilot_state').select('*').eq('user_id', userId).eq('mode', mode).maybeSingle();
  if (stateError) throw new Error(stateError.message);
  const closedPaper = mode === 'paper' ? await db.from('autopilot_positions').select('pnl').eq('user_id', userId).eq('mode', 'paper').eq('status', 'closed') : null;
  if (closedPaper?.error) throw new Error(closedPaper.error.message);
  let paperEquity = mode === 'paper' ? 10_000 + (closedPaper?.data ?? []).reduce((sum, p) => sum + Number(p.pnl ?? 0), 0) : 10_000;
  const liveAccount = mode === 'live' ? await hl.getAccountSummary() : null;

  const { data: openRows, error: openError } = await db
    .from('autopilot_positions').select('*').eq('user_id', userId).eq('mode', mode).eq('status', 'open');
  if (openError) throw new Error(`Could not load autopilot positions (has migration 004 been run?): ${openError.message}`);
  // The momentum basket is a separate paper book with its own weekly cycle; it is handled further down.
  const open = new Map<string, PositionRow>((openRows ?? []).filter(r => r.strategy_id !== MOMENTUM_ID).map(r => [r.symbol, { ...r, entry_price: +r.entry_price, size: +r.size, notional_usd: +r.notional_usd, stop_price: +r.stop_price, entry_bar_t: +r.entry_bar_t }]));

  const exchangePositions = mode === 'live' ? new Map((await hl.getPositions()).map(p => [p.symbol, p])) : null;

  // ---- per-market data ----
  const market = new Map<string, { bars: Bar[]; ind: ReturnType<typeof computeIndicators>; last: number }>();
  for (const symbol of new Set([...cfg.symbols, ...open.keys()])) {
    try {
      const bars = await hl.getHourlyCandles(symbol, BARS_NEEDED);
      if (bars.length < WARMUP_BARS + 2) { log({ level: 'warn', symbol, message: `Only ${bars.length} hourly candles available; skipped` }); continue; }
      if (now - bars[bars.length - 1].t > 3 * HOUR_MS) { log({ level: 'warn', symbol, message: 'Price data is stale; skipped' }); continue; }
      market.set(symbol, { bars, ind: computeIndicators(bars), last: bars.length - 1 });
    } catch (err) {
      log({ level: 'error', symbol, message: `Could not load candles: ${err instanceof Error ? err.message : err}` });
    }
  }

  if (mode === 'paper') {
    const paperPositions = [...open.values(), ...(openRows ?? []).filter(p => p.strategy_id === MOMENTUM_ID)];
    for (const p of paperPositions) {
      const since = p.last_funding_time ?? new Date(p.entry_time).getTime();
      const rates = hl.getFundingRates ? await hl.getFundingRates(p.symbol, since + 1, now) : [];
      const dir = p.side === 'long' ? 1 : -1;
      const bars = market.get(p.symbol)?.bars ?? (rates.length && hl.getHourlyCandles ? await hl.getHourlyCandles(p.symbol, Math.min(5000, Math.ceil((now - since) / HOUR_MS) + 2)) : []);
      const paid = rates.reduce((sum, r) => {
        const price = bars.findLast(b => b.t <= r.time)?.c ?? p.entry_price;
        return sum + dir * p.size * price * r.rate;
      }, 0);
      p.funding_paid = Number(p.funding_paid ?? 0) + paid;
      p.last_funding_time = rates.at(-1)?.time ?? since;
      const saved = await db.from('autopilot_positions').update({ funding_paid: p.funding_paid, last_funding_time: p.last_funding_time }).eq('id', p.id);
      if (saved.error) throw new Error(saved.error.message);
    }
  }

  const settle = async (p: PositionRow, exitPrice: number, reason: string, costRate: number, actualPnl?: number) => {
    const dir = p.side === 'long' ? 1 : -1;
    const pnl = actualPnl ?? (p.notional_usd * (dir * (exitPrice / p.entry_price - 1)) - p.notional_usd * (costRate / 2 + costRate / 2 * exitPrice / p.entry_price) - Number(p.funding_paid ?? 0));
    const settled = await db.from('autopilot_positions').update({ status: 'closed', exit_price: exitPrice, exit_time: new Date(now).toISOString(), exit_reason: reason, pnl }).eq('id', p.id);
    if (settled.error) throw new Error(settled.error.message);
    if (mode === 'paper') paperEquity += pnl;
    open.delete(p.symbol);
    log({ level: 'trade', symbol: p.symbol, strategyId: p.strategy_id, message: `Closed ${p.side} at ${exitPrice.toFixed(4)} (${reason}), P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` });
  };

  // ---- 1. manage what is already open ----
  for (const p of [...open.values()]) {
    const m = market.get(p.symbol);
    const strategy = getStrategy(p.strategy_id);
    try {
      if (mode === 'live') {
        const ex = exchangePositions!.get(p.symbol);
        if (!ex) {
          const since = new Date(p.entry_time).getTime();
          const [{ fills, truncated }, funding] = await Promise.all([
            getUserFills(hl.address, since - 5000, hl.isTestnet), getUserFunding(hl.address, since, hl.isTestnet),
          ]);
          if (truncated) throw new Error('Fill history is incomplete; live settlement is deferred');
          const exit = exitFromFills(fills, p.symbol, since - 5000);
          if (!exit) { log({ level: 'warn', symbol: p.symbol, message: 'Waiting for exchange closing fills before settlement' }); continue; }
          const actual = attributeCosts([{ id: p.id, symbol: p.symbol, size: p.size, entryTime: since, exitTime: exit.time }], fills, funding).get(p.id)!;
          await settle(p, exit.price, 'closed on the exchange; confirmed from fills', 0, actual.netPnl);
          continue;
        }
      } else if (m) {
        // Paper: was the stop touched by any bar since the signal bar? (Includes the entry bar, which errs on the harsh side.)
        const dir = p.side === 'long' ? 1 : -1;
        const hit = m.bars.find(b => b.t > p.entry_bar_t && (dir === 1 ? b.l <= p.stop_price : b.h >= p.stop_price));
        if (hit) { const gapPrice = dir === 1 ? Math.min(p.stop_price, hit.o) : Math.max(p.stop_price, hit.o); await settle(p, gapPrice, 'stop hit', 2 * PAPER_COST + 0.0005); continue; }
      }
      if (!m || !strategy) continue;

      const pos = p.side === 'long' ? 1 : -1;
      const heldHours = (m.bars[m.last].t - p.entry_bar_t) / HOUR_MS;
      const sig = strategy.evaluate(m.ind, m.bars, m.last, pos, cfg.allowShort);
      const timeUp = strategy.maxHoldHours > 0 && heldHours >= strategy.maxHoldHours;
      if (sig.target !== pos || timeUp) {
        const reason = timeUp ? `held ${strategy.maxHoldHours}h` : sig.reason;
        if (mode === 'live') {
          const closed = await closePositionFully(hl, db, userId, p.symbol, cfg.slippagePercent, `Autopilot exit: ${reason}`);
          log({ level: 'info', symbol: p.symbol, message: `Closed at ${closed.fillPrice}; awaiting exchange fill settlement` });
        } else {
          await settle(p, m.bars[m.last].c, reason, 2 * PAPER_COST);
        }
      }
    } catch (err) {
      log({ level: 'error', symbol: p.symbol, strategyId: p.strategy_id, message: `Could not manage position: ${err instanceof Error ? err.message : err}` });
    }
  }

  // ---- 2. risk limits ----
  const paperMids = mode === 'paper' && openRows?.length ? await hl.getAllMids?.() : null;
  const markedRows = [...open.values(), ...(openRows ?? []).filter(p => p.strategy_id === MOMENTUM_ID)];
  const unrealized = (mode === 'paper' ? markedRows : []).reduce((sum, p) => {
    const m = market.get(p.symbol);
    const price = Number(paperMids?.[p.symbol] ?? m?.bars[m.last].c ?? p.entry_price);
    return sum + (p.side === 'long' ? 1 : -1) * p.size * (price - Number(p.entry_price))
      - p.notional_usd * 2 * PAPER_COST - Number(p.funding_paid ?? 0);
  }, 0);
  const dailyRisk = mode === 'live' && hl.getDailyRisk ? await hl.getDailyRisk() : null;
  const cashFlowBaseline = Number(stateRow?.cash_flow_baseline ?? dailyRisk?.netDeposits ?? 0);
  const equity = mode === 'live' ? liveAccount!.totalValue : paperEquity + unrealized;
  const riskEquity = dailyRisk ? equity - (dailyRisk.netDeposits - cashFlowBaseline) : equity;
  const prev: RiskState | null = stateRow?.day_key
    ? { dayKey: String(stateRow.day_key), dayStartEquity: Number(stateRow.day_start_equity), peakEquity: Number(stateRow.peak_equity), haltedReason: stateRow.halted_reason ?? null }
    : null;
  const risk = checkRisk(dailyRisk ? { dayKey: new Date(now).toISOString().slice(0, 10), dayStartEquity: riskEquity - dailyRisk.pnl, peakEquity: prev?.peakEquity ?? riskEquity, haltedReason: prev?.haltedReason ?? null } : prev, riskEquity, now, cfg.risk);
  if (risk.state.haltedReason && !prev?.haltedReason) {
    log({ level: 'warn', message: `Autopilot paused: ${risk.state.haltedReason}. Open positions keep their stops; no new trades until you reset it.` });
  }

  // ---- 1b. the paper-only momentum basket ----
  if (mode === 'paper' && cfg.strategies.includes(MOMENTUM_ID)) {
    try {
      const m = await runMomentumPaper(hl, db, userId, paperEquity, now, { canOpen: risk.canOpen, maxPositions: cfg.risk.maxPositions - open.size, availableNotional: Math.max(0, equity * (cfg.portfolio?.maxGrossExposureX ?? 3) - [...open.values()].reduce((sum, p) => sum + p.notional_usd, 0)) });
      paperEquity += m.pnl;
      for (const e of m.events) log({ ...e, strategyId: MOMENTUM_ID });
    } catch (err) {
      log({ level: 'error', strategyId: MOMENTUM_ID, message: `Momentum basket failed: ${err instanceof Error ? err.message : err}` });
    }
  }

  // ---- 3. look for new entries ----
  if (risk.canOpen) {
    for (const symbol of cfg.symbols) {
      if (open.has(symbol)) continue;
      const m = market.get(symbol);
      if (!m) continue;
      if (symbol === cfg.reservedSymbol) continue; // the daily strategy owns this market
      if (mode === 'live' && exchangePositions!.has(symbol)) continue; // a position the autopilot did not open: leave it alone

      for (const id of cfg.strategies) {
        const strategy: StrategyDef | undefined = getStrategy(id);
        if (!strategy) continue;
        // Direction is decided per strategy. On paper, shorts follow the setting. With real
        // money a strategy may short only if its long-and-short version is live-eligible;
        // otherwise it falls back to long-only, if that version is eligible.
        const shortOk = cfg.allowShort && (mode === 'paper' || isLiveEligible(id, true));
        if (mode === 'live' && !isLiveEligible(id, shortOk)) continue; // paper-only strategy

        const sig = strategy.evaluate(m.ind, m.bars, m.last, 0, shortOk);
        if (sig.target === 0) continue;
        const barT = m.bars[m.last].t;
        // Only act on a fresh signal: the bar that just closed, within the last two hours.
        if (now - (barT + HOUR_MS) > 2 * HOUR_MS) continue;

        const notional = sizeNotional(equity, sig.stopPct, cfg.risk);
        const gate = canOpenPosition(open.size, notional, cfg.risk);
        if (!gate.ok) { log({ level: 'info', symbol, strategyId: id, message: `Signal skipped: ${gate.reason}` }); break; }

        const side = sig.target === 1 ? 'long' : 'short';
        try {
          // Reserve the signal bar first; the unique index makes a second scan of the same bar a no-op.
          const price = m.bars[m.last].c;
          const { data: row, error } = await db.from('autopilot_positions').insert({
            user_id: userId, mode, symbol, strategy_id: id, side, status: 'open',
            entry_price: price, size: notional / price, notional_usd: notional,
            stop_price: price * (1 - sig.target * sig.stopPct), entry_bar_t: barT, entry_reason: sig.reason,
          }).select('*').single();
          if (error) { if (error.code !== '23505') throw new Error(error.message); break; } // 23505: already acted on this bar

          let entry = price, size = notional / price, stop = price * (1 - sig.target * sig.stopPct);
          if (mode === 'live') {
            try {
              const opened = await openPosition(hl, db, {
                userId, symbol, side, sizeUsd: notional,
                leverage: Math.max(1, Math.ceil(cfg.risk.maxLeveragePerPosition)),
                slippagePercent: cfg.slippagePercent, stopLossPct: sig.stopPct * 100, takeProfitPct: null,
                source: 'autopilot', payload: { strategy: id, reason: sig.reason }, limits: cfg.portfolio,
              });
              entry = opened.fillPrice; size = opened.size; stop = opened.stopLossPx ?? stop;
              if (opened.protectionError) {
                // Never hold a live position without its stop.
                await closePositionFully(hl, db, userId, symbol, cfg.slippagePercent, 'Autopilot: stop could not be placed');
                await db.from('autopilot_positions').update({ status: 'closed', exit_price: entry, exit_time: new Date(now).toISOString(), exit_reason: 'stop could not be placed; closed immediately', pnl: -notional * 2 * 0.00045, entry_price: entry, size }).eq('id', row.id);
                log({ level: 'error', symbol, strategyId: id, message: `Opened then closed immediately: the stop-loss was rejected (${opened.protectionError})` });
                break;
              }
            } catch (err) {
              await db.from('autopilot_positions').delete().eq('id', row.id);
              throw err;
            }
          }
          await db.from('autopilot_positions').update({ entry_price: entry, size, notional_usd: size * entry, stop_price: stop }).eq('id', row.id);
          open.set(symbol, { ...row, entry_price: entry, size, notional_usd: size * entry, stop_price: stop, entry_bar_t: barT });
          log({ level: 'trade', symbol, strategyId: id, message: `Opened ${side} $${(size * entry).toFixed(0)} at ${entry.toFixed(4)}, stop ${stop.toFixed(4)} (${sig.reason})` });
        } catch (err) {
          log({ level: 'error', symbol, strategyId: id, message: `Entry failed: ${err instanceof Error ? err.message : err}` });
        }
        break; // one position per market
      }
    }
  }

  // ---- 4. persist ----
  await db.from('autopilot_state').upsert({
    user_id: userId, mode, day_key: risk.state.dayKey, day_start_equity: risk.state.dayStartEquity,
    peak_equity: risk.state.peakEquity, halted_reason: risk.state.haltedReason, paper_equity: paperEquity,
    last_run_at: new Date(now).toISOString(), cash_flow_baseline: cashFlowBaseline,
  });
  if (events.length) {
    await db.from('autopilot_events').insert(events.map(e => ({ user_id: userId, mode, level: e.level, symbol: e.symbol ?? null, strategy_id: e.strategyId ?? null, message: e.message })));
    const important = events.filter(e => e.level !== 'info');
    if (important.length) await notify(`Autopilot (${mode}):\n` + important.map(e => `${e.symbol ?? ''} ${e.message}`.trim()).join('\n'), undefined, userId);
  }

  return { mode, equity, canOpen: risk.canOpen, haltReason: risk.reason, events };
}
