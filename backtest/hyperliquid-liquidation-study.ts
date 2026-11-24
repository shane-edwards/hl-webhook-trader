import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY, HOUR, perpFunding } from './price-action-data';
import { cryptoFlow, FLOW_MARKETS, FRAME } from './crypto-flow-data';
import { replay, summarize, type Side, type Trigger, type Window } from './crypto-research-replay';

const periods: Window[] = [[Date.UTC(2025, 5, 1), Date.UTC(2026, 0, 1)], [Date.UTC(2026, 0, 1), Date.UTC(2026, 4, 1)],
  [Date.UTC(2026, 4, 1), Date.UTC(2026, 10, 1)]];
const costs = [{ fill: .00085, stop: .0003 }, { fill: .0015, stop: .0007 }];
const delay = 1;
const folder = join('backtest', 'data', 'intraday', 'hyperliquid-liquidations');
const months = Array.from({ length: 18 }, (_, i) => new Date(Date.UTC(2025, 4 + i, 1)).toISOString().slice(0, 7));
type DataRow = [time: number, open: number, high: number, low: number, close: number, volume: number,
  funding: number | null, liquidatedLongs: number, liquidatedShorts: number];
type Rule = { family: 'reversal' | 'continuation'; side: Side; span: number; multiple: number; confirm: boolean; hold: number };

function rollingPrior(values: number[], period: number) {
  let total = 0;
  return values.map((value, i) => {
    const mean = total / Math.max(1, Math.min(i, period));
    total += value - (i >= period ? values[i - period] : 0);
    return mean;
  });
}

function prepare(coin: string, sample: DataRow[], frame: number) {
  const lookback = 7 * DAY / frame;
  const rows = sample.map(([t, o, h, l, c]) => ({ t, perp: { o, h, l, c } }));
  const rowIndex = new Map(rows.map((row, i) => [row.t, i]));
  const funding = new Map(sample.flatMap(([time, , , , , , rate]) => rate === null ? [] : [[time, rate]]));
  const gaps = rows.filter(({ t }, i) => i > 0 && t - rows[i - 1].t !== frame).length;
  if (rows.some(({ t, perp }, i) => perp.l <= 0 || perp.l > Math.min(perp.o, perp.c) || perp.h < Math.max(perp.o, perp.c) ||
    (i > 0 && t <= rows[i - 1].t)) || gaps > 4 || !funding.size ||
    (frame === HOUR && funding.size / rows.length < .99)) throw new Error(`Incomplete liquidation replay data for ${coin}`);
  const longs = [0], shorts = [0];
  for (const row of sample) {
    longs.push(longs.at(-1)! + row[7]);
    shorts.push(shorts.at(-1)! + row[8]);
  }
  const baseline = rollingPrior(sample.map(row => row[7] + row[8]), lookback);
  const priorRange = rollingPrior(rows.map(({ perp }, i) => {
    const previous = rows[i - 1]?.perp.c ?? perp.o;
    return Math.max(perp.h - perp.l, Math.abs(perp.h - previous), Math.abs(perp.l - previous)) / previous;
  }), 2 * DAY / frame);
  const coverage = { coin, rows: rows.length, gaps, fundingHours: funding.size, longUsd: longs.at(-1)!, shortUsd: shorts.at(-1)! };
  return { rows, rowIndex, funding, priorRange, longs, shorts, baseline, coverage, frame, lookback };
}
type Market = ReturnType<typeof prepare>;

function load() {
  const parts = months.map(month => JSON.parse(readFileSync(join(folder, `${month}.json`), 'utf8')) as Record<string, DataRow[]>);
  return FLOW_MARKETS.map(coin => prepare(coin, parts.flatMap(month => month[coin]), HOUR));
}

async function fastSample() {
  type Bucket = [time: number, longs: number, shorts: number];
  const parts = months.map(month => JSON.parse(readFileSync(join(folder, `${month}-15m.json`), 'utf8')) as Record<string, Bucket[]>);
  const first = Date.UTC(2025, 4, 25, 14);
  return Promise.all(FLOW_MARKETS.map(async coin => {
    const [rows, rates] = await Promise.all([cryptoFlow(coin), perpFunding(coin)]);
    const funding = new Map(rates.map(row => [row.time, row.rate]));
    const liquidated = new Map(parts.flatMap(month => month[coin]).map(([t, longs, shorts]) => [t, { longs, shorts }]));
    return prepare(coin, rows.filter(row => row.t >= first).map(({ t, perp }) => {
      const { longs, shorts } = liquidated.get(t) ?? { longs: 0, shorts: 0 };
      return [t, perp.o, perp.h, perp.l, perp.c, perp.volume, funding.get(t) ?? null, longs, shorts];
    }), FRAME);
  }));
}

