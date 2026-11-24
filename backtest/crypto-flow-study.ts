import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_MARKETS, END, FRAME, cryptoFlow, type FlowBar } from './crypto-flow-data';
import { DAY, perpFunding, type Funding } from './price-action-data';

const windows = [{ from: Date.UTC(2024, 2, 1), to: Date.UTC(2025, 0, 1) },
  { from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) }, { from: Date.UTC(2026, 0, 1), to: END }];
const costs = [{ fill: .00085, gap: .0003 }, { fill: .0015, gap: .0007 }];
type Side = 1 | -1;
type Family = 'aligned-flow' | 'perp-crowding' | 'absorption' | 'spot-lead';
const families: Family[] = ['aligned-flow', 'perp-crowding', 'absorption', 'spot-lead'];
type Rule = { family: Family; side: Side; pressure: number; volume: number; hold: number; horizon: 'intraday' | 'swing' };
type Row = Awaited<ReturnType<typeof cryptoFlow>>[number];
type Mark = { t: number; value: number };
const pressure = (bar: FlowBar) => 2 * bar.aggressive / bar.volume - 1;

function mean(values: number[], period: number) {
  let sum = 0;
  return values.map((value, i) => {
    sum += value - (i >= period ? values[i - period] : 0);
    return sum / Math.min(i + 1, period);
  });
}

function features(rows: Row[], funding: Funding[]) {
  const byTimestamp = new Map(funding.map(row => [row.time, row.rate]));
  const typical = (i: number) => {
    const bar = rows[i].perp, prior = rows[i - 1]?.perp.c ?? bar.o;
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prior), Math.abs(bar.l - prior)) / bar.c;
  };
  const volume = rows.map(row => row.spot.volume);
  const dailyFlow = mean(rows.map(row => pressure(row.spot)), 96 * 3);
  const dailyPerp = mean(rows.map(row => pressure(row.perp)), 96 * 3);
  return { rows, funding: byTimestamp, variation: mean(rows.map((_, i) => typical(i)), 64), relativeVolume: mean(volume, 96),
    dailyFlow, dailyPerp, average20d: mean(rows.map(row => row.spot.c), 96 * 20) };
}
type Features = ReturnType<typeof features>;

function signals(input: Features, rule: Rule) {
  const { rows, dailyFlow, dailyPerp, relativeVolume, variation, average20d } = input;
  const out: number[] = [];
  for (let i = 1920; i < rows.length - 1; i++) {
    const bar = rows[i], before = rows[i - 1];
    if (rows[i + 1].t - bar.t !== FRAME || bar.t - before.t !== FRAME) continue;
    if (rule.horizon === 'swing' && (bar.t + FRAME) % DAY !== 0) continue;
    const b = rule.side;
    const spot = b * (rule.horizon === 'swing' ? dailyFlow[i] : pressure(bar.spot));
    const perp = b * (rule.horizon === 'swing' ? dailyPerp[i] : pressure(bar.perp));
    const move = b * Math.log(bar.perp.c / bar.perp.o);
    const split = b * (Math.log(bar.spot.c / bar.spot.o) - Math.log(bar.perp.c / bar.perp.o));
    if (bar.spot.volume / relativeVolume[i - 1] < rule.volume) continue;
    const dayTrend = b * (bar.spot.c / average20d[i - 1] - 1);
    let match: boolean;
    if (rule.horizon === 'swing') {
      const move3Days = b * (bar.spot.c / rows[i - 288].spot.c - 1);
      match = rule.family === 'aligned-flow' ? spot >= rule.pressure && perp > 0 && dayTrend >= .01 :
        rule.family === 'spot-lead' ? spot >= rule.pressure && spot - perp >= .02 && dayTrend > 0 :
        rule.family === 'perp-crowding' ? perp <= -rule.pressure && spot >= 0 && move3Days <= -.025 && move > 0 :
        spot > 0 && perp <= -rule.pressure && dayTrend > 0 && move3Days < 0;
    } else {
      const wick = b === 1 ? bar.perp.l < before.perp.l : bar.perp.h > before.perp.h;
      match = rule.family === 'aligned-flow' ? spot >= rule.pressure && perp >= rule.pressure && move >= .6 * variation[i - 1] :
        rule.family === 'perp-crowding' ? perp <= -rule.pressure && spot >= 0 && move <= -.8 * variation[i - 1] :
        rule.family === 'absorption' ? perp <= -rule.pressure && spot >= 0 && wick && move > .15 * variation[i - 1] :
        spot >= rule.pressure && spot - perp >= rule.pressure && split >= .2 * variation[i - 1];
    }
    if (match) out.push(i);
  }
  return out;
}

