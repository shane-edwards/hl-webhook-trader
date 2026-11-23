// Cross-coin momentum: once a week, rank a fixed basket of coins
// by their 90-day return, hold the strongest quarter long and the weakest
// quarter short in equal size (so the book is roughly market-neutral).
//
// Evidence: backtest/UNIVERSE.md. The historical replay did not model protective stops.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const MOMENTUM_ID = 'xs_momentum_90';
export const MOMENTUM_LOOKBACK_DAYS = 90;
export const MOMENTUM_HOLD_DAYS = 7;
/** The mid-2020 large-cap basket from the study, limited to coins Hyperliquid lists. */
export const MOMENTUM_UNIVERSE = ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'BNB', 'XLM', 'ADA', 'TRX', 'LINK', 'ATOM', 'ETC', 'DOGE', 'DASH', 'ZEC', 'NEO', 'IOTA', 'ALGO', 'SOL'];
/** Share of paper equity on each side of the book. */
const SIDE_ALLOCATION = 0.5;
const PAPER_COST = 0.00065;
export const DAY_MS = 86_400_000;
export const MOMENTUM_STOP_PCT = 15;

export interface Ranked { symbol: string; ret: number; price: number }

/** Strongest quarter to buy and weakest quarter to short, from each coin's lookback return. */
export function pickBasket(ranked: Ranked[]): { longs: Ranked[]; shorts: Ranked[] } {
  const sorted = [...ranked].sort((a, b) => b.ret - a.ret);
  if (sorted.length < 8) return { longs: [], shorts: [] }; // too few coins for a meaningful ranking
  const k = Math.max(2, Math.floor(sorted.length / 4));
  return { longs: sorted.slice(0, k), shorts: sorted.slice(-k) };
}

export interface MomentumEvent { level: 'info' | 'trade' | 'warn' | 'error'; symbol?: string; message: string }

export async function rankMomentum(hl: HyperliquidClient, now: number) {
  const ranked: Ranked[] = [];
  // Bound concurrent broker requests while keeping the scanner within its deadline.
  for (let start = 0; start < MOMENTUM_UNIVERSE.length; start += 4) {
    const batch = await Promise.allSettled(MOMENTUM_UNIVERSE.slice(start, start + 4).map(async symbol => {
      const candles = await hl.getDailyCandles(symbol, MOMENTUM_LOOKBACK_DAYS + 5);
      const last = candles.at(-1);
      const past = candles.at(-1 - MOMENTUM_LOOKBACK_DAYS);
      if (!last || !past || now - last.time > 3 * DAY_MS || now - last.time < DAY_MS || !(past.close > 0) || !(last.close > 0)) return null;
      return { symbol, ret: last.close / past.close - 1, price: last.close };
    }));
    for (const result of batch) {
      if (result.status === 'fulfilled' && result.value) ranked.push(result.value);
    }
  }
  return ranked;
}

export function momentumOrderPlan(ranked: Ranked[], equity: number, availableNotional: number, freeSlots: number) {
  const { longs, shorts } = pickBasket(ranked);
  const pairs = Math.min(longs.length, Math.floor(freeSlots / 2));
  if (pairs < 2) return [];
  const budget = Math.min(equity, availableNotional);
  const notional = budget * SIDE_ALLOCATION / pairs;
  if (!Number.isFinite(notional) || notional < 10) return [];
  return Array.from({ length: pairs }, (_, i) => ([
    { ...longs[i], side: 'long' as const, notional },
    { ...shorts.at(-1 - i)!, side: 'short' as const, notional },
  ])).flat();
}

export function momentumPlanKey(plan: { symbol: string; side: 'long' | 'short' }[]) {
  return plan.map(leg => `${leg.side}:${leg.symbol}`).join(',');
}

/**
 * One pass of the paper momentum book. Does nothing unless a week has passed
 * since the last rebalance. Returns the realised P&L to add to paper equity.
 */