function signals(input: Market, rule: Rule, useLiquidations = true): Trigger[] {
  const { rows, baseline, priorRange, longs, shorts, frame, lookback } = input;
  const triggers: Trigger[] = [];
  const direction = rule.family === 'reversal' ? -rule.side : rule.side;
  for (let i = lookback + rule.span + delay; i < rows.length; i++) {
    const close = i - delay;
    const start = close - rule.span;
    if (rows[i].t - rows[start].t !== (i - start) * frame) continue;
    const eventMove = direction * Math.log(rows[close - 1].perp.c / rows[start].perp.o);
    if (eventMove < Math.max(.006, 1.15 * priorRange[start] * Math.sqrt(rule.span))) continue;
    const liquidated = direction === 1 ? shorts[close] - shorts[start] : longs[close] - longs[start];
    const total = shorts[close] - shorts[start] + longs[close] - longs[start];
    if (useLiquidations && (liquidated < Math.max(200_000, rule.multiple * rule.span * baseline[start]) || liquidated < .7 * total)) continue;
    const delayedBar = rows[i - 1].perp;
    if (rule.confirm && rule.side * Math.log(delayedBar.c / delayedBar.o) <= 0) continue;
    triggers.push({ index: i, side: rule.side });
  }
  return triggers;
}

function research(input: Market[]) {
  const frame = input[0].frame;
  const rules: Rule[] = [];
  for (const family of ['reversal', 'continuation'] as const) for (const side of [1, -1] as const) {
    for (const span of [1, 4]) for (const multiple of [4, 8]) {
      for (const confirm of [true, false]) for (const hold of [2, 6, 12, 24, 72]) rules.push({ family, side, span, multiple, confirm, hold });
    }
  }
  type Stats = ReturnType<typeof summarize>;
  const evaluate = (rule: Rule, indices: Trigger[][], i: number, stress: boolean) => {
    const window = periods[i];
    return summarize(input.map((market, m) =>
      replay(market, indices[m], rule.hold, window, costs[stress ? 1 : 0], rule.hold * frame >= DAY, frame)), window);
  };
  const qualifies = (stats: Stats) => stats.net > 0 && stats.days >= 18 && stats.weeks >= 8 &&
    stats.drawdown <= .2 && stats.markets.filter(market => market.net > 0).length >= 2;
  const leaders = new Map<string, { rule: Rule; discovery: Stats; validation: Stats; rank: number; qualified: boolean }>();
  let earlyPasses = 0;
  for (const rule of rules) {
    const indices = input.map(market => signals(market, rule));
    const discovery = evaluate(rule, indices, 0, false);
    const validation = evaluate(rule, indices, 1, true);
    const rank = Math.min(discovery.score, validation.score);
    const qualified = rank >= 1 && qualifies(discovery) && qualifies(validation);
    if (qualified) earlyPasses++;
    const key = `${rule.family}:${rule.side}:${rule.hold >= 24 ? 'longer' : 'shorter'}`;
    const leader = leaders.get(key);
    if (!leader || (qualified && !leader.qualified) || (qualified === leader.qualified && rank > leader.rank)) {
      leaders.set(key, { rule, discovery, validation, rank, qualified });
    }
  }
  const earlierLeaders = [...leaders.values()].sort((a, b) => b.rank - a.rank);
  const final = earlierLeaders.filter(entry => entry.qualified || (entry.discovery.net > 0 && entry.validation.net > 0)).map(entry => {
    const { rule } = entry;
    const indices = input.map(market => signals(market, rule));
    const baseline = evaluate(rule, indices, 2, false);
    const stressed = evaluate(rule, indices, 2, true);
    const control = evaluate(rule, input.map(market => signals(market, rule, false)), 2, true);
    const passed = entry.qualified && qualifies(stressed) && stressed.score >= 2 && stressed.score > control.score &&
      (stressed.averageBps ?? 0) > (control.averageBps ?? 0);
    return { ...entry, baseline, stressed, control, passed };
  });
  return { rules: rules.length, earlyPasses, earlierLeaders, candidates: final.filter(entry => entry.qualified),
    diagnostics: final.filter(entry => !entry.qualified) };
}

function report(input: Market[], execution: string) {
  const study = research(input);
  const frameMinutes = input[0].frame / 60_000;
  return { execution, frameMinutes, delayMinutesAfterSignalBar: delay * frameMinutes,
    coverage: input.map(market => market.coverage), ...study };
}

async function main() {
  const hourly = report(load(), 'Hyperliquid');
  const fast = report(await fastSample(), 'Binance');
  const output = { source: 'https://ironflow.sh/datasets', costs,
    periods: periods.map(window => window.map(time => new Date(time).toISOString().slice(0, 10))), hourly, fast };
  writeFileSync(join('backtest', 'hyperliquid-liquidation-results.json'), JSON.stringify(output, null, 2) + '\n');
  for (const study of [hourly, fast]) console.log(study.execution, study.rules, study.earlyPasses,
    [...study.candidates, ...study.diagnostics].map(candidate => ({
      rule: candidate.rule, net: candidate.stressed.net, control: candidate.control.net, days: candidate.stressed.days, passed: candidate.passed,
    })));
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
