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

/** The slower chart a trade on each timeframe is usually read against. */
export const HIGHER: Record<Timeframe, Timeframe | null> = { '15m': '1h', '1h': '4h', '4h': '1d', '1d': null };

export type Trend = 'up' | 'down';

/** Which side of its 50-bar average the last close is on. Null with too little history to say. */
export function trendOf(bars: Bar[]): Trend | null {
  if (bars.length < 60) return null;
  const k = 2 / 51;
  let ema = bars[0].c;
  for (let i = 1; i < bars.length; i++) ema = bars[i].c * k + ema * (1 - k);
  return bars[bars.length - 1].c >= ema ? 'up' : 'down';
}

export interface TicketFrame {
  levels: TimeframeLevels;
  /** Nearest levels from the next slower chart, drawn on this one so a target is not set into them unseen. */
  higher: { timeframe: Timeframe; supports: Level[]; resistances: Level[] } | null;
  /** Trend on every timeframe, for the agreement check. */
  trends: Record<Timeframe, Trend | null>;
}

/** Everything the ticket shows for one timeframe, from candles of all four. */
export function buildTicketFrame(series: Record<Timeframe, Bar[]>, timeframe: Timeframe, price: number): TicketFrame {
  const up = HIGHER[timeframe];
  let higher: TicketFrame['higher'] = null;
  if (up && series[up].length >= 30) {
    const h = buildTimeframeLevels(up, series[up], price);
    higher = { timeframe: up, supports: h.supports.slice(0, 2), resistances: h.resistances.slice(0, 2) };
  }
  const trends = {} as TicketFrame['trends'];
  for (const tf of Object.keys(TIMEFRAMES) as Timeframe[]) trends[tf] = trendOf(series[tf]);
  return { levels: buildTimeframeLevels(timeframe, series[timeframe], price), higher, trends };
}

export interface FrameWarning { kind: 'trend' | 'target'; message: string }

/**
 * What the slower charts say against this trade: a trend the trade fights, and
 * a slower-chart level sitting between the entry and the target.
 */
export function frameWarnings(frame: Pick<TicketFrame, 'higher' | 'trends'>, timeframe: Timeframe, side: 'long' | 'short', entry: number, targetPrice: number | null): FrameWarning[] {
  const out: FrameWarning[] = [];
  const order = Object.keys(TIMEFRAMES) as Timeframe[];
  const against = side === 'long' ? 'down' : 'up';
  const slower = order.slice(order.indexOf(timeframe) + 1).filter(tf => frame.trends[tf] === against);
  if (slower.length) {
    out.push({ kind: 'trend', message: `This ${side} goes against the ${slower.map(tf => TIMEFRAMES[tf].label.toLowerCase()).join(' and ')} trend (${against}). Trades against the slower trend are the ones a tight stop most often loses to.` });
  }
  if (frame.higher && targetPrice != null) {
    const blocks = (side === 'long' ? frame.higher.resistances : frame.higher.supports)
      .filter(l => (side === 'long' ? l.price > entry && l.price < targetPrice : l.price < entry && l.price > targetPrice))
      .sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (blocks) {
      const name = TIMEFRAMES[frame.higher.timeframe].label.toLowerCase();
      out.push({ kind: 'target', message: `The target is beyond ${name} ${side === 'long' ? 'resistance' : 'support'} at ${Number(blocks.price.toPrecision(5)).toLocaleString('en-US')} (${blocks.touches} touch${blocks.touches === 1 ? '' : 'es'}). Price often stalls there first.` });
    }
  }
  return out;
}

/** Sensible starting values for the rest of the ticket on each timeframe. Only applied to fields the user has not set. */
export const TICKET_DEFAULTS: Record<Timeframe, { chaseSeconds: number; expiryHours: number; suits: string }> = {
  '15m': { chaseSeconds: 30, expiryHours: 4, suits: 'a quick entry (chase, 30 seconds) and a single target' },
  '1h': { chaseSeconds: 60, expiryHours: 24, suits: 'a chase or a limit at a nearby level' },
  '4h': { chaseSeconds: 120, expiryHours: 72, suits: 'a limit entry at a level, a split target and break-even after target 1' },
  '1d': { chaseSeconds: 120, expiryHours: 168, suits: 'a limit entry at a level and a trailing stop' },
};
