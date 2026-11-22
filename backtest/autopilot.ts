// Evidence for the Autopilot strategies:  npm run backtest:autopilot
// Runs each rule in lib/autopilot/strategies.ts on hourly BTC/ETH/SOL with
// stops, fees, slippage and funding, split into 2020–2022 and 2023+.
// Writes lib/autopilot/evidence.json (read by the app, and the gate that
// decides which strategies may trade live) and backtest/AUTOPILOT.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRealFunding } from './data';
import { computeIndicators, STRATEGIES, WARMUP_BARS, type Bar, type StrategyDef } from '../lib/autopilot/strategies';

const COINS = ['BTC', 'ETH', 'SOL'];
const SPLIT = '2023-01-01';
const COST = 0.00045 + 0.0002; // taker fee + slippage per fill
const STOP_SLIPPAGE = 0.0005; // stops fill worse than their trigger
const HOURS_PER_YEAR = 8760;

function loadHourly(coin: string): Bar[] {
  const file = join(process.cwd(), 'backtest', 'data', 'intraday', `${coin.toLowerCase()}-1h.csv`);
  if (!existsSync(file)) throw new Error(`Missing ${file}. Run "npm run backtest:intraday" first to download hourly data.`);
  return readFileSync(file, 'utf8').trim().split('\n').map(l => { const [t, o, h, lo, c] = l.split(',').map(Number); return { t, o, h, l: lo, c }; });
}

interface Trade { net: number; gross: number; date: string }
interface Run { trades: Trade[]; hourly: Array<{ date: string; r: number }> }

/** 1x notional per position. Signal from bar i-1, executed at the open of bar i. */
function simulate(bars: Bar[], s: StrategyDef, allowShort: boolean, funding: Map<string, number>): Run {
  const ind = computeIndicators(bars);
  let pos: -1 | 0 | 1 = 0, entry = 0, stop = 0, held = 0, tradeNet = 0, tradeGross = 0;
  const trades: Trade[] = [];
  const hourly: Run['hourly'] = [];
  for (let i = WARMUP_BARS; i < bars.length; i++) {
    const b = bars[i];
    const date = new Date(b.t).toISOString().slice(0, 10);
    let r = 0;
    const close = (px: number, extraCost = 0) => {
      const g = pos * (px / entry - 1);
      const move = pos * (px / (held === 0 ? entry : bars[i - 1].c) - 1);
      r += move - COST - extraCost; tradeGross = g; tradeNet += move - COST - extraCost;
      trades.push({ net: tradeNet, gross: tradeGross, date });
      pos = 0; tradeNet = 0; held = 0;
    };

    const sig = s.evaluate(ind, bars, i - 1, pos, allowShort);
    // A position that was just closed is not re-opened on the same bar: its "hold" signal is not a fresh setup.
    const wasOpen = pos !== 0;
    if (wasOpen && (sig.target !== pos || (s.maxHoldHours > 0 && held >= s.maxHoldHours))) close(b.o);
    if (pos === 0 && !wasOpen && sig.target !== 0) {
      pos = sig.target; entry = b.o; stop = entry * (1 - pos * sig.stopPct); held = 0;
      r -= COST; tradeNet = -COST;
    }
    if (pos !== 0) {
      const ref = held === 0 ? entry : bars[i - 1].c;
      const hit = pos === 1 ? b.l <= stop : b.h >= stop;
      if (hit) {
        // A gap through the stop fills at the open, not at the stop.
        const px = pos === 1 ? Math.min(stop, b.o) : Math.max(stop, b.o);
        const g = pos * (px / entry - 1), move = pos * (px / ref - 1);
        r += move - COST - STOP_SLIPPAGE; tradeNet += move - COST - STOP_SLIPPAGE;
        trades.push({ net: tradeNet, gross: g, date });
        pos = 0; tradeNet = 0; held = 0;
      } else {
        const move = pos * (b.c / ref - 1), fund = (pos * (funding.get(date) ?? 0.0003)) / 24;
        r += move - fund; tradeNet += move - fund; held += 1;
      }
    }
    hourly.push({ date, r });
  }
  return { trades, hourly };
}

