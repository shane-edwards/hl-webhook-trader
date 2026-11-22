// Does the evidence hold beyond three coins, and do cross-coin strategies work?
//   npm run backtest:universe
//
// Universe: the large coins of mid-2020, fixed in advance and including ones
// that later did badly (EOS, NEO, DASH, IOTA...), so the result is not built
// only from winners. Protocol as in scalp-search.ts:
//   TRAIN 2020-07 → 2022-12, VALIDATE 2023 → 2024, HOLDOUT 2025 → today.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from '../lib/autopilot/strategies';

const DIR = join(process.cwd(), 'backtest', 'data', 'intraday');
const UNIVERSE = ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'BNB', 'EOS', 'XLM', 'ADA', 'TRX', 'LINK', 'XTZ', 'ATOM', 'ETC', 'DOGE', 'DASH', 'ZEC', 'NEO', 'IOTA', 'VET', 'ALGO', 'SOL'];
const T0 = Date.UTC(2020, 6, 1), TRAIN_END = Date.UTC(2023, 0, 1), VALID_END = Date.UTC(2025, 0, 1);
const COST = 0.00065, STOP_SLIP = 0.0005, FUNDING_PER_HOUR = 0.0003 / 24;
const HOUR = 3_600_000, YEAR_H = 8760;

async function hourly(coin: string): Promise<Bar[] | null> {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${coin.toLowerCase()}-1h.csv`);
  if (!existsSync(file)) {
    const rows: number[][] = [];
    let startTime = Date.UTC(2020, 0, 1);
    for (;;) {
      const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=1h&limit=1000&startTime=${startTime}`);
      if (!res.ok) return null;
      const page = (await res.json()) as Array<[number, string, string, string, string]>;
      if (!page.length) break;
      for (const k of page) rows.push([k[0], +k[1], +k[2], +k[3], +k[4]]);
      if (page.length < 1000) break;
      startTime = page[page.length - 1][0] + HOUR;
    }
    rows.pop();
    if (rows.length < 20_000) return null;
    writeFileSync(file, rows.map(r => r.join(',')).join('\n') + '\n');
  }
  return readFileSync(file, 'utf8').trim().split('\n').map(l => { const [t, o, h, lo, c] = l.split(',').map(Number); return { t, o, h, l: lo, c }; });
}

/** Hourly net return series (by bar time) of one autopilot strategy on one coin at 1x. Same rules as backtest/autopilot.ts. */
function strategyReturns(bars: Bar[], id: string): Map<number, number> {
  const s = getStrategy(id)!;
  const ind = computeIndicators(bars);
  const out = new Map<number, number>();
  let pos: -1 | 0 | 1 = 0, entry = 0, stop = 0, held = 0;
  for (let i = WARMUP_BARS; i < bars.length; i++) {
    const b = bars[i];
    let r = 0;
    const sig = s.evaluate(ind, bars, i - 1, pos, false);
    const wasOpen = pos !== 0;
    if (wasOpen && sig.target !== pos) { r += pos * (b.o / bars[i - 1].c - 1) - COST; pos = 0; held = 0; }
    if (pos === 0 && !wasOpen && sig.target !== 0) { pos = sig.target; entry = b.o; stop = entry * (1 - pos * sig.stopPct); held = 0; r -= COST; }
    if (pos !== 0) {
      const ref = held === 0 ? entry : bars[i - 1].c;
      if (pos === 1 ? b.l <= stop : b.h >= stop) {
        const px = pos === 1 ? Math.min(stop, b.o) : Math.max(stop, b.o);
        r += pos * (px / ref - 1) - COST - STOP_SLIP; pos = 0; held = 0;
      } else { r += pos * (b.c / ref - 1) - pos * FUNDING_PER_HOUR; held += 1; }
    }
    out.set(b.t, r);
  }
  return out;
}

interface Stat { annual: number; sharpe: number; maxDd: number }
function stat(times: number[], rets: number[], from: number, to: number, periodsPerYear: number): Stat {
  let eq = 1, peak = 1, maxDd = 0, sum = 0, sumSq = 0, n = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] < from || times[i] >= to) continue;
    eq *= 1 + rets[i]; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
    sum += rets[i]; sumSq += rets[i] ** 2; n += 1;
  }
  if (n < 10) return { annual: 0, sharpe: 0, maxDd: 0 };
  const mean = sum / n, sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 1e-18));
  return { annual: eq ** (periodsPerYear / n) - 1, sharpe: (mean / sd) * Math.sqrt(periodsPerYear), maxDd };
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const cell = (s: Stat) => `${pct(s.annual)} (${s.sharpe.toFixed(2)})`;

