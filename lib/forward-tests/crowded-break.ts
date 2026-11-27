// Forward test of the "crowded break" trade from backtest/DIRECTIONAL-EVENT-TRADES.md, on dates that
// did not exist when the rule was chosen. Record-only: it logs what the rule would have done and
// never places an order. The rules here are frozen copies of the study's; do not tune them.
//
//   Setup day S, 23:00 UTC:  open interest up more than 0.05 log points over five days, and the share
//                            of accounts net long is in the bottom quarter of the previous 60 days
//                            (sets up a long) or the top quarter (sets up a short).
//   Confirm day S+1:         the daily close breaks above the previous five daily highs (long) or
//                            below the previous five daily lows (short). Otherwise the setup expires.
//   Entry day S+2:           at the UTC open. Exit at a 12% adverse move or at the open seven days later.

export const STRATEGY = 'crowded_break';
export const DAY = 86_400_000;
export const HOLD_DAYS = 7;
export const STOP = 0.12;
/** Cost per side as a fraction of notional, the study's base case. */
export const FEE = 0.001;
const BUILD_UP = 0.05;
const WINDOW = 60, MIN_WINDOW = 55, BREAK_DAYS = 5;

/** The six coins the study covered. Every other coin is an extension it never saw. */
export const TESTED_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'LINK', 'LTC'] as const;
export const EXTENSION_COINS = ['ADA', 'DOGE', 'BNB', 'AVAX', 'BCH', 'ETC', 'XLM', 'TRX', 'ATOM', 'ALGO', 'DASH', 'ZEC'] as const;
export const COINS: readonly string[] = [...TESTED_COINS, ...EXTENSION_COINS];

/** One day's reading at 23:00 UTC: open interest in contracts, and accounts net long over accounts net short. */
export type Positioning = { oi: number; ratio: number };
export type DayBar = { t: number; o: number; h: number; l: number; c: number };
export type Side = 'long' | 'short';

export const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** pandas' default quantile: linear interpolation between the two nearest ranks. */
export function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p, low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

/** The setup on day `day`, from positioning alone. Null when there is none or the history is too thin to say. */
export function setupOn(history: ReadonlyMap<number, Positioning>, day: number): Side | null {
  const now = history.get(day), before = history.get(day - BREAK_DAYS * DAY);
  if (!now || !before || !(Math.log(now.oi) - Math.log(before.oi) > BUILD_UP)) return null;
  const past: number[] = [];
  for (let k = 1; k <= WINDOW; k++) { const row = history.get(day - k * DAY); if (row) past.push(Math.log(row.ratio)); }
  if (past.length < MIN_WINDOW) return null;
  const crowd = Math.log(now.ratio);
  // Few accounts long is the fuel for a break upward; many accounts long, for a break downward.
  if (crowd < quantile(past, 0.25)) return 'long';
  if (crowd > quantile(past, 0.75)) return 'short';
  return null;
}

/** Did the close of `day` break the previous five daily highs (long) or lows (short)? Needs all six bars. */
export function confirmedOn(bars: ReadonlyMap<number, DayBar>, day: number, side: Side) {
  const bar = bars.get(day);
  if (!bar) return false;
  let high = -Infinity, low = Infinity;
  for (let k = 1; k <= BREAK_DAYS; k++) {
    const prior = bars.get(day - k * DAY);
    if (!prior) return false;
    high = Math.max(high, prior.h); low = Math.min(low, prior.l);
  }
  return side === 'long' ? bar.c > high : bar.c < low;
}

/** The side to enter at the open of `entryDay`, or null. */
export function entrySignal(history: ReadonlyMap<number, Positioning>, bars: ReadonlyMap<number, DayBar>, entryDay: number): Side | null {
  const side = setupOn(history, entryDay - 2 * DAY);
  return side && confirmedOn(bars, entryDay - DAY, side) ? side : null;
}

export const stopPrice = (entry: number, side: Side) => entry * (side === 'long' ? 1 - STOP : 1 + STOP);

export type OpenTrade = { side: Side; entryDay: number; entryPrice: number; stop: number; lastDay: number };
export type Exit = { day: number; price: number; reason: 'gap_stop' | 'time' | 'intraday_stop' };

/**
 * Walks an open trade forward from the day after `lastDay` through `today`. At each day's open a gap
 * through the stop or the seventh day closes it at that open; a completed day that touched the stop
 * closes it at the stop. `today`'s bar is still forming, so only its open is used. Returns the exit,
 * or the last day fully accounted for.
 */
export function advance(trade: OpenTrade, bars: ReadonlyMap<number, DayBar>, today: number): { exit: Exit } | { lastDay: number } {
  const long = trade.side === 'long';
  let last = trade.lastDay;
  for (let day = Math.max(trade.entryDay, trade.lastDay + DAY); day <= today; day += DAY) {
    const bar = bars.get(day);
    if (!bar) break; // a missing day is retried on the next run rather than skipped over
    if (day > trade.entryDay) {
      if (long ? bar.o <= trade.stop : bar.o >= trade.stop) return { exit: { day, price: bar.o, reason: 'gap_stop' } };
      if (day - trade.entryDay >= HOLD_DAYS * DAY) return { exit: { day, price: bar.o, reason: 'time' } };
    }
    if (day === today) break;
    if (long ? bar.l <= trade.stop : bar.h >= trade.stop) return { exit: { day, price: trade.stop, reason: 'intraday_stop' } };
    last = day;
  }
  return { lastDay: last };
}

/**
 * Result of a closed trade as fractions of the entry notional: price move in the trade's direction,
 * funding paid (a long pays a positive rate, a short receives it) and the net after a fee on each side.
 */
export function tradeResult(side: Side, entryPrice: number, exitPrice: number, fundingRates: number[]) {
  const direction = side === 'long' ? 1 : -1;
  const gross = direction * (exitPrice / entryPrice - 1);
  const funding = direction * fundingRates.reduce((sum, rate) => sum + rate, 0);
  return { gross, funding, net: gross - funding - FEE * (1 + exitPrice / entryPrice) };
}

export interface ClosedTrade { symbol: string; net: number }
export interface Scoreline { closed: number; wins: number; mean: number | null; total: number; tStat: number | null }

/** Count, wins, average and summed net per trade, and the t-statistic of the average. */
export function scoreline(trades: ClosedTrade[]): Scoreline {
  const n = trades.length, total = trades.reduce((sum, t) => sum + t.net, 0), mean = n ? total / n : null;
  const spread = n > 1 ? Math.sqrt(trades.reduce((sum, t) => sum + (t.net - mean!) ** 2, 0) / (n - 1)) : 0;
  return { closed: n, wins: trades.filter(t => t.net > 0).length, mean, total, tStat: spread > 0 ? mean! / (spread / Math.sqrt(n)) : null };
}