function stats(runs: Run[], from: string, to: string) {
  // Equal capital per coin: average the hourly returns across coins.
  const n = Math.min(...runs.map(r => r.hourly.length));
  let eq = 1, peak = 1, maxDd = 0, sum = 0, sumSq = 0, hours = 0;
  for (let k = 0; k < n; k++) {
    const date = runs[0].hourly[runs[0].hourly.length - n + k].date;
    if (date < from || date >= to) continue;
    const r = runs.reduce((a, run) => a + run.hourly[run.hourly.length - n + k].r, 0) / runs.length;
    eq *= 1 + r; peak = Math.max(peak, eq); maxDd = Math.max(maxDd, 1 - eq / peak);
    sum += r; sumSq += r * r; hours += 1;
  }
  const trades = runs.flatMap(r => r.trades).filter(t => t.date >= from && t.date < to);
  const years = hours / HOURS_PER_YEAR;
  const mean = sum / hours, sd = Math.sqrt(Math.max(sumSq / hours - mean * mean, 1e-18));
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const grossWin = wins.reduce((a, t) => a + t.net, 0), grossLoss = -losses.reduce((a, t) => a + t.net, 0);
  return {
    annualReturn: eq ** (1 / years) - 1,
    sharpe: (mean / sd) * Math.sqrt(HOURS_PER_YEAR),
    maxDrawdown: maxDd,
    tradesPerYear: trades.length / years / runs.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgGrossBps: trades.length ? (trades.reduce((a, t) => a + t.gross, 0) / trades.length) * 1e4 : 0,
    avgNetBps: trades.length ? (trades.reduce((a, t) => a + t.net, 0) / trades.length) * 1e4 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : 0,
    trades: trades.length,
  };
}

const data = new Map(COINS.map(c => [c, loadHourly(c)] as const));
const last = new Date(data.get('BTC')!.at(-1)!.t).toISOString().slice(0, 10);

const evidence = STRATEGIES.flatMap(s =>
  [false, true].map(allowShort => {
    const runs = COINS.map(c => simulate(data.get(c)!, s, allowShort, loadRealFunding(c)));
    const early = stats(runs, '2020-01-01', SPLIT);
    const late = stats(runs, SPLIT, '2100-01-01');
    // The gate: profitable in BOTH halves, and each trade earns well above its cost.
    const gatePassed = early.annualReturn > 0 && late.annualReturn > 0 && late.avgNetBps > 15 && late.profitFactor > 1.1;
    const liveEligible = gatePassed && !s.paperOnly;
    // Shown separately because it is the most recent stretch and was not used to design the rules.
    const recent = stats(runs, '2025-01-01', '2100-01-01');
    return { id: s.id, allowShort, liveEligible, gatePassed, early, late, recent };
  })
);

writeFileSync(
  join(process.cwd(), 'lib', 'autopilot', 'evidence.json'),
  JSON.stringify({ generatedThrough: last, coins: COINS, splitDate: SPLIT, strategies: evidence }, null, 2) + '\n'
);

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const rows = evidence.map(e => {
  const s = STRATEGIES.find(x => x.id === e.id)!;
  return `| ${s.name} | ${e.allowShort ? 'Long & short' : 'Long only'} | ${e.late.tradesPerYear.toFixed(0)} | ${pct(e.late.winRate)} | ${e.late.avgGrossBps.toFixed(0)} | ${e.late.avgNetBps.toFixed(0)} | ${pct(e.early.annualReturn)} | **${pct(e.late.annualReturn)}** | ${pct(e.recent.annualReturn)} | ${e.late.sharpe.toFixed(2)} | -${(e.late.maxDrawdown * 100).toFixed(0)}% | ${e.liveEligible ? '**Yes**' : e.gatePassed ? 'Paper only (passed the gate; on probation)' : 'Paper only'} |`;
});

writeFileSync(join(process.cwd(), 'backtest', 'AUTOPILOT.md'), `# Autopilot strategy evidence

Generated by \`npm run backtest:autopilot\` from hourly ${COINS.join(', ')} candles through ${last}. Do not edit by hand.

Each rule runs at 1x with equal capital per coin, an exchange-style stop on every position, 0.065% cost per fill,
extra slippage on stops, and funding. Settings are the first ones chosen; nothing was tuned.

| Strategy | Direction | Trades / coin / yr | Win rate | Avg trade before costs (bps) | Avg trade after costs (bps) | Return / yr 2020–2022 | Return / yr 2023+ | of which 2025+ | Sharpe 2023+ | Worst drawdown 2023+ | Allowed to trade live |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## The live gate

A strategy may trade real money only if it made money in **both** periods, its average trade since 2023 cleared
costs by more than 15 basis points, and its wins outweighed its losses by at least 10%. Everything else can only
run in paper mode. The gate is re-evaluated whenever this report is regenerated.

**The most recent period is weak.** The one eligible strategy made most of its 2023+ return in 2023–2024 and was roughly flat from 2025 on, when the market fell. On a wider set of 22 coins it was profitable on fewer than half of them (see UNIVERSE.md). Treat it as a way to hold trends with controlled risk, not as a dependable income.

**Probation.** A rule that was picked after its recent results were already known (MACD trend) stays paper-only even though it passes: its backtest is no longer an independent test. It earns live status with a paper track record, not a backtest.

Passing the gate is not a promise. It means the rule was not obviously broken on ${COINS.length} coins over this
period. Six variants were tested, so one passing by luck alone would not be surprising.
`);
console.log(rows.join('\n'));
