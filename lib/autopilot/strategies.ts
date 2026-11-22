// Autopilot strategy library. Pure functions over hourly bars, shared by the
// backtest (backtest/autopilot.ts) and the live scanner (lib/autopilot/run.ts)
// so that what is tested is exactly what trades.

/** `v` is volume in coins; only the volume rules need it. */
export interface Bar { t: number; o: number; h: number; l: number; c: number; v?: number }

export interface Indicators {
  close: number[];
  emaSlow: number[]; // 30-day (720h) average: the trend regime
  rsi: number[];
  atrPct: number[]; // 24h average true range as a fraction of price
  high48: number[]; low48: number[]; high24: number[]; low24: number[];
  /** Four-hour view, indexed by hourly bar: values of the most recent COMPLETED 4h bar. */
  h4: {
    /** True on the hourly bar that completes a 4h bar (the only moment 4h rules may act). */
    fresh: boolean[];
    close: number[]; ema200: number[];
    macd: number[]; signal: number[]; macdPrev: number[]; signalPrev: number[];
  };
  /** Daily view (UTC days), indexed by hourly bar: values of the most recent COMPLETED day. */
  d: {
    /** True on the hourly bar that completes a UTC day (the only moment daily rules may act). */
    fresh: boolean[];
    close: number[]; volume: number[];
    /** Average volume of the 20 days before that day. */
    volAvg20: number[];
    /** Highest high / lowest low of the 20 and 10 days before that day. */
    high20: number[]; low20: number[]; high10: number[]; low10: number[];
  };
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
  style: 'Pullback' | 'Breakout' | 'Momentum burst' | 'Trend (4h)' | 'Breakout (daily)';
  description: string;
  /** Typical holding period, for the UI. */
  horizon: string;
  /** Hours a position may be held before it is closed regardless (0 = no limit). */
  maxHoldHours: number;
  /**
   * Held to paper trading even if its backtest passes the gate. Set for rules that were
   * chosen AFTER looking at the most recent data: their backtest is no longer an independent test.
   */
  paperOnly?: boolean;
  evaluate(ind: Indicators, bars: Bar[], i: number, pos: -1 | 0 | 1, allowShort: boolean): Signal;
}