export async function runMomentumPaper(hl: HyperliquidClient, db: Db, userId: string, paperEquity: number, now = Date.now(), limits?: { canOpen: boolean; maxPositions: number; availableNotional: number; occupied?: Set<string>; manualPlan?: string }): Promise<{ pnl: number; events: MomentumEvent[]; opened?: boolean }> {
  const events: MomentumEvent[] = [];
  const { data: legs, error } = await db.from('autopilot_positions').select('*')
    .eq('user_id', userId).eq('mode', 'paper').eq('strategy_id', MOMENTUM_ID).eq('status', 'open');
  if (error) throw new Error(error.message);

  const openLegs = legs ?? [];
  if (limits?.manualPlan && openLegs.length) return { pnl: 0, events };
  const lastRebalance = openLegs.length ? Math.max(...openLegs.map(l => new Date(l.entry_time).getTime())) : 0;
  const stopped = new Map<string, number>();
  if (openLegs.length && hl.getHourlyCandles) {
    const lookback = Math.min(5000, Math.ceil((now - lastRebalance) / 3_600_000) + 1);
    const bars = await Promise.all(openLegs.map(leg => hl.getHourlyCandles(leg.symbol, lookback)));
    for (const [index, leg] of openLegs.entries()) {
      const long = leg.side === 'long';
      const stop = Number(leg.stop_price);
      const hit = bars[index].find(b => b.t >= Date.parse(leg.entry_time) && (long ? b.l <= stop : b.h >= stop));
      if (hit) stopped.set(leg.symbol, long ? Math.min(stop, hit.o) : Math.max(stop, hit.o));
    }
  }
  if (openLegs.length && !stopped.size && now - lastRebalance < MOMENTUM_HOLD_DAYS * DAY_MS) return { pnl: 0, events };
  if (!openLegs.length && limits && !limits.canOpen) return { pnl: 0, events };

  const ranked = await rankMomentum(hl, now);
  const priceOf = new Map(ranked.map(r => [r.symbol, r.price]));
  if (hl.getAllMids && (stopped.size || openLegs.some(l => !priceOf.has(l.symbol)))) {
    for (const [symbol, value] of Object.entries(await hl.getAllMids())) {
      if (Number(value) > 0) priceOf.set(symbol, Number(value));
    }
  }
  if (openLegs.some(leg => !priceOf.has(leg.symbol))) throw new Error('Prices are unavailable for one or more momentum positions');
  let pnl = 0;
  for (const leg of openLegs) {
    const exit = stopped.get(leg.symbol) ?? priceOf.get(leg.symbol)!;
    const dir = leg.side === 'long' ? 1 : -1;
    const legPnl = Number(leg.notional_usd) * (dir * (exit / Number(leg.entry_price) - 1)) - Number(leg.notional_usd) * PAPER_COST * (1 + exit / Number(leg.entry_price)) - Number(leg.funding_paid ?? 0);
    pnl += legPnl;
    const saved = await db.from('autopilot_positions').update({ status: 'closed', exit_price: exit, exit_time: new Date(now).toISOString(), exit_reason: stopped.size ? 'basket stop' : 'weekly rebalance', pnl: legPnl }).eq('id', leg.id);
    if (saved.error) throw new Error(saved.error.message);
  }
  if (openLegs.length) events.push({ level: 'trade', message: `Momentum basket closed for the week: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} across ${openLegs.length} legs` });

  if (stopped.size || (limits && !limits.canOpen)) return { pnl, events };
  if (!openLegs.length) {
    const previous = await db.from('autopilot_positions').select('entry_time, exit_reason')
      .eq('user_id', userId).eq('mode', 'paper').eq('strategy_id', MOMENTUM_ID).eq('status', 'closed');
    if (previous.error) throw new Error(previous.error.message);
    if ((previous.data ?? []).some(row => row.exit_reason === 'basket stop' && now - Date.parse(row.entry_time) < MOMENTUM_HOLD_DAYS * DAY_MS)) return { pnl, events };
  }
  const plan = momentumOrderPlan(ranked, paperEquity + pnl, limits?.availableNotional ?? Infinity, limits?.maxPositions ?? Infinity);
  if (limits?.manualPlan && momentumPlanKey(plan) !== limits.manualPlan) return { pnl, events };
  if (!plan.length || plan.some(leg => limits?.occupied?.has(leg.symbol))) {
    events.push({ level: 'info', message: 'Basket entry needs at least four available positions and all selected markets free' });
    return { pnl, events };
  }
  const rebalanceDay = Math.floor(now / DAY_MS) * DAY_MS;
  const rows = plan.map(({ symbol, price, ret, side, notional }) => {
    return {
      user_id: userId, mode: 'paper', symbol, strategy_id: MOMENTUM_ID, side, status: 'open',
      entry_price: price, size: notional / price, notional_usd: notional,
      stop_price: price * (1 + (side === 'long' ? -1 : 1) * MOMENTUM_STOP_PCT / 100),
      entry_bar_t: rebalanceDay, entry_time: new Date(now).toISOString(),
      entry_reason: `${MOMENTUM_LOOKBACK_DAYS}-day return ${(ret * 100).toFixed(0)}%`,
    };
  });
  const { error: insertError } = await db.from('autopilot_positions').insert(rows);
  if (insertError && insertError.code !== '23505') throw new Error(insertError.message); // 23505: already rebalanced today
  if (!insertError) {
    events.push({ level: 'trade', message: `Momentum basket opened across ${rows.length} positions` });
  }
  return { pnl, events, opened: !insertError };
}
