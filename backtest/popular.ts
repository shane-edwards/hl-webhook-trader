// Strategies taken from TradingView's public community scripts, plus the most
// widely used indicator strategies, tested the same way as everything else.
//   npm run backtest:popular     (downloads candles with volume on first run)
//
// Each rule runs on every coin of the fixed mid-2020 universe with equal
// capital per coin, at 1x, with fees, slippage, funding and intrabar stops.
// TRAIN 2020-07 → 2022, VALIDATE 2023 → 2024, HOLDOUT 2025 → today.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate, loadBars, MAJORS, UNIVERSE, type Bars } from './candles';

const T0 = Date.UTC(2020, 6, 1), TRAIN_END = Date.UTC(2023, 0, 1), VALID_END = Date.UTC(2025, 0, 1);
const COST = 0.00065, STOP_SLIP = 0.0005, FUNDING_PER_DAY = 0.0003;
const HOUR = 3_600_000;

// ---- indicators (value at i uses bars up to and including i) ----
const sma = (x: number[], n: number) => { const o = new Array(x.length).fill(NaN); let s = 0; for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
const ema = (x: number[], n: number) => { const k = 2 / (n + 1); const o = [x[0]]; for (let i = 1; i < x.length; i++) o.push(x[i] * k + o[i - 1] * (1 - k)); return o; };
function rsi(c: number[], n: number) { const o = new Array(c.length).fill(50); let g = 0, l = 0; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; } if (i >= n) o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } return o; }
function atr(b: Bars, n: number) { const o = new Array(b.c.length).fill(NaN); let a = 0; for (let i = 0; i < b.c.length; i++) { const tr = i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])); a = i < n ? a + tr / n : (a * (n - 1) + tr) / n; if (i >= n - 1) o[i] = a; } return o; }
/** Highest/lowest of the n bars BEFORE i (excludes bar i), the usual breakout reference. */
function prior(x: number[], n: number, pick: (a: number, b: number) => number) { const o = new Array(x.length).fill(NaN); for (let i = n; i < x.length; i++) { let v = x[i - 1]; for (let j = i - n; j < i - 1; j++) v = pick(v, x[j]); o[i] = v; } return o; }
/** +1 while price is above the Supertrend line, -1 below. */
function supertrend(b: Bars, n: number, mult: number) {
  const a = atr(b, n), dir = new Array(b.c.length).fill(1); let up = NaN, dn = NaN;
  for (let i = 0; i < b.c.length; i++) {
    if (!Number.isFinite(a[i])) continue;
    const mid = (b.h[i] + b.l[i]) / 2, bu = mid + mult * a[i], bd = mid - mult * a[i];
    up = !Number.isFinite(up) || bu < up || b.c[i - 1] > up ? bu : up;
    dn = !Number.isFinite(dn) || bd > dn || b.c[i - 1] < dn ? bd : dn;
    dir[i] = b.c[i] > up ? 1 : b.c[i] < dn ? -1 : dir[i - 1] ?? 1;
  }
  return dir;
}

// ---- generic simulator ----
interface Ctx { pos: number; entry: number; stop: number; risk: number; held: number }
interface Order { dir: 1 | -1; stop?: number; target?: number }
/** Called on the close of bar i. Return an entry when flat; `exit` or a new `stop` when in a position. */
type Rule = (i: number, ctx: Ctx) => { enter?: Order; exit?: boolean; stop?: number } | null;