/** Hourly bars needed before any signal is valid: 100 days, so the 200-period average on 4h bars has settled. */
export const WARMUP_BARS = 2400;

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

  // Build completed 4h bars (UTC-aligned, all four hours present) and map each hourly bar to the latest one.
  const H4 = 4 * 3_600_000;
  const c4: number[] = [], endIdx: number[] = [];
  for (let i = 3; i < bars.length; i++) {
    if ((bars[i].t + 3_600_000) % H4 === 0 && bars[i - 3].t === bars[i].t - 3 * 3_600_000) { c4.push(bars[i].c); endIdx.push(i); }
  }
  const e12 = c4.length ? ema(c4, 12) : [], e26 = c4.length ? ema(c4, 26) : [], e200 = c4.length ? ema(c4, 200) : [];
  const macdLine = e12.map((v, k) => v - e26[k]), sigLine = macdLine.length ? ema(macdLine, 9) : [];
  const nan = () => new Array(bars.length).fill(NaN);
  const h4 = { fresh: new Array(bars.length).fill(false), close: nan(), ema200: nan(), macd: nan(), signal: nan(), macdPrev: nan(), signalPrev: nan() };
  let k = -1;
  for (let i = 0; i < bars.length; i++) {
    if (k + 1 < endIdx.length && endIdx[k + 1] === i) { k += 1; h4.fresh[i] = true; }
    if (k >= 1) {
      h4.close[i] = c4[k]; h4.ema200[i] = e200[k];
      h4.macd[i] = macdLine[k]; h4.signal[i] = sigLine[k]; h4.macdPrev[i] = macdLine[k - 1]; h4.signalPrev[i] = sigLine[k - 1];
    }
  }

  // Completed UTC days (all 24 hours present), mapped to hourly bars the same way.
  const DAY = 24 * 3_600_000;
  const dC: number[] = [], dH: number[] = [], dL: number[] = [], dV: number[] = [], dEnd: number[] = [];
  for (let i = 23; i < bars.length; i++) {
    if ((bars[i].t + 3_600_000) % DAY !== 0 || bars[i - 23].t !== bars[i].t - 23 * 3_600_000) continue;
    let hi = -Infinity, lo = Infinity, vol = 0;
    for (let j = i - 23; j <= i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); vol += bars[j].v ?? 0; }
    dC.push(bars[i].c); dH.push(hi); dL.push(lo); dV.push(vol); dEnd.push(i);
  }
  /** Extreme / mean of the n days BEFORE day k (excludes day k). */
  const priorDays = (x: number[], k: number, n: number, f: (a: number, b: number) => number) => (k < n ? NaN : x.slice(k - n, k).reduce(f));
  const d = { fresh: new Array(bars.length).fill(false), close: nan(), volume: nan(), volAvg20: nan(), high20: nan(), low20: nan(), high10: nan(), low10: nan() };
  let q = -1;
  for (let i = 0; i < bars.length; i++) {
    if (q + 1 < dEnd.length && dEnd[q + 1] === i) { q += 1; d.fresh[i] = true; }
    if (q >= 20) {
      d.close[i] = dC[q]; d.volume[i] = dV[q];
      d.volAvg20[i] = priorDays(dV, q, 20, (a, b) => a + b) / 20;
      d.high20[i] = priorDays(dH, q, 20, (a, b) => Math.max(a, b)); d.low20[i] = priorDays(dL, q, 20, (a, b) => Math.min(a, b));
      d.high10[i] = priorDays(dH, q, 10, (a, b) => Math.max(a, b)); d.low10[i] = priorDays(dL, q, 10, (a, b) => Math.min(a, b));
    }
  }

  return {
    h4, d,
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
  {
    id: 'macd_trend',
    name: 'MACD trend (4-hour)',
    style: 'Trend (4h)',
    horizon: 'Days',
    maxHoldHours: 0,
    paperOnly: true,
    description: 'On 4-hour bars: buy when MACD(12, 26, 9) crosses above its signal line while price is above the 200-period average; sell short on the opposite cross below it. Exit when MACD crosses back. From TradingView-style indicator tests, where the long-and-short version was the only one of 26 to stay profitable in 2025-2026.',
    evaluate(ind, _bars, i, pos, allowShort) {
      const h = ind.h4;
      const stopPct = clampStop(4 * ind.atrPct[i]); // wide safety stop; the rule itself exits on the MACD cross
      // Only the hourly bar that completes a 4h bar may change anything.
      if (!h.fresh[i] || !Number.isFinite(h.macdPrev[i])) return pos === 0 ? flat('waiting for the 4h close') : { target: pos, stopPct, reason: 'holding' };
      const above = h.macd[i] > h.signal[i], wasAbove = h.macdPrev[i] > h.signalPrev[i];
      if (pos === 1) return above ? { target: 1, stopPct, reason: 'holding the MACD long' } : flat('MACD crossed down');
      if (pos === -1) return !above ? { target: -1, stopPct, reason: 'holding the MACD short' } : flat('MACD crossed up');
      if (above && !wasAbove && h.close[i] > h.ema200[i]) return { target: 1, stopPct, reason: 'MACD crossed up above the 200 average' };
      if (allowShort && !above && wasAbove && h.close[i] < h.ema200[i]) return { target: -1, stopPct, reason: 'MACD crossed down below the 200 average' };
      return flat('no setup');
    },
  },
  {
    id: 'volume_breakout',
    name: 'Volume breakout (daily)',
    style: 'Breakout (daily)',
    horizon: 'Days to weeks',
    maxHoldHours: 0,
    paperOnly: true,
    description: 'On daily bars: buy when the day closes above the highest high of the previous 20 days on volume more than 1.5 times its 20-day average; sell short on the mirror-image break of the 20-day low. Exit when a day closes beyond the opposite 10-day extreme. Of the volume rules tested it was the one still profitable in 2025-2026 when allowed to short, which may be luck, so it is on paper only.',
    evaluate(ind, _bars, i, pos, allowShort) {
      const d = ind.d;
      // Only the hourly bar that completes a UTC day may change anything.
      if (!d.fresh[i] || !Number.isFinite(d.high20[i])) return pos === 0 ? flat('waiting for the daily close') : { target: pos, stopPct: 0.05, reason: 'holding' };
      const c = d.close[i];
      if (pos === 1) return c < d.low10[i] ? flat('closed below the 10-day low') : { target: 1, stopPct: 0.05, reason: 'holding the breakout' };
      if (pos === -1) return c > d.high10[i] ? flat('closed above the 10-day high') : { target: -1, stopPct: 0.05, reason: 'holding the breakdown' };
      const loud = d.volAvg20[i] > 0 && d.volume[i] > 1.5 * d.volAvg20[i];
      // The safety stop sits at the rule's own exit level: the opposite 10-day extreme.
      if (loud && c > d.high20[i]) return { target: 1, stopPct: clampStop((c - d.low10[i]) / c), reason: `20-day high on ${(d.volume[i] / d.volAvg20[i]).toFixed(1)}x average volume` };
      if (allowShort && loud && c < d.low20[i]) return { target: -1, stopPct: clampStop((d.high10[i] - c) / c), reason: `20-day low on ${(d.volume[i] / d.volAvg20[i]).toFixed(1)}x average volume` };
      return flat('no setup');
    },
  },
];

export function getStrategy(id: string): StrategyDef | undefined {
  return STRATEGIES.find(s => s.id === id);
}
