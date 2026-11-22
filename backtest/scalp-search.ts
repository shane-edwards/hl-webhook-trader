// A systematic search for short-term (15-minute) strategies that survive costs.
//   npm run backtest:scalp
//
// Protocol, fixed before looking at results:
//   TRAIN      2020-01 → 2022-12   } a configuration must pass BOTH of these
//   VALIDATE   2023-01 → 2024-12   } to be selected
//   HOLDOUT    2025-01 → today       looked at once, for the selected ones only
// Searching hundreds of settings always finds some that look good by luck.
// The holdout is the only number here that is not contaminated by the search.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'backtest', 'data', 'intraday');
const COINS = ['BTC', 'ETH', 'SOL'];
const TRAIN_END = Date.UTC(2023, 0, 1), VALID_END = Date.UTC(2025, 0, 1);

// Hyperliquid base tier. A resting (post-only) order pays the maker fee and
// crosses no spread; anything that must execute now pays taker plus slippage.
// FEE_SCENARIO=free|top reruns the search under other fee assumptions as a
// diagnostic (nothing is written): "free" removes fees and slippage entirely,
// "top" is Hyperliquid's highest volume tier (0% maker, 0.024% taker).
const SCENARIO = process.env.FEE_SCENARIO ?? 'base';
const MAKER = SCENARIO === 'free' ? 0 : SCENARIO === 'top' ? 0 : 0.00015;
const TAKER = SCENARIO === 'free' ? 0 : (SCENARIO === 'top' ? 0.00024 : 0.00045) + 0.0002;
const STOP_SLIP = SCENARIO === 'free' ? 0 : 0.0003;
// A resting order only counts as filled if price trades THROUGH it by this
// much: being first in the queue at the exact price cannot be assumed.
const THROUGH = 0.0002;

interface Bars { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; atr: number[]; ema: number[]; atrSlow: number[] }

async function load(coin: string): Promise<Bars> {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${coin.toLowerCase()}-15m.csv`);
  let rows: number[][];
  if (existsSync(file)) {
    rows = readFileSync(file, 'utf8').trim().split('\n').map(l => l.split(',').map(Number));
  } else {
    rows = [];
    let startTime = Date.UTC(2020, 0, 1);
    for (;;) {
      const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=15m&limit=1000&startTime=${startTime}`);
      if (!res.ok) throw new Error(`Binance ${res.status}`);
      const page = (await res.json()) as Array<[number, string, string, string, string]>;
      if (!page.length) break;
      for (const k of page) rows.push([k[0], +k[1], +k[2], +k[3], +k[4]]);
      if (page.length < 1000) break;
      startTime = page[page.length - 1][0] + 900_000;
    }
    rows.pop();
    writeFileSync(file, rows.map(r => r.join(',')).join('\n') + '\n');
  }
  const n = rows.length;
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], atr: new Array(n).fill(NaN), ema: new Array(n).fill(NaN), atrSlow: new Array(n).fill(NaN) };
  for (const r of rows) { b.t.push(r[0]); b.o.push(r[1]); b.h.push(r[2]); b.l.push(r[3]); b.c.push(r[4]); }
  // ATR as a fraction of price over 96 bars (24h); EMA over 2880 bars (30 days).
  let sum = 0; const tr: number[] = [];
  const k = 2 / 2881; let e = b.c[0];
  for (let i = 0; i < n; i++) {
    const x = (i === 0 ? b.h[i] - b.l[i] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]))) / b.c[i];
    tr.push(x); sum += x; if (i >= 96) sum -= tr[i - 96];
    if (i >= 95) b.atr[i] = sum / 96;
    e = b.c[i] * k + e * (1 - k); b.ema[i] = e;
  }
  // 30-day average of the 24h ATR: "is today quieter than usual?"
  let es = b.atr[95];
  for (let i = 95; i < n; i++) { es = b.atr[i] * k + es * (1 - k); b.atrSlow[i] = es; }
  return b;
}

const WARM = 2900;
interface Trade { t: number; net: number }

// ---------------------------------------------------------------------------
// Family A: resting-order mean reversion ("buy the wick").
// Rest a bid `k` ATRs under the last close. If filled, rest a take-profit `m`
// ATRs above entry, with a stop `s` ATRs below and a time limit.
// ---------------------------------------------------------------------------
interface FadeCfg { k: number; m: number; s: number; hold: number; regime: 'trend' | 'any' | 'quiet'; both: boolean }