function simulate(b: Bars, warm: number, rule: Rule): Map<number, number> {
  const out = new Map<number, number>();
  const ctx: Ctx = { pos: 0, entry: 0, stop: NaN, risk: 0, held: 0 };
  let target = NaN;
  const fund = (FUNDING_PER_DAY * b.ms) / (24 * HOUR);
  for (let i = warm; i < b.c.length - 1; i++) {
    const j = i + 1; let r = 0;
    const act = rule(i, ctx);
    const wasOpen = ctx.pos !== 0;
    if (wasOpen && act?.exit) { r += ctx.pos * (b.o[j] / b.c[i] - 1) - COST; ctx.pos = 0; }
    else if (wasOpen && act?.stop != null && Number.isFinite(act.stop)) ctx.stop = act.stop;
    if (!wasOpen && act?.enter) {
      ctx.pos = act.enter.dir; ctx.entry = b.o[j]; ctx.held = 0;
      ctx.stop = act.enter.stop ?? NaN; target = act.enter.target ?? NaN;
      // Stops and targets are set from the signal close; a gap past the stop makes the trade void.
      if (Number.isFinite(ctx.stop) && ctx.pos * (ctx.entry - ctx.stop) <= 0) { ctx.pos = 0; }
      else { ctx.risk = Number.isFinite(ctx.stop) ? Math.abs(ctx.entry - ctx.stop) : NaN; r -= COST; }
    }
    if (ctx.pos !== 0) {
      const ref = ctx.held === 0 ? ctx.entry : b.c[i];
      const stopHit = Number.isFinite(ctx.stop) && (ctx.pos === 1 ? b.l[j] <= ctx.stop : b.h[j] >= ctx.stop);
      const tgtHit = Number.isFinite(target) && (ctx.pos === 1 ? b.h[j] >= target : b.l[j] <= target);
      if (stopHit) { const px = ctx.pos === 1 ? Math.min(ctx.stop, b.o[j]) : Math.max(ctx.stop, b.o[j]); r += ctx.pos * (px / ref - 1) - COST - STOP_SLIP; ctx.pos = 0; } // stop counted before target
      else if (tgtHit) { r += ctx.pos * (target / ref - 1) - COST; ctx.pos = 0; }
      else { r += ctx.pos * (b.c[j] / ref - 1) - ctx.pos * fund; ctx.held += 1; }
    }
    out.set(b.t[j], r);
  }
  return out;
}

/** Break-even at `first` R of profit, then the stop follows one R behind each further R gained. */
function ladder(ctx: Ctx, close: number, first: number): number | undefined {
  if (!Number.isFinite(ctx.risk) || ctx.risk <= 0) return undefined;
  const gained = Math.floor((ctx.pos * (close - ctx.entry)) / ctx.risk);
  if (gained < first) return undefined;
  const s = ctx.entry + ctx.pos * (gained - first) * ctx.risk;
  return ctx.pos === 1 ? Math.max(s, ctx.stop) : Math.min(s, ctx.stop);
}

interface Def { name: string; source: string; tf: '5m' | '15m' | '1h' | '4h' | '1d'; warm: number; make: (b: Bars, short: boolean) => Rule; shortable: boolean }
const hi = Math.max, lo = Math.min;

