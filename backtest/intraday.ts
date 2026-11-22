// Scalp and swing rule families on hourly bars, with real costs.
//   npm run backtest:intraday        (downloads hourly data on first run)
// Writes backtest/INTRADAY.md. The question it answers: after fees, which
// kinds of short-horizon rule have had anything left?
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRealFunding } from './data';

const DIR = join(process.cwd(), 'backtest', 'data', 'intraday'); // not committed (large); fetched on demand
const COINS = ['BTC', 'ETH', 'SOL'];
const START = Date.UTC(2020, 0, 1);
const SPLIT = '2023-01-01';
const HOURS_PER_YEAR = 24 * 365;

// Hyperliquid base-tier taker fee plus slippage, charged on every fill.
const TAKER_COST = 0.00045 + 0.0002;
// A resting (maker) order pays 0.015% and no spread, but does not always fill.
const MAKER_COST = 0.00015;

interface Bar { t: number; o: number; h: number; l: number; c: number }

async function fetchHourly(coin: string): Promise<Bar[]> {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${coin.toLowerCase()}-1h.csv`);
  if (existsSync(file)) {
    return readFileSync(file, 'utf8').trim().split('\n').map(l => { const [t, o, h, lo, c] = l.split(',').map(Number); return { t, o, h, l: lo, c }; });
  }
  const bars: Bar[] = [];
  let startTime = START;
  for (;;) {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=1h&limit=1000&startTime=${startTime}`);
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const page = (await res.json()) as Array<[number, string, string, string, string]>;
    if (!page.length) break;
    for (const k of page) bars.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
    if (page.length < 1000) break;
    startTime = page[page.length - 1][0] + 3_600_000;
  }
  bars.pop(); // drop the bar still forming
  writeFileSync(file, bars.map(b => [b.t, b.o, b.h, b.l, b.c].join(',')).join('\n') + '\n');
  return bars;
}

// ---- indicators (value at i uses bars up to and including i) ----
function ema(x: number[], n: number): number[] {
  const k = 2 / (n + 1); const out = [x[0]];
  for (let i = 1; i < x.length; i++) out.push(x[i] * k + out[i - 1] * (1 - k));
  return out;
}
function rsi(c: number[], n: number): number[] {
  const out = new Array(c.length).fill(50); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function rolling(x: number[], n: number, f: (a: number, b: number) => number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) { let v = x[i]; for (let j = i - n + 1; j < i; j++) v = f(v, x[j]); out[i] = v; }
  return out;
}

/** A rule maps the previous position and bar index (information through bar i) to a target of -1, 0 or +1. */
type Rule = (i: number, pos: number) => number;
interface Strategy { name: string; kind: 'Scalp' | 'Intraday' | 'Swing'; build: (b: Bar[]) => Rule; warmup: number }

