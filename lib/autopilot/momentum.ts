// Cross-coin momentum, PAPER ONLY: once a week, rank a fixed basket of coins
// by their 90-day return, hold the strongest quarter long and the weakest
// quarter short in equal size (so the book is roughly market-neutral).
//
// Evidence: backtest/UNIVERSE.md. It was the one survivor of 16 similar rules,
// which could be luck, so it is not allowed to trade real money. Running it on
// paper is how that gets settled.
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
const DAY_MS = 86_400_000;

export interface Ranked { symbol: string; ret: number; price: number }

/** Strongest quarter to buy and weakest quarter to short, from each coin's lookback return. */
export function pickBasket(ranked: Ranked[]): { longs: Ranked[]; shorts: Ranked[] } {
  const sorted = [...ranked].sort((a, b) => b.ret - a.ret);
  if (sorted.length < 8) return { longs: [], shorts: [] }; // too few coins for a meaningful ranking
  const k = Math.max(2, Math.floor(sorted.length / 4));
  return { longs: sorted.slice(0, k), shorts: sorted.slice(-k) };
}

export interface MomentumEvent { level: 'info' | 'trade' | 'warn' | 'error'; symbol?: string; message: string }

/**
 * One pass of the paper momentum book. Does nothing unless a week has passed
 * since the last rebalance. Returns the realised P&L to add to paper equity.
 */
export async function runMomentumPaper(hl: HyperliquidClient, db: Db, userId: string, paperEquity: number, now = Date.now()): Promise<{ pnl: number; events: MomentumEvent[] }> {
  const events: MomentumEvent[] = [];
  const { data: legs, error } = await db.from('autopilot_positions').select('*')
    .eq('user_id', userId).eq('mode', 'paper').eq('strategy_id', MOMENTUM_ID).eq('status', 'open');
  if (error) throw new Error(error.message);

  const openLegs = legs ?? [];
  const lastRebalance = openLegs.length ? Math.max(...openLegs.map(l => new Date(l.entry_time).getTime())) : 0;
  if (openLegs.length && now - lastRebalance < MOMENTUM_HOLD_DAYS * DAY_MS) return { pnl: 0, events };

  // Rebalance day: one price history per coin.
  const ranked: Ranked[] = [];
  for (const symbol of MOMENTUM_UNIVERSE) {
    try {
      const candles = await hl.getDailyCandles(symbol, MOMENTUM_LOOKBACK_DAYS + 5);
      if (candles.length <= MOMENTUM_LOOKBACK_DAYS) continue;
      const last = candles[candles.length - 1];
      if (now - last.time > 3 * DAY_MS) continue; // stale
      const past = candles[candles.length - 1 - MOMENTUM_LOOKBACK_DAYS];
      ranked.push({ symbol, ret: last.close / past.close - 1, price: last.close });
    } catch {
      // A coin that cannot be priced simply sits out this week.
    }
  }
  const { longs, shorts } = pickBasket(ranked);
  if (longs.length === 0) {
    events.push({ level: 'warn', message: `Momentum basket skipped: only ${ranked.length} coins could be priced` });
    return { pnl: 0, events };
  }

  // Close last week's legs at today's prices.
  const priceOf = new Map(ranked.map(r => [r.symbol, r.price]));
  let pnl = 0;
  for (const leg of openLegs) {
    const exit = priceOf.get(leg.symbol) ?? Number(leg.entry_price); // unpriceable: closed flat rather than guessed
    const dir = leg.side === 'long' ? 1 : -1;
    const legPnl = Number(leg.notional_usd) * (dir * (exit / Number(leg.entry_price) - 1)) - Number(leg.notional_usd) * 2 * PAPER_COST;
    pnl += legPnl;
    await db.from('autopilot_positions').update({ status: 'closed', exit_price: exit, exit_time: new Date(now).toISOString(), exit_reason: 'weekly rebalance', pnl: legPnl }).eq('id', leg.id);
  }
  if (openLegs.length) events.push({ level: 'trade', message: `Momentum basket closed for the week: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} across ${openLegs.length} legs` });

  // Open this week's basket.
  const equity = paperEquity + pnl;
  const rebalanceDay = Math.floor(now / DAY_MS) * DAY_MS;
  const rows = [...longs.map(r => ({ r, side: 'long' as const })), ...shorts.map(r => ({ r, side: 'short' as const }))].map(({ r, side }) => {
    const notional = (equity * SIDE_ALLOCATION) / longs.length;
    return {
      user_id: userId, mode: 'paper', symbol: r.symbol, strategy_id: MOMENTUM_ID, side, status: 'open',
      entry_price: r.price, size: notional / r.price, notional_usd: notional,
      // A market-neutral basket has no per-leg stop; the column is required, so park it far away.
      stop_price: side === 'long' ? r.price * 0.01 : r.price * 100,
      entry_bar_t: rebalanceDay, entry_time: new Date(now).toISOString(),
      entry_reason: `${MOMENTUM_LOOKBACK_DAYS}-day return ${(r.ret * 100).toFixed(0)}%: ${side === 'long' ? 'among the strongest' : 'among the weakest'}`,
    };
  });
  const { error: insertError } = await db.from('autopilot_positions').insert(rows);
  if (insertError && insertError.code !== '23505') throw new Error(insertError.message); // 23505: already rebalanced today
  if (!insertError) {
    events.push({ level: 'trade', message: `Momentum basket opened: long ${longs.map(l => l.symbol).join(', ')}; short ${shorts.map(s => s.symbol).join(', ')}` });
  }
  return { pnl, events };
}