function fade(b: Bars, cfg: FadeCfg): Trade[] {
  const trades: Trade[] = [];
  let pos = 0, entry = 0, tp = 0, sl = 0, held = 0;
  for (let i = WARM; i < b.c.length - 1; i++) {
    const j = i + 1; // the bar in which orders rest
    if (pos === 0) {
      const a = b.atr[i], up = b.c[i] > b.ema[i];
      // 'quiet': only fade when volatility is below its 30-day norm (range-bound markets), either direction.
      if (cfg.regime === 'quiet' && !(a < 0.8 * b.atrSlow[i])) continue;
      const wantLong = cfg.regime !== 'trend' || up;
      const wantShort = cfg.both && (cfg.regime !== 'trend' || !up);
      const bid = b.c[i] * (1 - cfg.k * a), ask = b.c[i] * (1 + cfg.k * a);
      let dir = 0;
      if (wantLong && b.l[j] <= bid * (1 - THROUGH)) dir = 1;
      else if (wantShort && b.h[j] >= ask * (1 + THROUGH)) dir = -1;
      if (dir === 0) continue;
      entry = dir === 1 ? bid : ask;
      tp = entry * (1 + dir * cfg.m * a); sl = entry * (1 - dir * cfg.s * a);
      // Same bar as the fill: assume the stop is hit if the bar reached it;
      // only credit the target if the bar CLOSED beyond it.
      if (dir === 1 ? b.l[j] <= sl : b.h[j] >= sl) { trades.push({ t: b.t[j], net: -cfg.s * a - MAKER - TAKER - STOP_SLIP }); continue; }
      if (dir === 1 ? b.c[j] >= tp : b.c[j] <= tp) { trades.push({ t: b.t[j], net: cfg.m * a - 2 * MAKER }); continue; }
      pos = dir; held = 0;
      continue;
    }
    held += 1;
    // Worst case first: if both stop and target are inside the bar, count the stop.
    if (pos === 1 ? b.l[j] <= sl : b.h[j] >= sl) {
      const px = pos === 1 ? Math.min(sl, b.o[j]) : Math.max(sl, b.o[j]);
      trades.push({ t: b.t[j], net: pos * (px / entry - 1) - MAKER - TAKER - STOP_SLIP }); pos = 0;
    } else if (pos === 1 ? b.h[j] >= tp * (1 + THROUGH) : b.l[j] <= tp * (1 - THROUGH)) {
      trades.push({ t: b.t[j], net: pos * (tp / entry - 1) - 2 * MAKER }); pos = 0;
    } else if (held >= cfg.hold) {
      trades.push({ t: b.t[j], net: pos * (b.c[j] / entry - 1) - MAKER - TAKER }); pos = 0;
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Family B: 15-minute breakout, market orders, ATR stop, time limit.
// ---------------------------------------------------------------------------
interface BreakCfg { n: number; s: number; hold: number; trend: boolean; both: boolean }

function breakout(b: Bars, cfg: BreakCfg): Trade[] {
  const trades: Trade[] = [];
  let pos = 0, entry = 0, sl = 0, held = 0;
  let hi = -Infinity, lo = Infinity;
  for (let i = WARM; i < b.c.length - 1; i++) {
    hi = -Infinity; lo = Infinity;
    for (let q = i - cfg.n; q < i; q++) { if (b.h[q] > hi) hi = b.h[q]; if (b.l[q] < lo) lo = b.l[q]; }
    const j = i + 1;
    if (pos === 0) {
      const up = b.c[i] > b.ema[i];
      let dir = 0;
      if (b.c[i] > hi && (!cfg.trend || up)) dir = 1;
      else if (cfg.both && b.c[i] < lo && (!cfg.trend || !up)) dir = -1;
      if (dir === 0) continue;
      pos = dir; entry = b.o[j]; sl = entry * (1 - dir * cfg.s * b.atr[i]); held = 0;
    }
    held += 1;
    if (pos === 1 ? b.l[j] <= sl : b.h[j] >= sl) {
      const px = pos === 1 ? Math.min(sl, b.o[j]) : Math.max(sl, b.o[j]);
      trades.push({ t: b.t[j], net: pos * (px / entry - 1) - 2 * TAKER - STOP_SLIP }); pos = 0;
    } else if (held >= cfg.hold) {
      trades.push({ t: b.t[j], net: pos * (b.c[j] / entry - 1) - 2 * TAKER }); pos = 0;
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Family C: lead-lag. When BTC makes a large 15-minute move, take the same
// direction in the follower coin at the next open and hold a few bars.
// ---------------------------------------------------------------------------
interface LagCfg { x: number; hold: number }

function leadLag(btc: Bars, f: Bars, cfg: LagCfg): Trade[] {
  const trades: Trade[] = [];
  const idx = new Map(f.t.map((t, i) => [t, i]));
  for (let i = WARM; i < btc.c.length - 1; i++) {
    const move = btc.c[i] / btc.o[i] - 1;
    if (Math.abs(move) < cfg.x * btc.atr[i]) continue;
    const j = idx.get(btc.t[i + 1]);
    if (j == null || j + cfg.hold >= f.c.length) continue;
    const dir = move > 0 ? 1 : -1;
    trades.push({ t: f.t[j], net: dir * (f.c[j + cfg.hold - 1] / f.o[j] - 1) - 2 * TAKER });
    i += cfg.hold - 1;
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Family D: pairs trading. When the price ratio of two coins stretches far
// from its recent average, short the rich one and buy the cheap one in equal
// size; close when the ratio comes back. Market orders on both legs.
// ---------------------------------------------------------------------------
interface PairCfg { look: number; zIn: number; zOut: number; maxHold: number }

function pairs(a: Bars, b: Bars, cfg: PairCfg): Trade[] {
  const trades: Trade[] = [];
  const ib = new Map(b.t.map((t, i) => [t, i]));
  const t: number[] = [], ra: number[] = [], rb: number[] = [], lr: number[] = [];
  for (let i = 0; i < a.t.length; i++) { const j = ib.get(a.t[i]); if (j == null) continue; t.push(a.t[i]); ra.push(a.c[i]); rb.push(b.c[j]); lr.push(Math.log(a.c[i] / b.c[j])); }
  let sum = 0, sumSq = 0, pos = 0, ea = 0, eb = 0, held = 0;
  for (let i = 0; i < lr.length - 1; i++) {
    sum += lr[i]; sumSq += lr[i] * lr[i];
    if (i >= cfg.look) { sum -= lr[i - cfg.look]; sumSq -= lr[i - cfg.look] ** 2; }
    if (i < Math.max(cfg.look, 300)) continue;
    const mean = sum / cfg.look, sd = Math.sqrt(Math.max(sumSq / cfg.look - mean * mean, 1e-12));
    const z = (lr[i] - mean) / sd;
    if (pos === 0) {
      if (Math.abs(z) >= cfg.zIn) { pos = z > 0 ? -1 : 1; ea = ra[i + 1]; eb = rb[i + 1]; held = 0; } // act at the next bar (its close stands in for its open)
      continue;
    }
    held += 1;
    if ((pos === 1 ? z >= -cfg.zOut : z <= cfg.zOut) || held >= cfg.maxHold) {
      // Half the capital in each leg; four market fills in total.
      const pnl = 0.5 * pos * (ra[i + 1] / ea - 1) - 0.5 * pos * (rb[i + 1] / eb - 1);
      trades.push({ t: t[i + 1], net: pnl - 2 * TAKER }); pos = 0;
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------
// Family E: failed breakdown ("stop run"). Price dips below the low of the
// last N bars, then closes back above it: buy the next open. Mirrored for
// failed breakouts when shorts are allowed. Market orders, ATR stop and target.
// ---------------------------------------------------------------------------
interface TrapCfg { n: number; s: number; m: number; hold: number; trend: boolean; both: boolean }

function trap(b: Bars, cfg: TrapCfg): Trade[] {
  const trades: Trade[] = [];
  let pos = 0, entry = 0, sl = 0, tp = 0, held = 0;
  for (let i = WARM; i < b.c.length - 1; i++) {
    const j = i + 1;
    if (pos === 0) {
      let hi = -Infinity, lo = Infinity;
      for (let q = i - cfg.n; q < i; q++) { if (b.h[q] > hi) hi = b.h[q]; if (b.l[q] < lo) lo = b.l[q]; }
      const up = b.c[i] > b.ema[i];
      let dir = 0;
      if (b.l[i] < lo && b.c[i] > lo && (!cfg.trend || up)) dir = 1;
      else if (cfg.both && b.h[i] > hi && b.c[i] < hi && (!cfg.trend || !up)) dir = -1;
      if (dir === 0) continue;
      pos = dir; entry = b.o[j]; sl = entry * (1 - dir * cfg.s * b.atr[i]); tp = entry * (1 + dir * cfg.m * b.atr[i]); held = 0;
    }
    held += 1;
    if (pos === 1 ? b.l[j] <= sl : b.h[j] >= sl) {
      const px = pos === 1 ? Math.min(sl, b.o[j]) : Math.max(sl, b.o[j]);
      trades.push({ t: b.t[j], net: pos * (px / entry - 1) - 2 * TAKER - STOP_SLIP }); pos = 0;
    } else if (pos === 1 ? b.h[j] >= tp * (1 + THROUGH) : b.l[j] <= tp * (1 - THROUGH)) {
      trades.push({ t: b.t[j], net: pos * (tp / entry - 1) - TAKER - MAKER }); pos = 0; // target rests as a limit order
    } else if (held >= cfg.hold) {
      trades.push({ t: b.t[j], net: pos * (b.c[j] / entry - 1) - 2 * TAKER }); pos = 0;
    }
  }
  return trades;
}

// ---------------------------------------------------------------------------

interface PeriodStat { trades: number; avgBps: number; t: number; sumPct: number; coinsPositive: number }
function period(perCoin: Trade[][], from: number, to: number): PeriodStat {
  const all: number[] = []; let coinsPositive = 0;
  for (const ts of perCoin) {
    const xs = ts.filter(x => x.t >= from && x.t < to).map(x => x.net);
    if (xs.reduce((a, v) => a + v, 0) > 0) coinsPositive += 1;
    all.push(...xs);
  }
  const n = all.length;
  if (n < 2) return { trades: n, avgBps: 0, t: 0, sumPct: 0, coinsPositive };
  const mean = all.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(all.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  return { trades: n, avgBps: mean * 1e4, t: sd > 0 ? (mean / sd) * Math.sqrt(n) : 0, sumPct: (mean * n * 100) / perCoin.length, coinsPositive };
}

// The selection rule, written down before running: enough trades, a real
// per-trade edge after costs, statistically distinguishable from zero, and
// not carried by a single coin, in BOTH the training and validation periods.
const passes = (s: PeriodStat, coins: number) => s.trades >= 100 && s.avgBps >= 3 && s.t >= 2 && s.coinsPositive >= Math.min(2, coins);

async function main() {
  const data = new Map<string, Bars>();
  for (const c of COINS) data.set(c, await load(c));
  const end = data.get('BTC')!.t.at(-1)! + 1;
  const lastDate = new Date(end).toISOString().slice(0, 10);

  interface Candidate { family: string; label: string; cfg: unknown; run: () => Trade[][] }
  const cands: Candidate[] = [];
  for (const k of [0.5, 1, 1.5, 2, 3]) for (const m of [0.5, 1, 2]) for (const s of [2, 4]) for (const hold of [8, 32]) for (const regime of ['trend', 'any', 'quiet'] as const) for (const both of [false, true]) {
    const cfg: FadeCfg = { k, m, s, hold, regime, both };
    cands.push({ family: 'fade', cfg, label: `Resting-order fade: entry ${k} ATR away, target ${m} ATR, stop ${s} ATR, max ${hold * 15 / 60}h, ${regime === 'trend' ? 'with the trend' : regime === 'quiet' ? 'quiet markets only' : 'any regime'}, ${both ? 'long & short' : 'long only'}`, run: () => COINS.map(c => fade(data.get(c)!, cfg)) });
  }
  for (const n of [16, 48, 96]) for (const s of [2, 4]) for (const hold of [8, 32]) for (const trend of [true, false]) for (const both of [false, true]) {
    const cfg: BreakCfg = { n, s, hold, trend, both };
    cands.push({ family: 'breakout', cfg, label: `15m breakout of ${n * 15 / 60}h range, stop ${s} ATR, max ${hold * 15 / 60}h, ${trend ? 'with the trend' : 'any regime'}, ${both ? 'long & short' : 'long only'}`, run: () => COINS.map(c => breakout(data.get(c)!, cfg)) });
  }
  for (const x of [2, 3, 4]) for (const hold of [1, 2, 4]) {
    const cfg: LagCfg = { x, hold };
    cands.push({ family: 'leadlag', cfg, label: `Follow BTC into ETH/SOL after a ${x} ATR BTC bar, hold ${hold * 15} min`, run: () => ['ETH', 'SOL'].map(c => leadLag(data.get('BTC')!, data.get(c)!, cfg)) });
  }

  const PAIRS: Array<[string, string]> = [['ETH', 'BTC'], ['SOL', 'BTC'], ['SOL', 'ETH']];
  for (const look of [96, 288, 672]) for (const zIn of [2, 2.5, 3]) for (const zOut of [0, 0.5]) for (const maxHold of [96, 384]) {
    const cfg: PairCfg = { look, zIn, zOut, maxHold };
    cands.push({ family: 'pairs', cfg, label: `Pairs: ${look / 96}-day ratio, enter at ${zIn} sd, exit at ${zOut} sd, max ${maxHold / 96} days`, run: () => PAIRS.map(([x, y]) => pairs(data.get(x)!, data.get(y)!, cfg)) });
  }
  for (const n of [96, 288]) for (const s of [1.5, 3]) for (const m of [2, 4]) for (const hold of [8, 32]) for (const trend of [true, false]) for (const both of [false, true]) {
    const cfg: TrapCfg = { n, s, m, hold, trend, both };
    cands.push({ family: 'trap', cfg, label: `Failed breakdown of ${n / 96}-day low, stop ${s} ATR, target ${m} ATR, max ${hold * 15 / 60}h, ${trend ? 'with the trend' : 'any regime'}, ${both ? 'long & short' : 'long only'}`, run: () => COINS.map(c => trap(data.get(c)!, cfg)) });
  }

  // Self-test: a rule that cheats by looking one bar into the future must pass
  // every stage. If it does not, the harness is broken, not the strategies.
  if (process.env.SELFTEST) {
    cands.push({ family: 'selftest', cfg: {}, label: 'SELFTEST (looks into the future)', run: () => COINS.map(c => {
      const b = data.get(c)!; const out: Trade[] = [];
      for (let i = WARM; i < b.c.length - 1; i += 4) if (b.c[i + 1] > b.o[i + 1] * 1.004) out.push({ t: b.t[i + 1], net: b.c[i + 1] / b.o[i + 1] - 1 - 2 * TAKER });
      return out;
    }) });
  }

  const start = Date.UTC(2020, 0, 1);
  const results = cands.map(c => {
    const trades = c.run();
    const train = period(trades, start, TRAIN_END), valid = period(trades, TRAIN_END, VALID_END);
    const selected = passes(train, trades.length) && passes(valid, trades.length);
    // The holdout is only computed for configurations already selected.
    const holdout = selected ? period(trades, VALID_END, end) : null;
    return { ...c, train, valid, selected, holdout };
  });

  const selected = results.filter(r => r.selected);
  const confirmed = selected.filter(r => r.holdout!.avgBps > 0 && r.holdout!.t >= 1.5 && r.holdout!.coinsPositive >= 2 && r.holdout!.trades >= 50);
  const fam = (f: string) => results.filter(r => r.family === f);
  const best = (f: string) => [...fam(f)].sort((a, b) => b.valid.avgBps - a.valid.avgBps)[0];

  const row = (r: (typeof results)[number]) =>
    `| ${r.label} | ${r.train.trades} | ${r.train.avgBps.toFixed(1)} | ${r.valid.avgBps.toFixed(1)} | ${r.holdout ? `**${r.holdout.avgBps.toFixed(1)}**` : 'n/a'} | ${r.holdout ? r.holdout.t.toFixed(1) : ''} | ${r.holdout ? `${r.holdout.sumPct >= 0 ? '+' : ''}${(r.holdout.sumPct / ((end - VALID_END) / 31_557_600_000)).toFixed(0)}%` : ''} | ${r.holdout ? r.holdout.trades : ''} |`;
  const head = '| Configuration | Trades (train) | Avg net bps: train | validate | holdout | t-stat holdout | Holdout return / yr at 1x | Holdout trades |\n|---|---|---|---|---|---|---|---|';

  const md = `# Scalping strategy search (15-minute data)

Generated by \`npm run backtest:scalp\` from Binance 15-minute candles for ${COINS.join(', ')}, 2020-01-01 → ${lastDate}. Do not edit by hand.

## Protocol

- **${results.length} configurations** across five families were tested.
- A configuration is **selected** only if, in both 2020–2022 and 2023–2024, it had at least 100 trades, averaged at least 3 bps per trade after costs, had a t-statistic of at least 2, and made money on at least two coins.
- Selected configurations were then run **once** on the holdout, 2025-01-01 → ${lastDate}, which played no part in choosing them. A configuration is **confirmed** if it still averaged above zero there with a t-statistic of at least 1.5 on at least two coins.
- Costs: 0.015% for resting orders (which must be traded *through* by 0.02% to count as filled), 0.065% for market orders, extra slippage on stops. When a bar could have hit both the stop and the target, the stop is counted.

## Result

| Family | Tested | Selected (passed train + validate) | Confirmed on holdout |
|---|---|---|---|
| Resting-order fade ("buy the wick") | ${fam('fade').length} | ${selected.filter(r => r.family === 'fade').length} | ${confirmed.filter(r => r.family === 'fade').length} |
| 15-minute breakout (market orders) | ${fam('breakout').length} | ${selected.filter(r => r.family === 'breakout').length} | ${confirmed.filter(r => r.family === 'breakout').length} |
| BTC lead-lag into ETH/SOL | ${fam('leadlag').length} | ${selected.filter(r => r.family === 'leadlag').length} | ${confirmed.filter(r => r.family === 'leadlag').length} |
| Pairs trading (ETH/BTC, SOL/BTC, SOL/ETH) | ${fam('pairs').length} | ${selected.filter(r => r.family === 'pairs').length} | ${confirmed.filter(r => r.family === 'pairs').length} |
| Failed breakdown / stop-run reversal | ${fam('trap').length} | ${selected.filter(r => r.family === 'trap').length} | ${confirmed.filter(r => r.family === 'trap').length} |

${selected.length ? `## Selected configurations and their holdout results\n\n${head}\n${selected.sort((a, b) => b.holdout!.avgBps - a.holdout!.avgBps).map(row).join('\n')}` : '## No configuration passed both the training and validation periods.'}

## Is it the fees?

Rerun with \`FEE_SCENARIO=free npm run backtest:scalp\` (no fees or slippage at all) or \`FEE_SCENARIO=top\` (Hyperliquid's highest
volume tier). Neither is written to this file. At the time of writing, both also selected nothing: these rules have no
dependable edge on 15-minute candles even before costs, so cheaper execution alone would not rescue them.

\`SELFTEST=1 npm run backtest:scalp\` adds a rule that cheats by looking one bar ahead; it passes every stage, which shows the
search can recognise an edge when one exists.

## What this does and does not show

It shows that the scalping setups retail traders usually mean (fading wicks, short breakouts, stop-run reversals, following BTC,
pairs) did not work on ${COINS.join(', ')} from candles alone. It does not show that no short-term edge exists. The firms that
profit at this horizon do it with things this platform does not have: order-book and trade-by-trade data, queue priority,
co-located servers reacting in milliseconds, and fee rebates. Those are infrastructure advantages, not chart patterns.

To test an idea of your own, add a function beside the existing families in \`backtest/scalp-search.ts\` and rerun.

## Best of each family by validation period (for context; not selected unless listed above)

${head}
${['fade', 'breakout', 'leadlag', 'pairs', 'trap'].map(f => row(best(f))).join('\n')}
`;
  if (SCENARIO !== 'base' || process.env.SELFTEST) {
    console.log(`[${SCENARIO} fees] selected ${selected.length}, confirmed on holdout ${confirmed.length} of ${results.length}`);
    for (const r of confirmed.sort((a, b) => b.holdout!.avgBps - a.holdout!.avgBps).slice(0, 8)) console.log('  ', r.label, '| holdout bps', r.holdout!.avgBps.toFixed(1), 't', r.holdout!.t.toFixed(1), 'trades', r.holdout!.trades);
    return;
  }
  writeFileSync(join(process.cwd(), 'backtest', 'SCALPING.md'), md);
  writeFileSync(join(process.cwd(), 'lib', 'autopilot', 'scalp-evidence.json'), JSON.stringify({
    generatedThrough: lastDate, tested: results.length,
    confirmed: confirmed.map(r => ({ family: r.family, cfg: r.cfg, label: r.label, train: r.train, valid: r.valid, holdout: r.holdout })),
  }, null, 2) + '\n');
  console.log(md.split('## Result')[1]);
}

main().catch(e => { console.error(e); process.exit(1); });