const STRATEGIES: Strategy[] = [
  { name: 'RSI(14) dip-buy / rip-sell, exit at 50', kind: 'Scalp', warmup: 50, build: b => {
    const r = rsi(b.map(x => x.c), 14);
    return (i, pos) => (pos === 0 ? (r[i] < 30 ? 1 : r[i] > 70 ? -1 : 0) : pos === 1 ? (r[i] >= 50 ? 0 : 1) : r[i] <= 50 ? 0 : -1);
  } },
  { name: 'Fade a 2% hourly move, hold 3 hours', kind: 'Scalp', warmup: 5, build: b => {
    let held = 0;
    return (i, pos) => {
      if (pos !== 0) { held += 1; if (held >= 3) { held = 0; return 0; } return pos; }
      const move = b[i].c / b[i].o - 1;
      return move <= -0.02 ? 1 : move >= 0.02 ? -1 : 0;
    };
  } },
  { name: 'EMA 9 / 21 cross, always in', kind: 'Scalp', warmup: 60, build: b => {
    const c = b.map(x => x.c); const f = ema(c, 9), s = ema(c, 21);
    return i => (f[i] > s[i] ? 1 : -1);
  } },
  { name: '24h breakout, exit on 12h reversal', kind: 'Intraday', warmup: 30, build: b => {
    const hi = rolling(b.map(x => x.h), 24, Math.max), lo = rolling(b.map(x => x.l), 24, Math.min);
    const xh = rolling(b.map(x => x.h), 12, Math.max), xl = rolling(b.map(x => x.l), 12, Math.min);
    return (i, pos) => {
      if (pos === 1) return b[i].c < xl[i - 1] ? 0 : 1;
      if (pos === -1) return b[i].c > xh[i - 1] ? 0 : -1;
      return b[i].c > hi[i - 1] ? 1 : b[i].c < lo[i - 1] ? -1 : 0;
    };
  } },
  { name: 'EMA 50 / 200 cross (hourly), long or short', kind: 'Swing', warmup: 400, build: b => {
    const c = b.map(x => x.c); const f = ema(c, 50), s = ema(c, 200);
    return i => (f[i] > s[i] ? 1 : -1);
  } },
  { name: '20-day breakout, exit on 10-day low, long only', kind: 'Swing', warmup: 500, build: b => {
    const hi = rolling(b.map(x => x.h), 480, Math.max), lo = rolling(b.map(x => x.l), 240, Math.min);
    return (i, pos) => (pos === 1 ? (b[i].c < lo[i - 1] ? 0 : 1) : b[i].c > hi[i - 1] ? 1 : 0);
  } },
  { name: '20-day breakout, long or short', kind: 'Swing', warmup: 500, build: b => {
    const hi = rolling(b.map(x => x.h), 480, Math.max), lo = rolling(b.map(x => x.l), 480, Math.min);
    const xh = rolling(b.map(x => x.h), 240, Math.max), xl = rolling(b.map(x => x.l), 240, Math.min);
    return (i, pos) => {
      if (pos === 1) return b[i].c < xl[i - 1] ? 0 : 1;
      if (pos === -1) return b[i].c > xh[i - 1] ? 0 : -1;
      return b[i].c > hi[i - 1] ? 1 : b[i].c < lo[i - 1] ? -1 : 0;
    };
  } },
  { name: 'Above 30-day average (720h), long or flat', kind: 'Swing', warmup: 730, build: b => {
    const c = b.map(x => x.c); const m = ema(c, 720);
    return i => (c[i] > m[i] ? 1 : 0);
  } },
];

interface Result { annual: number; sharpe: number; maxDd: number; tradesPerYear: number; grossPerTradeBps: number; hours: number }