const DEFS: Def[] = [
  { name: 'RSI(2) pullback above 200 SMA, exit above 5 SMA or 10 bars, stop 3 ATR', source: 'TradingView', tf: '1d', warm: 210, shortable: false, make: b => {
    const s200 = sma(b.c, 200), s5 = sma(b.c, 5), r = rsi(b.c, 2), a = atr(b, 14);
    return (i, x) => (x.pos ? (b.c[i] > s5[i] || x.held >= 10 ? { exit: true } : null) : b.c[i] > s200[i] && r[i] < 10 ? { enter: { dir: 1, stop: b.c[i] - 3 * a[i] } } : null);
  } },
  { name: 'EMA 50/200 cross with RSI filter, stop 3 ATR, target 3R', source: 'TradingView', tf: '4h', warm: 420, shortable: true, make: (b, short) => {
    const f = ema(b.c, 50), s = ema(b.c, 200), r = rsi(b.c, 14), a = atr(b, 14);
    return (i, x) => {
      if (x.pos) return null;
      if (f[i] > s[i] && f[i - 1] <= s[i - 1] && r[i] > 50) return { enter: { dir: 1, stop: b.c[i] - 3 * a[i], target: b.c[i] + 9 * a[i] } };
      if (short && f[i] < s[i] && f[i - 1] >= s[i - 1] && r[i] < 50) return { enter: { dir: -1, stop: b.c[i] + 3 * a[i], target: b.c[i] - 9 * a[i] } };
      return null;
    };
  } },
  { name: 'Channel breakout 100/50, ATR stop, 4R target, R-ladder trail', source: 'TradingView', tf: '4h', warm: 120, shortable: true, make: (b, short) => {
    // The original uses 2 x daily ATR(14); 84 four-hour bars cover the same 14 days, scaled to a daily range.
    const H = prior(b.h, 100, hi), L = prior(b.l, 100, lo), xh = prior(b.h, 50, hi), xl = prior(b.l, 50, lo), a = atr(b, 84).map(v => v * Math.sqrt(6));
    return (i, x) => {
      if (x.pos) return (x.pos === 1 ? b.c[i] < xl[i] : b.c[i] > xh[i]) ? { exit: true } : { stop: ladder(x, b.c[i], 2) };
      if (b.c[i] > H[i]) return { enter: { dir: 1, stop: b.c[i] - 2 * a[i], target: b.c[i] + 8 * a[i] } };
      if (short && b.c[i] < L[i]) return { enter: { dir: -1, stop: b.c[i] + 2 * a[i], target: b.c[i] - 8 * a[i] } };
      return null;
    };
  } },
  { name: 'Daily trend breakout (EMA 50>200, 5-day high), 1.5 ATR stop, R-ladder, exit below EMA 20', source: 'TradingView', tf: '1d', warm: 210, shortable: false, make: b => {
    const e20 = ema(b.c, 20), e50 = ema(b.c, 50), e200 = ema(b.c, 200), H = prior(b.h, 5, hi), a = atr(b, 14);
    return (i, x) => (x.pos ? (b.c[i] < e20[i] ? { exit: true } : { stop: ladder(x, b.c[i], 1) }) : e50[i] > e200[i] && b.c[i] > e50[i] && b.c[i] > H[i] ? { enter: { dir: 1, stop: b.c[i] - 1.5 * a[i] } } : null);
  } },
  { name: 'Supertrend(12, 2.76) flip with RSI(12) filter, stop 4 ATR, target 2 ATR', source: 'TradingView', tf: '15m', warm: 60, shortable: true, make: (b, short) => {
    const d = supertrend(b, 12, 2.76), r = rsi(b.c, 12), a = atr(b, 12);
    return (i, x) => {
      if (x.pos) return null;
      if (d[i] === 1 && d[i - 1] === -1 && r[i] < 70) return { enter: { dir: 1, stop: b.c[i] - 4 * a[i], target: b.c[i] + 2 * a[i] } };
      if (short && d[i] === -1 && d[i - 1] === 1 && r[i] > 30) return { enter: { dir: -1, stop: b.c[i] + 4 * a[i], target: b.c[i] - 2.237 * a[i] } };
      return null;
    };
  } },
  ...(['5m', '1h'] as const).map((tf): Def => ({ name: `ATR trailing-stop bot (key 2, ATR 14): buy cross above trail, stop 2 ATR, target 1.65R (${tf})`, source: 'TradingView', tf, warm: 60, shortable: false, make: b => {
    const a = atr(b, 14), trail = new Array(b.c.length).fill(0);
    for (let i = 1; i < b.c.length; i++) { const n = 2 * (a[i] || 0), p = trail[i - 1]; trail[i] = b.c[i] > p && b.c[i - 1] > p ? Math.max(p, b.c[i] - n) : b.c[i] < p && b.c[i - 1] < p ? Math.min(p, b.c[i] + n) : b.c[i] > p ? b.c[i] - n : b.c[i] + n; }
    return (i, x) => (x.pos ? (b.c[i] < trail[i] ? { exit: true } : null) : b.c[i] > trail[i] && b.c[i - 1] <= trail[i - 1] ? { enter: { dir: 1, stop: b.c[i] - 2 * a[i], target: b.c[i] + 3.3 * a[i] } } : null);
  } })),
  { name: '60-bar breakout with strong candle, volume at least 2x its 40-bar average, in the upper half of the 400-bar range, exit on 30-bar channel', source: 'TradingView', tf: '1h', warm: 410, shortable: true, make: (b, short) => {
    const H = prior(b.h, 60, hi), L = prior(b.l, 60, lo), xh = prior(b.h, 30, hi), xl = prior(b.l, 30, lo), rh = prior(b.h, 400, hi), rl = prior(b.l, 400, lo), s5l = prior(b.l, 5, lo), s5h = prior(b.h, 5, hi), va = sma(b.v, 40);
    return (i, x) => {
      if (x.pos) return (x.pos === 1 ? b.c[i] < xl[i] : b.c[i] > xh[i]) ? { exit: true } : null;
      const body = Math.abs(b.c[i] - b.o[i]) >= 0.6 * (b.h[i] - b.l[i]) && b.v[i] >= 2 * va[i - 1], mid = (rh[i] + rl[i]) / 2;
      if (body && b.c[i] > H[i] && b.c[i] > mid) return { enter: { dir: 1, stop: lo(s5l[i], b.l[i]) } };
      if (short && body && b.c[i] < L[i] && b.c[i] < mid) return { enter: { dir: -1, stop: hi(s5h[i], b.h[i]) } };
      return null;
    };
  } },
  ...(['4h', '1d'] as const).map((tf): Def => ({ name: `EMA 20/50 cross (${tf})`, source: 'TradingView', tf, warm: 120, shortable: true, make: (b, short) => {
    const f = ema(b.c, 20), s = ema(b.c, 50);
    return (i, x) => (x.pos ? ((x.pos === 1 ? f[i] < s[i] : f[i] > s[i]) ? { exit: true } : null) : f[i] > s[i] && f[i - 1] <= s[i - 1] ? { enter: { dir: 1 } } : short && f[i] < s[i] && f[i - 1] >= s[i - 1] ? { enter: { dir: -1 } } : null);
  } })),
  ...(['4h', '1d'] as const).map((tf): Def => ({ name: `Supertrend(10, 3) flip (${tf})`, source: 'Popular indicator', tf, warm: 60, shortable: true, make: (b, short) => {
    const d = supertrend(b, 10, 3);
    return (i, x) => (x.pos ? (d[i] !== x.pos ? { exit: true } : null) : d[i] === 1 && d[i - 1] === -1 ? { enter: { dir: 1 } } : short && d[i] === -1 && d[i - 1] === 1 ? { enter: { dir: -1 } } : null);
  } })),
  { name: 'MACD(12, 26, 9) cross above the 200 EMA', source: 'Popular indicator', tf: '4h', warm: 420, shortable: true, make: (b, short) => {
    const f = ema(b.c, 12), s = ema(b.c, 26), m = f.map((v, i) => v - s[i]), sig = ema(m, 9), e200 = ema(b.c, 200);
    return (i, x) => (x.pos ? ((x.pos === 1 ? m[i] < sig[i] : m[i] > sig[i]) ? { exit: true } : null) : m[i] > sig[i] && m[i - 1] <= sig[i - 1] && b.c[i] > e200[i] ? { enter: { dir: 1 } } : short && m[i] < sig[i] && m[i - 1] >= sig[i - 1] && b.c[i] < e200[i] ? { enter: { dir: -1 } } : null);
  } },
  { name: 'Turtle: 20-day high breakout, exit on 10-day low', source: 'Popular indicator', tf: '1d', warm: 30, shortable: true, make: (b, short) => {
    const H = prior(b.h, 20, hi), L = prior(b.l, 20, lo), xh = prior(b.h, 10, hi), xl = prior(b.l, 10, lo);
    return (i, x) => (x.pos ? ((x.pos === 1 ? b.c[i] < xl[i] : b.c[i] > xh[i]) ? { exit: true } : null) : b.c[i] > H[i] ? { enter: { dir: 1 } } : short && b.c[i] < L[i] ? { enter: { dir: -1 } } : null);
  } },
  { name: 'Bollinger(20, 2) upper-band breakout, exit at the middle band', source: 'Popular indicator', tf: '4h', warm: 30, shortable: true, make: (b, short) => {
    const m = sma(b.c, 20), sd = b.c.map((_, i) => { if (i < 19) return NaN; let v = 0; for (let j = i - 19; j <= i; j++) v += (b.c[j] - m[i]) ** 2; return Math.sqrt(v / 20); });
    return (i, x) => (x.pos ? ((x.pos === 1 ? b.c[i] < m[i] : b.c[i] > m[i]) ? { exit: true } : null) : b.c[i] > m[i] + 2 * sd[i] ? { enter: { dir: 1 } } : short && b.c[i] < m[i] - 2 * sd[i] ? { enter: { dir: -1 } } : null);
  } },
  { name: 'Ichimoku: above the cloud with conversion line over base line', source: 'Popular indicator', tf: '1d', warm: 90, shortable: false, make: b => {
    const mid = (n: number) => { const H = prior(b.h, n, hi), L = prior(b.l, n, lo); return H.map((v, i) => (hi(v, b.h[i]) + lo(L[i], b.l[i])) / 2); };
    const ten = mid(9), kij = mid(26), spanB = mid(52);
    const top = (i: number) => (i < 26 ? NaN : hi((ten[i - 26] + kij[i - 26]) / 2, spanB[i - 26]));
    return (i, x) => (x.pos ? (b.c[i] < kij[i] ? { exit: true } : null) : b.c[i] > top(i) && ten[i] > kij[i] ? { enter: { dir: 1 } } : null);
  } },
  { name: '20-day high on volume above 1.5x its 20-day average, exit on 10-day low', source: 'Volume', tf: '1d', warm: 30, shortable: true, make: (b, short) => {
    const H = prior(b.h, 20, hi), L = prior(b.l, 20, lo), xh = prior(b.h, 10, hi), xl = prior(b.l, 10, lo), va = sma(b.v, 20);
    return (i, x) => (x.pos ? ((x.pos === 1 ? b.c[i] < xl[i] : b.c[i] > xh[i]) ? { exit: true } : null) : b.v[i] > 1.5 * va[i - 1] && b.c[i] > H[i] ? { enter: { dir: 1 } } : short && b.v[i] > 1.5 * va[i - 1] && b.c[i] < L[i] ? { enter: { dir: -1 } } : null);
  } },
  { name: 'Capitulation buy: hour falls over 2 ATR on volume 4x its 48-hour average; hold 12 hours, stop 2 ATR', source: 'Volume', tf: '1h', warm: 60, shortable: true, make: (b, short) => {
    const a = atr(b, 24), va = sma(b.v, 48);
    return (i, x) => {
      if (x.pos) return x.held >= 12 ? { exit: true } : null;
      const big = b.v[i] > 4 * va[i - 1], move = b.c[i] - b.o[i];
      if (big && move < -2 * a[i - 1]) return { enter: { dir: 1, stop: b.c[i] - 2 * a[i] } };
      if (short && big && move > 2 * a[i - 1]) return { enter: { dir: -1, stop: b.c[i] + 2 * a[i] } };
      return null;
    };
  } },
  { name: 'On-balance volume above its 50 EMA with price above its 50 EMA', source: 'Volume', tf: '4h', warm: 120, shortable: true, make: (b, short) => {
    const obv = [0]; for (let i = 1; i < b.c.length; i++) obv.push(obv[i - 1] + (b.c[i] > b.c[i - 1] ? b.v[i] : b.c[i] < b.c[i - 1] ? -b.v[i] : 0));
    const oe = ema(obv, 50), pe = ema(b.c, 50);
    return (i, x) => (x.pos ? ((x.pos === 1 ? obv[i] < oe[i] : obv[i] > oe[i]) ? { exit: true } : null) : obv[i] > oe[i] && b.c[i] > pe[i] ? { enter: { dir: 1 } } : short && obv[i] < oe[i] && b.c[i] < pe[i] ? { enter: { dir: -1 } } : null);
  } },
  { name: 'Volume-weighted price (24h VWAP) reclaim: close crosses above VWAP in an uptrend, exit below', source: 'Volume', tf: '1h', warm: 420, shortable: true, make: (b, short) => {
    const pv = b.c.map((c, i) => ((b.h[i] + b.l[i] + c) / 3) * b.v[i]); const spv = sma(pv, 24), sv = sma(b.v, 24), vwap = spv.map((x, i) => x / sv[i]), e = ema(b.c, 400);
    return (i, x) => (x.pos ? ((x.pos === 1 ? b.c[i] < vwap[i] : b.c[i] > vwap[i]) ? { exit: true } : null) : b.c[i] > vwap[i] && b.c[i - 1] <= vwap[i - 1] && b.c[i] > e[i] ? { enter: { dir: 1 } } : short && b.c[i] < vwap[i] && b.c[i - 1] >= vwap[i - 1] && b.c[i] < e[i] ? { enter: { dir: -1 } } : null);
  } },
];