async function main() {
  const data = new Map<string, Bar[]>();
  for (const c of UNIVERSE) { const b = await hourly(c); if (b) data.set(c, b); }
  const coins = [...data.keys()];
  const end = data.get('BTC')!.at(-1)!.t + 1;
  const lastDate = new Date(end).toISOString().slice(0, 10);

  // ------------------------------------------------------------------
  // Study 1: the live-eligible strategy (trend breakout, long only) on every coin
  // ------------------------------------------------------------------
  const perCoin = new Map(coins.map(c => [c, strategyReturns(data.get(c)!, 'trend_breakout')] as const));
  const times = [...perCoin.get('BTC')!.keys()].filter(t => t >= T0);
  const portfolio = (subset: string[]) => times.map(t => {
    // Equal capital per coin; a coin without data at that hour sits in cash.
    let s = 0; for (const c of subset) s += perCoin.get(c)!.get(t) ?? 0;
    return s / subset.length;
  });
  const three = portfolio(['BTC', 'ETH', 'SOL'].filter(c => perCoin.has(c)));
  const all = portfolio(coins);
  const row1 = (name: string, r: number[]) => `| ${name} | ${cell(stat(times, r, T0, TRAIN_END, YEAR_H))} | ${cell(stat(times, r, TRAIN_END, VALID_END, YEAR_H))} | **${cell(stat(times, r, VALID_END, end, YEAR_H))}** | -${(stat(times, r, T0, end, YEAR_H).maxDd * 100).toFixed(0)}% |`;
  const coinRows = coins.map(c => {
    const r = times.map(t => perCoin.get(c)!.get(t) ?? 0);
    return { c, hold: stat(times, r, VALID_END, end, YEAR_H), full: stat(times, r, T0, end, YEAR_H) };
  });
  const positiveHoldout = coinRows.filter(x => x.hold.annual > 0).length;
  const positiveFull = coinRows.filter(x => x.full.annual > 0).length;

  // ------------------------------------------------------------------
  // Study 2: ranking coins against each other (daily closes, weekly rebalance)
  // ------------------------------------------------------------------
  const DAY = 24 * HOUR;
  const days: number[] = []; for (let t = Date.UTC(2020, 0, 1); t < end - DAY; t += DAY) days.push(t);
  const closeAt = new Map(coins.map(c => { const m = new Map<number, number>(); for (const b of data.get(c)!) if ((b.t + HOUR) % DAY === 0) m.set(b.t + HOUR - DAY, b.c); return [c, m] as const; }));
  const px = (c: string, d: number) => closeAt.get(c)!.get(days[d]);

  function crossSection(look: number, mode: 'momentum' | 'reversal', longShort: boolean, hold = 7): { t: number[]; r: number[] } {
    const t: number[] = [], r: number[] = [];
    let longs: string[] = [], shorts: string[] = [];
    for (let d = Math.max(look, 1); d < days.length - 1; d++) {
      let cost = 0;
      if ((d - look) % hold === 0) {
        const ranked = coins.map(c => ({ c, a: px(c, d), b: px(c, d - look) })).filter(x => x.a && x.b).map(x => ({ c: x.c, ret: x.a! / x.b! - 1 })).sort((x, y) => y.ret - x.ret);
        const k = Math.max(2, Math.floor(ranked.length / 4));
        const top = ranked.slice(0, k).map(x => x.c), bottom = ranked.slice(-k).map(x => x.c);
        const nl = mode === 'momentum' ? top : bottom, ns = longShort ? (mode === 'momentum' ? bottom : top) : [];
        // Cost on the share of the book that changes hands.
        const turned = nl.filter(c => !longs.includes(c)).length / k + (longShort ? ns.filter(c => !shorts.includes(c)).length / k : 0);
        cost = (turned * 2 * COST) / (longShort ? 2 : 1);
        longs = nl; shorts = ns;
      }
      const leg = (xs: string[]) => { let s = 0, n = 0; for (const c of xs) { const a = px(c, d), b = px(c, d + 1); if (a && b) { s += b / a - 1; n += 1; } } return n ? s / n : 0; };
      // Long/short: half the capital each side. Longs pay funding, shorts receive it.
      const gross = longShort ? 0.5 * leg(longs) - 0.5 * leg(shorts) : leg(longs) - 0.0003;
      t.push(days[d + 1]); r.push(gross - cost);
    }
    return { t, r };
  }

  const xs: Array<{ label: string; t: number[]; r: number[] }> = [];
  for (const look of [7, 14, 30, 60, 90]) for (const ls of [true, false]) xs.push({ label: `Momentum: buy the strongest quarter over ${look} days${ls ? ', short the weakest' : ''}`, ...crossSection(look, 'momentum', ls) });
  for (const look of [1, 3, 7]) for (const ls of [true, false]) xs.push({ label: `Reversal: buy the weakest quarter over ${look} day${look > 1 ? 's' : ''}${ls ? ', short the strongest' : ''}`, ...crossSection(look, 'reversal', ls, look === 1 ? 1 : 7) });
  const evald = xs.map(x => {
    const train = stat(x.t, x.r, T0, TRAIN_END, 365), valid = stat(x.t, x.r, TRAIN_END, VALID_END, 365);
    const selected = train.sharpe >= 0.5 && valid.sharpe >= 0.5;
    return { ...x, train, valid, selected, holdout: selected ? stat(x.t, x.r, VALID_END, end, 365) : null };
  });
  const sel = evald.filter(e => e.selected);
  const conf = sel.filter(e => e.holdout!.sharpe >= 0.3 && e.holdout!.annual > 0);
  const row2 = (e: (typeof evald)[number]) => `| ${e.label} | ${cell(e.train)} | ${cell(e.valid)} | ${e.holdout ? `**${cell(e.holdout)}**` : 'not selected'} |`;

  const md = `# Wider universe and cross-coin strategies

Generated by \`npm run backtest:universe\` through ${lastDate}. Do not edit by hand. Figures are **return per year (Sharpe ratio)** at 1x after
fees, slippage and funding.

Universe: ${coins.length} coins that were large in mid-2020, chosen in advance and including several that later fell out of favour:
${coins.join(', ')}. Periods: train 2020-07 → 2022, validate 2023 → 2024, holdout 2025 → ${lastDate}.

## Study 1: does the live strategy (trend breakout, long only) hold up on coins it was not built on?

| Portfolio, equal capital per coin | Train | Validate | Holdout | Worst drawdown, whole period |
|---|---|---|---|---|
${row1('BTC, ETH, SOL (the original three)', three)}
${row1(`All ${coins.length} coins`, all)}

Coin by coin: profitable on **${positiveFull} of ${coins.length}** over the whole period and **${positiveHoldout} of ${coins.length}** in the holdout.
Holdout by coin: ${coinRows.map(x => `${x.c} ${pct(x.hold.annual)}`).join(', ')}.

## Study 2: ranking coins against each other

Weekly rebalance on daily closes (the 1-day reversal rebalances daily). ${evald.length} configurations; selected if Sharpe is at least 0.5 in both
train and validate; confirmed if the holdout Sharpe is at least 0.3 with a positive return.

**Selected: ${sel.length} of ${evald.length}. Confirmed on holdout: ${conf.length}.**

| Configuration | Train | Validate | Holdout |
|---|---|---|---|
${evald.map(row2).join('\n')}
`;
  const mom = evald.find(e => e.label.startsWith('Momentum: buy the strongest quarter over 90 days, short'))!;
  const since2023 = stat(mom.t, mom.r, TRAIN_END, end, 365);
  writeFileSync(join(process.cwd(), 'lib', 'autopilot', 'momentum-evidence.json'), JSON.stringify({
    generatedThrough: lastDate, configurationsTested: evald.length, confirmedOnHoldout: conf.length,
    early: { annualReturn: mom.train.annual },
    late: { annualReturn: since2023.annual, sharpe: since2023.sharpe, maxDrawdown: since2023.maxDd, avgNetBps: null },
    recent: { annualReturn: stat(mom.t, mom.r, VALID_END, end, 365).annual },
  }, null, 2) + '\n');
  writeFileSync(join(process.cwd(), 'backtest', 'UNIVERSE.md'), md);
  console.log(md.split('## Study 1')[1]);
}

main().catch(e => { console.error(e); process.exit(1); });
