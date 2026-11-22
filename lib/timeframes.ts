// Stops, targets and levels for a trade horizon other than the default.
//
// The direction read (long / short / no trade) always comes from the tested
// rules, which work on hourly and 4-hour candles. What changes with the
// timeframe is the yardstick for protection: support and resistance are found
// on that timeframe's candles and the stop is sized from that timeframe's
// volatility. A 15-minute trade gets a tight stop near recent 15-minute
// turning points; a daily trade gets a wide one beyond levels that held for
// weeks.
//
// None of this has been shown to make money: the hourly version was replayed
// over history and had no edge (backtest/SUGGESTIONS.md), and the other
// timeframes have not been replayed at all. It places the stop somewhere that
// suits the holding period; it does not predict anything.
import type { Bar } from '@/lib/autopilot/strategies';
import { findLevels, type Level } from '@/lib/levels';
import { protectionLevels, type Levels } from '@/lib/suggestions';

export const TIMEFRAMES = {
  '15m': { label: '15 min', interval: '15m', ms: 900_000, hold: 'minutes to a few hours', span: 'about a week' },
  '1h': { label: '1 hour', interval: '1h', ms: 3_600_000, hold: 'hours to a few days', span: '30 days' },
  '4h': { label: '4 hour', interval: '4h', ms: 14_400_000, hold: 'days to a couple of weeks', span: 'about 4 months' },
  '1d': { label: 'Daily', interval: '1d', ms: 86_400_000, hold: 'weeks', span: 'up to 2 years' },
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export const isTimeframe = (v: unknown): v is Timeframe => typeof v === 'string' && v in TIMEFRAMES;

/** Candles loaded per timeframe: enough for levels to form (720 where the exchange has them). */
export const BARS_FOR_LEVELS = 720;
/** Bars in the volatility average: the same 24 the hourly rules use. */
const ATR_BARS = 24;

export interface TimeframeLevels {
  timeframe: Timeframe;
  long: Levels; short: Levels;
  supports: Level[]; resistances: Level[];
  /** Average true range of one bar on this timeframe, percent of price. */
  atrPct: number;
  /** Bars the levels were built from. Fewer than ~100 means the market is new and the levels are thin. */
  bars: number;
}

/** Average true range of the last `n` bars as a fraction of price. */
export function atrFraction(bars: Bar[], n = ATR_BARS): number {
  const from = Math.max(1, bars.length - n);
  let sum = 0, count = 0;
  for (let i = from; i < bars.length; i++) {
    const b = bars[i], prev = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev)) / b.c; count += 1;
  }
  return count ? sum / count : 0.01;
}

/** `bars` are completed candles of the chosen timeframe, oldest first. */
export function buildTimeframeLevels(timeframe: Timeframe, bars: Bar[], price: number): TimeframeLevels {
  const atr = atrFraction(bars);
  // Same construction as the hourly suggestion: levels from turning points, stop 2.5 bars of range unless a level is usable.
  const sr = findLevels(bars, 0.5 * atr, BARS_FOR_LEVELS);
  return {
    timeframe,
    long: protectionLevels(price, 1, 2.5 * atr, atr, sr),
    short: protectionLevels(price, -1, 2.5 * atr, atr, sr),
    supports: sr.filter(l => l.price < price).sort((a, b) => b.price - a.price).slice(0, 3),
    resistances: sr.filter(l => l.price > price).sort((a, b) => a.price - b.price).slice(0, 3),
    atrPct: Math.round(atr * 10_000) / 100,
    bars: bars.length,
  };
}
