// Forward test of the 30-day funding carry basket from backtest/FUNDING-BASKET.md, on weeks that
// came after that study's data ended. Record-only: it works out what the basket would have held
// and earned, and never places an order. The rule is a frozen copy of the study's `carry_30d`.
//
//   Every Monday at the 00:00 UTC open, rank the coins by their average daily funding over the
//   previous 30 days. Short the quarter paying the most, go long the quarter paying the least,
//   equal weight, half the capital on each side. Hold for a week. A coin that stays in the basket
//   is not traded, so fees are paid only on what changes.
//
// One difference from the study: it used Binance funding and prices. This uses Hyperliquid's,
// because that is where the basket would actually be held.
import { DAY } from './crowded-break';

export const BASKET_STRATEGY = 'funding_basket';
export const WEEK = 7 * DAY;
export const LOOKBACK_DAYS = 30;
/** A coin needs funding prints on at least this many of the 30 days to be ranked. */
export const MIN_DAYS = 25;
export const MIN_COINS = 8;
/** Cost per side as a fraction of the notional traded, the study's base case. */
export const BASKET_FEE = 0.001;
/** The study's 16 coins. */
export const BASKET_COINS = ['AAVE', 'ADA', 'ATOM', 'AVAX', 'BCH', 'BNB', 'BTC', 'DOGE', 'ETC', 'ETH', 'LINK', 'LTC', 'SOL', 'TRX', 'XLM', 'XRP'] as const;
/** The first Monday after the study's data ended on 2026-10-31. */
export const BASKET_START = Date.UTC(2026, 10, 2);
export type FundingPrint = { time: number; rate: number };
/** One UTC day of funding for a coin: the sum of that day's hourly rates and how many there were. */
export type FundingDay = { day: number; sum: number; prints: number };

/** Hourly prints grouped into every UTC day from `from` up to but not including `to`. A day with no prints is kept, with zero. */
export function dailyFunding(prints: FundingPrint[], from: number, to: number): FundingDay[] {
  const days = new Map<number, FundingDay>();
  for (let day = from; day < to; day += DAY) days.set(day, { day, sum: 0, prints: 0 });
  for (const print of prints) {
    const row = days.get(Math.floor(print.time / DAY) * DAY);
    if (!row || !Number.isFinite(print.rate)) continue;
    row.sum += print.rate; row.prints += 1;
  }
  return [...days.values()];
}

/** Average daily funding over the 30 days before `monday`, counting only days that had prints. */
export function rankingRate(days: FundingDay[], monday: number) {
  const used = days.filter(row => row.day >= monday - LOOKBACK_DAYS * DAY && row.day < monday && row.prints > 0);
  return { mean: used.length ? used.reduce((sum, row) => sum + row.sum, 0) / used.length : null, days: used.length };
}

/**
 * Funding over the week held from the Monday before `monday`: the seven daily sums. Null unless all
 * seven days have prints. A print is stamped just after the hour it settles, so this counts the one
 * at the entry instant and misses the one at the exit instant: one hour in 168 swapped for another.
 */
export function weekFunding(days: FundingDay[], monday: number) {
  const held = days.filter(row => row.day >= monday - WEEK && row.day < monday && row.prints > 0);
  return held.length === 7 ? held.reduce((sum, row) => sum + row.sum, 0) : null;
}

export interface Basket { longs: string[]; shorts: string[] }

/** Short the quarter with the highest average funding, long the quarter with the lowest. Null with too few coins. */
export function pickBasket(ranking: Array<{ symbol: string; mean: number }>): Basket | null {
  if (ranking.length < MIN_COINS) return null;
  const sorted = [...ranking].sort((a, b) => b.mean - a.mean || a.symbol.localeCompare(b.symbol));
  const size = Math.max(2, Math.floor(sorted.length / 4));
  return { shorts: sorted.slice(0, size).map(row => row.symbol), longs: sorted.slice(-size).map(row => row.symbol).reverse() };
}

/** Signed weights: half the capital a side, split equally. */
export function weights(basket: Basket | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!basket) return out;
  for (const symbol of basket.longs) out.set(symbol, 0.5 / basket.longs.length);
  for (const symbol of basket.shorts) out.set(symbol, -0.5 / basket.shorts.length);
  return out;
}

/** The fee for moving from one basket to the next: charged on the weight that changes hands. */
export function rebalanceCost(previous: Basket | null, next: Basket | null) {
  const before = weights(previous), after = weights(next);
  let traded = 0;
  for (const symbol of new Set([...before.keys(), ...after.keys()])) traded += Math.abs((after.get(symbol) ?? 0) - (before.get(symbol) ?? 0));
  return { traded, cost: traded * BASKET_FEE };
}

/**
 * One held week as fractions of capital: the price result of both sides, and funding (a short
 * receives a positive rate, a long pays it). Null if any leg has no price at either end.
 */
export function weekResult(basket: Basket, entry: Record<string, number>, exit: Record<string, number>, funding: Record<string, number>) {
  let price = 0, carried = 0;
  for (const [symbol, weight] of weights(basket)) {
    const from = entry[symbol], to = exit[symbol], rate = funding[symbol];
    if (!(from > 0) || !(to > 0) || !Number.isFinite(rate)) return null;
    price += weight * (to / from - 1);
    carried -= weight * rate;
  }
  return { price, funding: carried };
}

/** What one Monday's log row holds. */
export interface BasketWeek {
  basket: Basket | null;
  /** Opening price of every ranked coin that Monday. */
  prices: Record<string, number>;
  /** The 30-day average daily funding each coin was ranked on. */
  rates: Record<string, number>;
  /** The result of the week that ended this Monday, when a basket was held through it. */
  week: { price: number; funding: number } | null;
  traded: number;
  cost: number;
  note?: string;
}

export interface BasketSummary {
  weeks: number;
  price: number; funding: number; costs: number; net: number;
  /** Weeks whose net (price + funding, less the fee paid to set that week's basket) was positive. */
  positive: number;
  tStat: number | null;
}

/** Totals over the logged Mondays, oldest first. Each held week carries the fee paid to enter it. */
export function summariseBasket(rows: BasketWeek[]): BasketSummary {
  const nets: number[] = [];
  let price = 0, funding = 0, costs = 0;
  rows.forEach((row, i) => {
    costs += row.cost;
    if (!row.week) return;
    price += row.week.price; funding += row.week.funding;
    nets.push(row.week.price + row.week.funding - (rows[i - 1]?.cost ?? 0));
  });
  const n = nets.length, mean = n ? nets.reduce((a, b) => a + b, 0) / n : 0;
  const spread = n > 1 ? Math.sqrt(nets.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { weeks: n, price, funding, costs, net: price + funding - costs, positive: nets.filter(v => v > 0).length, tStat: spread > 0 ? mean / (spread / Math.sqrt(n)) : null };
}
