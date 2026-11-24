import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StockBar } from '../lib/stocks/research';

const DIR = join('backtest', 'data', 'intraday', 'etf-strategies');
const PRIMARY = ['SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE'];
const OTHER = ['DIA', 'XLY', 'XLC', 'XLI', 'XLB', 'XLP', 'XLU', 'XLV', 'SMH', 'VNQ'];
const DAYS = [['2022-04-01', '2024-01-01'], ['2024-01-01', '2026-01-01'], ['2026-01-01', '2026-11-20']] as const;
const DAY = 86_400_000;
const COSTS = [{ fill: .0003, stop: .0004 }, { fill: .00065, stop: .0008 }];
type Rule = { event: 'spike' | 'cooling'; curve: 'VIX' | 'VIX9D'; rise: number; level: number; hold: number };
type Period = typeof DAYS[number];

async function closeSeries(symbol: string) {
  const path = join(DIR, `${symbol}-close.csv`);
  let csv: string;
  if (existsSync(path)) csv = readFileSync(path, 'utf8');
  else {
    const url = `https://cdn.cboe.com/api/global/us_indices/daily_prices/${symbol}_History.csv`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Cboe historical ${symbol} returned ${response.status}`);
    csv = await response.text();
    if (!csv.startsWith('DATE,OPEN,HIGH,LOW,CLOSE')) throw new Error(`Invalid Cboe history for ${symbol}`);
    writeFileSync(path, csv);
  }
  return new Map(csv.trim().split('\n').slice(1).flatMap(line => {
    const [stamp, , , , close] = line.split(',');
    const [m, d, y] = stamp.split('/');
    const value = Number(close);
    return Number.isFinite(value) && value > 0 ? [[`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`, value]] : [];
  }));
}

function read(symbol: string): StockBar[] {
  const raw = JSON.parse(readFileSync(join(DIR, `${symbol}.json`), 'utf8')) as { daily: StockBar[] };
  return raw.daily.filter(row => row.bidOpen > 0 && row.askOpen >= row.bidOpen && row.low > 0 &&
    row.high >= Math.max(row.bidOpen, row.bidClose) && row.low <= Math.min(row.bidOpen, row.bidClose));
}

function events(spy: StockBar[], series: Map<string, number>[]) {
  const [spot, threeMonth, nineDay] = series;
  return new Map(spy.flatMap(({ day, bidClose }, i) => {
    const prior = spy[i - 1], earlier = spy[i - 3];
    if (!prior || !earlier) return [];
    const current = spot.get(day), previous = spot.get(prior.day);
    const far = threeMonth.get(day), oldFar = threeMonth.get(prior.day);
    const near = nineDay.get(day), oldNear = nineDay.get(prior.day);
    if (!current || !previous || !far || !oldFar || !near || !oldNear) return [];
    return [[day, { change: current / previous - 1, ratio: { VIX: current / far, VIX9D: near / current },
      priorRatio: { VIX: previous / oldFar, VIX9D: oldNear / previous },
      drop: bidClose / prior.bidClose - 1, drop3: bidClose / earlier.bidClose - 1 }]];
  }));
}
type Events = ReturnType<typeof events>;

function trigger(rule: Rule, item: NonNullable<ReturnType<Events['get']>>, useCurve: boolean) {
  if (rule.event === 'spike') return item.drop <= -.007 && (!useCurve || item.change >= rule.rise && item.ratio[rule.curve] >= rule.level);
  return item.drop3 <= -.012 && item.drop > 0 && (!useCurve || item.priorRatio[rule.curve] >= rule.level &&
    item.ratio[rule.curve] < item.priorRatio[rule.curve] && item.change <= -rule.rise);
}

function simulate(symbol: string, bars: StockBar[], sessions: Map<string, number>, tape: Events, rule: Rule, [from, to]: Period, stress: boolean, useCurve: boolean) {
  const cost = COSTS[stress ? 1 : 0];
  let equity = 1, block = 1;
  const marks: { day: string; change: number }[] = [], fills: { day: string; net: number }[] = [];
  for (let i = 1; i + rule.hold < bars.length; i++) {
    if (i < block || bars[i].day < from) continue;
    const end = bars[i + rule.hold];
    if (end.day >= to) break;
    const bar = bars[i], pattern = tape.get(bars[i - 1].day);
    const session = sessions.get(bars[i - 1].day), terminal = sessions.get(end.day);
    if (!pattern || session === undefined || terminal !== session + 1 + rule.hold || !trigger(rule, pattern, useCurve)) continue;
    if (bar.askOpen / bar.bidOpen - 1 > .005) continue;
    const entry = bar.askOpen * (1 + cost.fill);
    const stop = entry * .94;
    const capital = equity;
    let last = 0;
    for (let j = i; j <= i + rule.hold; j++) {
      const current = bars[j];
      const terminal = j === i + rule.hold;
      const stopped = terminal ? current.bidOpen < stop : current.low <= stop;
      const price = terminal ? current.bidOpen : stopped ? Math.min(stop, current.bidOpen) : current.bidClose;
      const net = price * (1 - cost.fill - (stopped ? cost.stop : 0)) / entry - 1;
      const change = capital * (net - last);
      equity += change;
      marks.push({ day: current.day, change });
      last = net;
      if (terminal || stopped) {
        fills.push({ day: bar.day, net });
        block = terminal ? j : j + 1;
        break;
      }
    }
  }
  return { symbol, fills, marks, net: equity - 1 };
}

function summarize(books: ReturnType<typeof simulate>[], [from, to]: Period) {
  const weeks = new Float64Array(Math.ceil((Date.parse(to) - Date.parse(from)) / (7 * DAY)));
  const marks = new Map<string, number>();
  const trades = books.flatMap(book => book.fills);
  for (const book of books) for (const { day, change } of book.marks) marks.set(day, (marks.get(day) ?? 0) + change / books.length);
  let equity = 1, peak = 1, drawdown = 0;
  for (const [day, change] of [...marks].sort(([a], [b]) => a.localeCompare(b))) {
    weeks[Math.floor((Date.parse(day) - Date.parse(from)) / (7 * DAY))] += change;
    equity += change;
    peak = Math.max(equity, peak);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  }
  const average = (equity - 1) / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, week) => sum + (week - average) ** 2, 0) / (weeks.length - 1) / weeks.length);
  return { net: equity - 1, drawdown, days: new Set(trades.map(row => row.day)).size, trades: trades.length,
    score: error > 0 ? average / error : 0, averageBps: trades.length ? 1e4 * trades.reduce((sum, row) => sum + row.net, 0) / trades.length : null,
    markets: books.map(({ symbol, fills, net }) => ({ symbol, trades: fills.length, net })) };
}

async function main() {
  const spy = read('SPY');
  const sessions = new Map(spy.map(({ day }, i) => [day, i]));
  const tape = events(spy, await Promise.all(['VIX', 'VIX3M', 'VIX9D'].map(closeSeries)));
  const all = new Map([...PRIMARY, ...OTHER].map(symbol => [symbol, read(symbol)]));
  const evaluate = (universe: string[], rule: Rule, i: number, stress: boolean, useCurve = true) =>
    summarize(universe.map(symbol => simulate(symbol, all.get(symbol)!, sessions, tape, rule, DAYS[i], stress, useCurve)), DAYS[i]);
  const qualifies = (stats: ReturnType<typeof summarize>) => stats.net > 0 && stats.days >= 12 &&
    stats.drawdown < .17 && stats.markets.filter(item => item.net > 0).length >= Math.ceil(stats.markets.length / 2);
  type Result = { rule: Rule; discovery: ReturnType<typeof summarize>; validation: ReturnType<typeof summarize>; ready: boolean; rank: number };
  const leaders = new Map<string, Result>();
  let variants = 0, earlyPasses = 0;
  for (const event of ['spike', 'cooling'] as const) for (const curve of ['VIX', 'VIX9D'] as const) {
    for (const rise of [.08, .15]) for (const level of [1.02, 1.09]) for (const hold of [1, 3, 5, 10]) {
      const rule = { event, curve, rise, level, hold };
      variants++;
      const discovery = evaluate(PRIMARY, rule, 0, false);
      const validation = evaluate(PRIMARY, rule, 1, true);
      const rank = Math.min(discovery.score, validation.score);
      const ready = rank >= 1.25 && qualifies(discovery) && qualifies(validation);
      if (ready) earlyPasses++;
      const key = `${event}:${curve}`, prior = leaders.get(key);
      if (!prior || ready && !prior.ready || ready === prior.ready && rank > prior.rank) {
        leaders.set(key, { rule, discovery, validation, rank, ready });
      }
    }
  }
  const ranked = [...leaders.values()].sort((a, b) => b.rank - a.rank);
  const later = ranked.filter(item => item.rank > 0).map(entry => {
    const { rule } = entry;
    const stress = evaluate(PRIMARY, rule, 2, true);
    const priceControl = evaluate(PRIMARY, rule, 2, true, false);
    const external = evaluate(OTHER, rule, 2, true);
    const passes = entry.ready && qualifies(stress) && stress.score >= 2.2 && qualifies(external) && external.score >= 1.25 &&
      stress.score > priceControl.score && (stress.averageBps ?? 0) > (priceControl.averageBps ?? 0);
    return { ...entry, stress, priceControl, external, passes };
  });
  writeFileSync(join('backtest', 'stock-volatility-results.json'), JSON.stringify({ variants, earlyPasses, periods: DAYS, costs: COSTS,
    coverage: [...all].map(([symbol, bars]) => ({ symbol, bars: bars.length })), observations: tape.size, ranked, later }, null, 2) + '\n');
  console.log('Cboe curve and stock setups', variants, earlyPasses, later.map(row => ({
    rule: row.rule, net: row.stress.net, days: row.stress.days, marketTransfer: row.external.net, passes: row.passes,
  })));
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