function simulate(input: Features, triggers: number[], rule: Rule, window: typeof windows[number], fee: typeof costs[number]) {
  const trades: Mark[] = [], marks: Mark[] = [];
  let next = 0, held = 0, equity = 1;
  for (const i of triggers) {
    const bar = input.rows[i + 1], b = rule.side;
    if (i < next || bar.t < window.from) continue;
    if (bar.t + rule.hold * FRAME >= window.to) break;
    if (!input.rows[i + rule.hold + 1]) break;
    const entry = bar.perp.o * (1 + b * fee.fill);
    const entryCapital = equity;
    if (entryCapital <= 0) break;
    const distance = rule.horizon === 'swing' ? Math.max(.025, Math.min(.12, 12 * input.variation[i])) :
      Math.max(.0025, Math.min(.025, 2.2 * input.variation[i]));
    const stop = entry * (1 - b * distance), target = entry * (1 + b * 2.5 * distance);
    let dailyFund = 0, lastMark = 0;
    for (let j = i + 1; j <= i + rule.hold + 1; j++) {
      const row = input.rows[j], market = row.perp;
      const gap = row.t - input.rows[j - 1].t !== FRAME;
      const deadline = j === i + rule.hold + 1 || gap;
      if (j > i + 1) dailyFund -= b * (input.funding.get(row.t) ?? 0) * market.o / entry;
      const stopped = !deadline && (b === 1 ? market.l <= stop : market.h >= stop);
      const reached = !deadline && (b === 1 ? market.h >= target : market.l <= target);
      const exit = deadline || stopped || reached;
      const price = deadline ? market.o : stopped ? (b === 1 ? Math.min(stop, market.o) : Math.max(stop, market.o)) :
        reached ? target : market.c;
      const current = b * (price * (1 - b * (fee.fill + (stopped || gap ? fee.gap : 0))) / entry - 1) + dailyFund;
      // Mark net liquidation value, then contribute only the change since the previous bar.
      const change = entryCapital * (current - lastMark);
      equity += change;
      marks.push({ t: row.t, value: change });
      lastMark = current;
      if (exit) {
        trades.push({ t: row.t, value: current });
        held += j - i;
        next = j;
        break;
      }
    }
  }
  return { trades, marks, held };
}

function summarize(input: ReturnType<typeof simulate>[], window: typeof windows[number]) {
  const days = Math.ceil((window.to - window.from) / DAY);
  const calendar = new Float64Array(days);
  const marks = new Map<number, number>();
  for (const market of input) for (const row of market.marks) marks.set(row.t, (marks.get(row.t) ?? 0) + row.value / input.length);
  let equity = 1, peak = 1, drawdown = 0;
  for (const [time, value] of [...marks].sort(([a], [b]) => a - b)) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    const d = Math.floor((time - window.from) / DAY);
    if (d >= 0 && d < days) calendar[d] += value;
  }
  const weeks = new Float64Array(Math.ceil(days / 7));
  for (const [i, value] of calendar.entries()) weeks[Math.floor(i / 7)] += value;
  const m = weeks.reduce((a, b) => a + b, 0) / weeks.length;
  const noise = Math.sqrt(weeks.reduce((sum, n) => sum + (n - m) ** 2, 0) / (weeks.length - 1) / weeks.length);
  const pnl = (market: typeof input[number]) => market.trades.reduce((sum, position) => sum + position.value, 0);
  const trades = input.reduce((sum, market) => sum + market.trades.length, 0);
  return { net: equity - 1, drawdown, trades, activeDays: calendar.filter(value => value !== 0).length,
    positiveMarkets: input.filter(market => pnl(market) > 0).length, score: noise > 0 ? m / noise : 0,
    averageBps: trades ? input.reduce((sum, market) => sum + pnl(market), 0) * 1e4 / trades : null,
    exposure: input.reduce((sum, market) => sum + market.held, 0) / (input.length * (window.to - window.from) / FRAME) };
}

