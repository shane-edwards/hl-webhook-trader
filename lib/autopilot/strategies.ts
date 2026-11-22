// Autopilot strategy library. Pure functions over hourly bars, shared by the
// backtest (backtest/autopilot.ts) and the live scanner (lib/autopilot/run.ts)
// so that what is tested is exactly what trades.

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export interface Indicators {
  close: number[];
  emaSlow: number[]; // 30-day (720h) average: the trend regime
  rsi: number[];
  atrPct: number[]; // 24h average true range as a fraction of price
  high48: number[]; low48: number[]; high24: number[]; low24: number[];
}

export interface Signal {
  /** Desired position after seeing bar i: +1 long, -1 short, 0 flat. */
  target: -1 | 0 | 1;
  /** Stop distance from entry as a fraction of price (used when opening). */
  stopPct: number;
  /** Why, in plain words, for the decision log. */
  reason: string;
}

export interface StrategyDef {
  id: string;
  name: string;
  style: 'Pullback' | 'Breakout' | 'Momentum burst';
  description: string;
  /** Typical holding period, for the UI. */
  horizon: string;
  /** Hours a position may be held before it is closed regardless (0 = no limit). */
  maxHoldHours: number;
  evaluate(ind: Indicators, bars: Bar[], i: number, pos: -1 | 0 | 1, allowShort: boolean): Signal;
}

/** Bars needed before any signal is valid. */
export const WARMUP_BARS = 740;

function ema(x: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out = [x[0]];
  for (let i = 1; i < x.length; i++) out.push(x[i] * k + out[i - 1] * (1 - k));
  return out;
}

function rsi(c: number[], n: number): number[] {
  const out = new Array(c.length).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/** Rolling extreme over the n bars ending at i (inclusive), O(n) per bar which is fine at these sizes. */
function rolling(x: number[], n: number, pick: (a: number, b: number) => number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let v = x[i];
    for (let j = i - n + 1; j < i; j++) v = pick(v, x[j]);
    out[i] = v;
  }
  return out;
}

export function computeIndicators(bars: Bar[]): Indicators {
  const close = bars.map(b => b.c);
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))) / b.c);
  const atrPct = new Array(bars.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += tr[i];
    if (i >= 24) sum -= tr[i - 24];
    if (i >= 23) atrPct[i] = sum / 24;
  }
  const highs = bars.map(b => b.h), lows = bars.map(b => b.l);
  return {
    close, emaSlow: ema(close, 720), rsi: rsi(close, 14), atrPct,
    high48: rolling(highs, 48, Math.max), low48: rolling(lows, 48, Math.min),
    high24: rolling(highs, 24, Math.max), low24: rolling(lows, 24, Math.min),
  };
}

const clampStop = (x: number) => Math.min(0.15, Math.max(0.004, x));
const flat = (reason: string): Signal => ({ target: 0, stopPct: 0, reason });

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'trend_pullback',
    name: 'Trend pullback',
    style: 'Pullback',
    horizon: 'Hours to a few days',
    maxHoldHours: 0,
    description: 'In an uptrend (price above its 30-day average), buy a dip when hourly RSI falls below 35 and exit when it recovers above 60. Mirrored for shorts in a downtrend.',
    evaluate(ind, _bars, i, pos, allowShort) {
      const up = ind.close[i] > ind.emaSlow[i];
      const stopPct = clampStop(2.5 * ind.atrPct[i]);
      if (pos === 1) return up && ind.rsi[i] < 60 ? { target: 1, stopPct, reason: 'holding the dip-buy' } : flat(up ? 'RSI recovered above 60' : 'trend turned down');
      if (pos === -1) return !up && ind.rsi[i] > 40 ? { target: -1, stopPct, reason: 'holding the rally-short' } : flat(!up ? 'RSI fell below 40' : 'trend turned up');
      if (up && ind.rsi[i] < 35) return { target: 1, stopPct, reason: `uptrend dip: RSI ${ind.rsi[i].toFixed(0)}` };
      if (allowShort && !up && ind.rsi[i] > 65) return { target: -1, stopPct, reason: `downtrend rally: RSI ${ind.rsi[i].toFixed(0)}` };
      return flat('no setup');
    },
  },
  {
    id: 'trend_breakout',
    name: 'Trend breakout',
    style: 'Breakout',
    horizon: 'One to several days',
    maxHoldHours: 0,
    description: 'In an uptrend, buy when price closes above the highest high of the previous 48 hours; exit when it closes below the lowest low of the previous 24 hours. Mirrored for shorts in a downtrend.',
    evaluate(ind, _bars, i, pos, allowShort) {
      const up = ind.close[i] > ind.emaSlow[i];
      const stopPct = clampStop(2.5 * ind.atrPct[i]);
      const c = ind.close[i];
      if (pos === 1) return c < ind.low24[i - 1] ? flat('closed below the 24h low') : { target: 1, stopPct, reason: 'holding the breakout' };
      if (pos === -1) return c > ind.high24[i - 1] ? flat('closed above the 24h high') : { target: -1, stopPct, reason: 'holding the breakdown' };
      if (up && c > ind.high48[i - 1]) return { target: 1, stopPct, reason: 'uptrend: new 48h high' };
      if (allowShort && !up && c < ind.low48[i - 1]) return { target: -1, stopPct, reason: 'downtrend: new 48h low' };
      return flat('no setup');
    },
  },
  {
    id: 'momentum_burst',
    name: 'Momentum burst',
    style: 'Momentum burst',
    horizon: 'Up to 6 hours',
    maxHoldHours: 6,
    description: 'The shortest-term rule: when one hour moves more than twice its normal range and closes near its extreme, in the direction of the 30-day trend, follow it for up to six hours with a tight stop.',
    evaluate(ind, bars, i, pos, allowShort) {
      const b = bars[i];
      const up = ind.close[i] > ind.emaSlow[i];
      const stopPct = clampStop(1.5 * ind.atrPct[i]);
      if (pos !== 0) return { target: pos, stopPct, reason: 'holding the burst (time-limited)' };
      const range = (b.h - b.l) / b.c;
      if (!(range > 2 * ind.atrPct[i - 1]) || b.h === b.l) return flat('no setup');
      const where = (b.c - b.l) / (b.h - b.l); // 1 = closed at the high
      if (up && b.c > b.o && where > 0.75) return { target: 1, stopPct, reason: 'strong up-hour in an uptrend' };
      if (allowShort && !up && b.c < b.o && where < 0.25) return { target: -1, stopPct, reason: 'strong down-hour in a downtrend' };
      return flat('no setup');
    },
  },
];

export function getStrategy(id: string): StrategyDef | undefined {
  return STRATEGIES.find(s => s.id === id);
}