interface Stat { annual: number; sharpe: number; maxDd: number }
function stat(times: number[], rets: number[], from: number, to: number, perYear: number): Stat {
  let eq = 1, peak = 1, maxDd = 0, sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < times.length; i++) { if (times[i] < from || times[i] >= to) continue; eq *= 1 + rets[i]; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak); sum += rets[i]; sumSq += rets[i] ** 2; n++; }
  if (n < 10) return { annual: 0, sharpe: 0, maxDd: 0 };
  const mean = sum / n, sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-18));
  return { annual: eq > 0 ? eq ** (perYear / n) - 1 : -1, sharpe: (mean / sd) * Math.sqrt(perYear), maxDd };
}

async function main() {
const data: Record<string, Map<string, Bars>> = { '5m': new Map(), '15m': new Map(), '1h': new Map(), '4h': new Map(), '1d': new Map() };
for (const c of UNIVERSE) {
  const h = await loadBars(c, '1h'); if (!h) continue;
  data['1h'].set(c, h); data['4h'].set(c, aggregate(h, 4)); data['1d'].set(c, aggregate(h, 24));
}
// Sub-hourly data is large, so the short-timeframe rules run on the three majors only.
for (const c of MAJORS) for (const tf of ['5m', '15m'] as const) { const q = await loadBars(c, tf); if (q) data[tf].set(c, q); }
const end = data['1h'].get('BTC')!.t.at(-1)! + HOUR;
const lastDate = new Date(end).toISOString().slice(0, 10);

const results = DEFS.flatMap(d => (d.shortable ? [false, true] : [false]).map(short => {
  const coins = [...data[d.tf].keys()];
  const series = coins.map(c => simulate(data[d.tf].get(c)!, d.warm, d.make(data[d.tf].get(c)!, short)));
  const times = [...new Set(series.flatMap(s => [...s.keys()]))].filter(t => t >= T0).sort((a, b) => a - b);
  const rets = times.map(t => series.reduce((a, s) => a + (s.get(t) ?? 0), 0) / coins.length);
  const perYear = (365 * 24 * HOUR) / data[d.tf].get('BTC')!.ms;
  const train = stat(times, rets, T0, TRAIN_END, perYear), valid = stat(times, rets, TRAIN_END, VALID_END, perYear);
  const selected = train.sharpe >= 0.5 && valid.sharpe >= 0.5;
  return { d, short, coins: coins.length, train, valid, selected, holdout: selected ? stat(times, rets, VALID_END, end, perYear) : null, dd: stat(times, rets, T0, end, perYear).maxDd };
}));

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const cell = (s: Stat) => `${pct(s.annual)} (${s.sharpe.toFixed(2)})`;
const sel = results.filter(r => r.selected), conf = sel.filter(r => r.holdout!.sharpe >= 0.3 && r.holdout!.annual > 0);
const rows = results.map(r => `| ${r.d.source} | ${r.d.name} | ${r.d.tf} | ${r.short ? 'Long & short' : 'Long only'} | ${r.coins} | ${cell(r.train)} | ${cell(r.valid)} | ${r.holdout ? `**${cell(r.holdout)}**` : 'not selected'} | -${(r.dd * 100).toFixed(0)}% |`);

const md = `# TradingView community strategies and popular indicator strategies

Generated by \`npm run backtest:popular\` through ${lastDate}. Do not edit by hand. Figures are **return per year (Sharpe ratio)** at 1x,
equal capital per coin, after fees, slippage and funding. Stops are checked inside each bar and counted before targets.

Rules marked "TradingView" were taken from the public descriptions of community scripts and coded as described; settings the
author did not state were left at the indicator's usual default. Rules on 5- and 15-minute bars run on BTC, ETH and SOL only; the rest run on all coins with data.

Selected: Sharpe of at least 0.5 in both train (2020-07 → 2022) and validate (2023 → 2024). Confirmed: holdout (2025 → ${lastDate}) Sharpe of at
least 0.3 with a positive return.

**${results.length} variants tested. Selected: ${sel.length}. Confirmed on holdout: ${conf.length}.**

| Source | Rule | Bars | Direction | Coins | Train | Validate | Holdout | Worst drawdown |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}
`;
writeFileSync(join(process.cwd(), 'backtest', 'POPULAR.md'), md);
console.log(`tested ${results.length}, selected ${sel.length}, confirmed ${conf.length}`);
for (const r of results) console.log(`${r.selected ? (conf.includes(r) ? 'CONF' : 'sel ') : '    '} ${r.d.tf.padEnd(3)} ${(r.short ? 'L/S' : 'L  ')} ${cell(r.train).padEnd(14)} ${cell(r.valid).padEnd(14)} ${(r.holdout ? cell(r.holdout) : '-').padEnd(14)} ${r.d.name.slice(0, 70)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