function research(input: Features[], horizon: Rule['horizon']) {
  const counts = { tested: 0, qualifiedEarly: 0 };
  type Result = ReturnType<typeof summarize>;
  type Evaluation = { rule: Rule; discovery: Result; validation: Result; rank: number };
  const winners: (Evaluation & { holdout: Result; stressed: Result; holdoutPositive: boolean })[] = [];
  const diagnostics: Evaluation[] = [];
  for (const family of families) for (const side of [1, -1] as const) {
    let winner: Evaluation | null = null, best: Evaluation | null = null;
    for (const pressure of horizon === 'intraday' ? [.10, .20, .30] : [.02, .04, .06]) {
      for (const volume of [1, 1.6]) for (const hold of horizon === 'intraday' ? [4, 12, 24] : [192, 480, 672]) {
        counts.tested++;
        const rule = { family, side, pressure, volume, hold, horizon };
        const triggers = input.map(market => signals(market, rule));
        const stats = (i: number, expense: number) => summarize(input.map((market, j) =>
          simulate(market, triggers[j], rule, windows[i], costs[expense])), windows[i]);
        const discovery = stats(0, 0), validation = stats(1, 1), rank = Math.min(discovery.score, validation.score);
        if (!best || rank > best.rank) best = { rule, discovery, validation, rank };
        const floor = horizon === 'intraday' ? 100 : 24;
        if (rank < 1.2 || [discovery, validation].some(result => result.net <= 0 || result.trades < floor ||
          result.activeDays < 22 || result.positiveMarkets < 2 || result.drawdown > .24)) continue;
        counts.qualifiedEarly++;
        if (!winner || rank > winner.rank) winner = { rule, discovery, validation, rank };
      }
    }
    if (best) diagnostics.push(best);
    if (!winner) continue;
    const candidate = winner.rule;
    const out = (expense: number) => summarize(input.map(market =>
      simulate(market, signals(market, candidate), candidate, windows[2], costs[expense])), windows[2]);
    const holdout = out(0), stressed = out(1);
    winners.push({ ...winner, holdout, stressed, holdoutPositive: stressed.score >= 2.3 && stressed.net > 0 &&
      holdout.net > 0 && stressed.positiveMarkets >= 2 && stressed.trades >= (horizon === 'intraday' ? 100 : 24) && stressed.drawdown <= .24 });
  }
  return { ...counts, winners, bestEarlier: diagnostics.sort((a, b) => b.rank - a.rank).slice(0, 3) };
}

async function main() {
  const input = await Promise.all(FLOW_MARKETS.map(async symbol => features(await cryptoFlow(symbol), await perpFunding(symbol))));
  const result = { markets: FLOW_MARKETS, rows: input.map(data => data.rows.length), costs, campaign: 'Binance paired 15-minute spot and USD-M perpetuals, with actual funding',
    periods: windows.map(window => Object.values(window).map(value => new Date(value).toISOString().slice(0, 10))),
    intraday: research(input, 'intraday'), swing: research(input, 'swing') };
  writeFileSync(join(process.cwd(), 'backtest', 'crypto-flow-results.json'), JSON.stringify(result, null, 2) + '\n');
  for (const horizon of ['intraday', 'swing'] as const) {
    const summary = result[horizon];
    console.log(JSON.stringify({ horizon, tried: summary.tested, selected: summary.qualifiedEarly,
      later: summary.winners.map(x => ({ rule: x.rule, holdout: x.holdout.net, stressed: x.stressed.net, trades: x.stressed.trades, passed: x.holdoutPositive })),
      bestEarlier: summary.bestEarlier.map(x => ({ rule: x.rule, earlier: x.discovery.net, validation: x.validation.net, score: x.rank })) }));
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