/** Unlevered (1x) simulation. The rule sees bar i-1 and trades at the open of bar i. */
function simulate(bars: Bar[], s: Strategy, cost: number, funding: Map<string, number>, from: string, to: string): Result {
  const rule = s.build(bars);
  let pos = 0, eq = 1, peak = 1, maxDd = 0, fills = 0, hours = 0, sum = 0, sumSq = 0, grossLog = 0;
  for (let i = s.warmup; i < bars.length; i++) {
    const target = rule(i - 1, pos);
    const date = new Date(bars[i].t).toISOString().slice(0, 10);
    const active = date >= from && date < to;
    let r = 0;
    if (target !== pos) { if (active) { r -= Math.abs(target - pos) * cost; fills += Math.abs(target - pos); } pos = target; }
    if (!active) continue;
    const move = pos * (bars[i].c / bars[i].o - 1);
    // Longs pay funding, shorts receive it; daily rate spread evenly over 24 hours.
    r += move - (pos * (funding.get(date) ?? 0.0003)) / 24;
    grossLog += move;
    eq *= 1 + r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
    sum += r; sumSq += r * r; hours += 1;
  }
  const years = hours / HOURS_PER_YEAR;
  const mean = sum / hours, sd = Math.sqrt(Math.max(sumSq / hours - mean * mean, 1e-18));
  const roundTrips = fills / 2;
  return {
    annual: eq > 0 ? eq ** (1 / years) - 1 : -1,
    sharpe: (mean / sd) * Math.sqrt(HOURS_PER_YEAR),
    maxDd,
    tradesPerYear: roundTrips / years,
    grossPerTradeBps: roundTrips > 0 ? (grossLog / roundTrips) * 1e4 : 0,
    hours,
  };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;

async function main() {
  const data = new Map<string, Bar[]>();
  for (const c of COINS) data.set(c, await fetchHourly(c));
  const last = new Date(data.get('BTC')!.at(-1)!.t).toISOString().slice(0, 10);

  const rows: string[] = [];
  const verdicts: string[] = [];
  for (const s of STRATEGIES) {
    // Average across coins so one lucky market cannot carry a rule.
    const avg = (cost: number, from: string, to: string) => {
      const rs = COINS.map(c => simulate(data.get(c)!, s, cost, loadRealFunding(c), from, to));
      const m = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      return { annual: m(r => r.annual), sharpe: m(r => r.sharpe), maxDd: Math.max(...rs.map(r => r.maxDd)), trades: m(r => r.tradesPerYear), edge: m(r => r.grossPerTradeBps) };
    };
    const free = avg(0, '2020-01-01', '2100-01-01');
    const all = avg(TAKER_COST, '2020-01-01', '2100-01-01');
    const early = avg(TAKER_COST, '2020-01-01', SPLIT);
    const late = avg(TAKER_COST, SPLIT, '2100-01-01');
    const maker = avg(MAKER_COST, SPLIT, '2100-01-01');
    rows.push(`| ${s.kind} | ${s.name} | ${all.trades.toFixed(0)} | ${free.edge.toFixed(0)} bps | ${pct(free.annual)} | ${pct(all.annual)} | ${pct(early.annual)} | **${pct(late.annual)}** | ${late.sharpe.toFixed(2)} | ${pct(maker.annual)} | -${(all.maxDd * 100).toFixed(0)}% |`);
    verdicts.push(`${s.kind}|${s.name}|${late.annual}|${early.annual}|${all.trades}`);
  }

  const md = `# Scalping and swing rules on hourly data

Generated by \`npm run backtest:intraday\` from Binance hourly candles for ${COINS.join(', ')}, 2020-01-01 → ${last}. Do not edit by hand.

Every figure is the **average across the ${COINS.length} coins**, at 1x (no leverage), trading at the next hour's open.
"Taker" costs are Hyperliquid's 0.045% fee plus 0.02% slippage on each fill (0.13% per round trip) plus funding.
"Maker" assumes every order rests and fills at 0.015% with no slippage, which real trading will not fully achieve.

**Nothing was optimised**: these are textbook settings, tested once. A rule that only works after tuning is a rule that does not work.

| Type | Rule | Round trips / yr | Avg gross profit per trade | Return / yr before fees | Return / yr after fees | 2020–2022 | 2023–${last.slice(0, 4)} | Sharpe 2023+ | 2023+ with maker fees | Worst drawdown (worst coin) |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## How to read this

- **"Avg gross profit per trade" is the number that decides everything.** A round trip costs about 13 bps at taker fees. A rule whose average trade makes less than that before costs loses money no matter how often it "wins".
- Leverage does not change that arithmetic. It multiplies the gross profit and the costs alike, and adds liquidation risk.
- The 2023+ column is the fairer guide: the 2020–2022 period includes a once-in-a-decade bull and bear market.
- This is hourly data, so it says nothing about sub-minute scalping, which depends on queue position and latency that a webhook bot cannot compete on.
`;
  writeFileSync(join(process.cwd(), 'backtest', 'INTRADAY.md'), md);
  console.log(md);
}

main().catch(e => { console.error(e); process.exit(1); });
