import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StockSession } from '../lib/stocks/intraday';
import { GAP_DIR, GAP_END, GAP_SYMBOLS } from './stock-gap-data';

const PERIODS = [['2023-03-01', '2025-01-01'], ['2025-01-01', '2026-01-01'], ['2026-01-01', GAP_END]] as const;
const ETF_FOLDER = join('backtest', 'data', 'intraday', 'etf-strategies');
const ETFs = ['QQQ', 'IWM', 'XLK', 'XLF'];
const DAY = 86_400_000;
const COSTS = [{ fill: .0003, stop: .0004 }, { fill: .00065, stop: .0008 }];
type Period = typeof PERIODS[number];
type Setup = { event: 'opening-gap' | 'late-selloff'; kind: 'reverse' | 'follow'; threshold: number;
  confirm: boolean; exitBar: number };

function read(symbol: string, etf: boolean) {
  const data = JSON.parse(readFileSync(join(etf ? ETF_FOLDER : GAP_DIR, `${symbol}.json`), 'utf8'));
  return (etf ? data.sessions : data) as StockSession[];
}

function variation(sample: number[]) {
  const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
  return Math.sqrt(sample.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sample.length);
}

function prepare(symbol: string, sessions: StockSession[], spy: StockSession[]) {
  const byDate = new Map(spy.map((row, i) => [row.day, i]));
  const valid: { day: string; gap: number; spyGap: number; cash: number; spyCash: number; session: StockSession; next?: StockSession }[] = [];
  for (let i = 1; i < sessions.length; i++) {
    const session = sessions[i], before = sessions[i - 1], date = byDate.get(session.day);
    if (!date || spy[date - 1].day !== before.day || session.bars.length !== 13) continue;
    const sp = spy[date], prev = spy[date - 1];
    if (sp.bars.length !== 13) continue;
    const gap = Math.log(session.bars[0].bidOpen / before.bars.at(-1)!.bidClose);
    const spyGap = Math.log(sp.bars[0].bidOpen / prev.bars.at(-1)!.bidClose);
    const cash = Math.log(session.bars[12].bidOpen / session.bars[0].bidOpen);
    const spyCash = Math.log(sp.bars[12].bidOpen / sp.bars[0].bidOpen);
    const next = sessions[i + 1]?.day === spy[date + 1]?.day ? sessions[i + 1] : undefined;
    valid.push({ day: session.day, gap, spyGap, cash, spyCash, session, next });
  }
  const days = valid.flatMap((row, i) => {
    if (i < 60) return [];
    const prior = valid.slice(i - 60, i);
    const gap = variation(prior.map(date => date.gap));
    const cash = variation(prior.map(date => date.cash));
    const gapResidual = variation(prior.map(date => date.gap - date.spyGap));
    const cashResidual = variation(prior.map(date => date.cash - date.spyCash));
    return [{ ...row, gapScale: [gapResidual, gap], cashScale: [cashResidual, cash] }];
  });
  return { symbol, days };
}
type Market = ReturnType<typeof prepare>;

function replay(market: Market, rule: Setup, [from, to]: Period, cost: typeof COSTS[number], adjusted = true) {
  let equity = 1, available = '';
  const fills: { day: string; net: number; change: number }[] = [];
  const marks: { day: string; change: number }[] = [];
  const overnight = rule.event === 'late-selloff';
  for (const date of market.days) {
    if (date.day < from || date.day < available) continue;
    if (date.day >= to) break;
    const { session, next } = date;
    if (overnight && (!next || next.day >= to)) continue;
    const adjustedMove = overnight ? date.cash - (adjusted ? date.spyCash : 0) : date.gap - (adjusted ? date.spyGap : 0);
    const scale = (overnight ? date.cashScale : date.gapScale)[adjusted ? 0 : 1];
    const magnitude = rule.kind === 'reverse' ? -adjustedMove : adjustedMove;
    if (magnitude < Math.max(overnight ? .007 : .005, scale * rule.threshold)) continue;
    const bars = session.bars;
    const confirm = overnight ? bars[11].bidClose / bars[11].bidOpen - 1 : bars[0].bidClose / bars[0].bidOpen - 1;
    if (rule.confirm && confirm <= 0) continue;
    const start = overnight ? 12 : 1;
    const quote = bars[start];
    if (!(quote.askOpen >= quote.bidOpen && quote.bidOpen > 0) || quote.askOpen / quote.bidOpen - 1 > .005) continue;
    const entry = quote.askOpen * (1 + cost.fill);
    const stop = entry * (overnight ? .965 : .98);
    const ending = overnight ? next! : session;
    const trail = overnight ? [...bars.slice(12), ...ending.bars.slice(0, rule.exitBar)].map((bar, i) => ({ bar, schedule: i === 0 ? date.day : ending.day })) :
      bars.slice(start, rule.exitBar).map(bar => ({ bar, schedule: date.day }));
    if (!ending.bars[rule.exitBar]) continue;
    const capital = equity;
    let lastMark = 0, closed = false;
    const record = (price: number, day: string, stopped: boolean, final: boolean) => {
      const net = price * (1 - cost.fill - (stopped ? cost.stop : 0)) / entry - 1;
      const change = capital * (net - lastMark);
      equity += change;
      marks.push({ day, change });
      if (final) fills.push({ day: date.day, net, change: capital * net });
      lastMark = net;
    };
    for (const { bar, schedule } of trail) {
      if (bar.bidLow <= stop) {
        record(Math.min(stop, bar.bidOpen), schedule, true, true);
        closed = true;
        break;
      }
      record(bar.bidClose, schedule, false, false);
    }
    if (!closed) {
      const endingOpen = ending.bars[rule.exitBar].bidOpen;
      record(endingOpen, ending.day, endingOpen < stop, true);
    }
    if (overnight) available = ending.day;
  }
  return { symbol: market.symbol, fills, marks, net: equity - 1 };
}

function summarize(parts: ReturnType<typeof replay>[], period: Period, spy: StockSession[]) {
  const [from, to] = period;
  const weeks = new Float64Array(Math.ceil((Date.parse(to) - Date.parse(from)) / (7 * DAY)));
  const days = new Map<string, number>();
  const tradeDays = new Set<string>();
  const trades = parts.flatMap(row => row.fills);
  const index = new Map(spy.map(({day}, i) => [day, i]));
  for (const part of parts) for (const { day, change } of part.marks) days.set(day, (days.get(day) ?? 0) + change / parts.length);
  for (const row of trades) tradeDays.add(row.day);
  let equity = 1, peak = 1, drawdown = 0;
  for (const [day, pnl] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    weeks[Math.floor((Date.parse(day) - Date.parse(from)) / (7 * DAY))] += pnl;
    equity += pnl;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  }
  const average = (equity - 1) / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, week) => sum + (week - average) ** 2, 0) / (weeks.length - 1) / weeks.length);
  const distinctWeeks = new Set([...tradeDays].map(day => Math.floor((index.get(day) ?? 0) / 5))).size;
  return { net: equity - 1, drawdown, days: tradeDays.size, weeks: distinctWeeks, trades: trades.length,
    score: error > 0 ? average / error : 0,
    averageBps: trades.length ? trades.reduce((sum, row) => sum + row.net, 0) * 1e4 / trades.length : null,
    markets: parts.map(({ symbol, net, fills }) => ({ symbol, net, count: fills.length })) };
}

function search(group: Market[], reserve: Market[], index: StockSession[]) {
  const rules: Setup[] = [];
  for (const event of ['opening-gap', 'late-selloff'] as const) for (const kind of ['reverse', 'follow'] as const) {
    for (const threshold of [1.25, 1.9]) for (const confirm of [false, true]) {
      for (const exitBar of event === 'opening-gap' ? [3, 7, 12] : [0, 1, 3]) rules.push({ event, kind, threshold, confirm, exitBar });
    }
  }
  const evaluate = (rule: Setup, group: Market[], w: number, stress: boolean, adjusted = true) =>
    summarize(group.map(input => replay(input, rule, PERIODS[w], COSTS[stress ? 1 : 0], adjusted)), PERIODS[w], index);
  const accepts = (stats: ReturnType<typeof summarize>) => stats.net > 0 && stats.days >= 30 && stats.weeks >= 15 &&
    stats.drawdown < .2 && stats.markets.filter(s => s.net > 0).length >= Math.ceil(stats.markets.length / 2);
  let earlyPasses = 0;
  const picks = new Map<string, { rule: Setup; early: ReturnType<typeof summarize>; validation: ReturnType<typeof summarize>; ready: boolean; rank: number }>();
  for (const rule of rules) {
    const early = evaluate(rule, group, 0, false);
    const validation = evaluate(rule, group, 1, true);
    const rank = Math.min(early.score, validation.score);
    const ready = rank > 1.25 && accepts(early) && accepts(validation);
    if (ready) earlyPasses++;
    const key = `${rule.event}:${rule.kind}`;
    const previous = picks.get(key);
    if (!previous || ready && !previous.ready || ready === previous.ready && rank > previous.rank) {
      picks.set(key, { rule, early, validation, ready, rank });
    }
  }
  const ranked = [...picks.values()].sort((a, b) => b.rank - a.rank);
  const results = ranked.filter(row => row.rank > 0).map(item => {
    const { rule } = item;
    const baseline = evaluate(rule, group, 2, false);
    const stress = evaluate(rule, group, 2, true);
    const unadjusted = evaluate(rule, group, 2, true, false);
    const external = reserve.length ? evaluate(rule, reserve, 2, true) : null;
    const passes = item.ready && accepts(stress) && stress.score >= 2.2 && (stress.averageBps ?? 0) > (unadjusted.averageBps ?? 0) &&
      !!external && accepts(external) && external.score >= 1.25;
    return { ...item, baseline, stress, unadjusted, external, passes };
  });
  return { rules: rules.length, earlyPasses, ranked, results };
}

const spy = read('SPY', true);
const ETFsData = ETFs.map(symbol => prepare(symbol, read(symbol, true), spy));
const stocks = GAP_SYMBOLS.flatMap(symbol => existsSync(join(GAP_DIR, `${symbol}.json`)) ? [prepare(symbol, read(symbol, false), spy)] : []);
const primary = stocks.filter(row => GAP_SYMBOLS.indexOf(row.symbol as typeof GAP_SYMBOLS[number]) < 8);
const reserve = stocks.filter(row => GAP_SYMBOLS.indexOf(row.symbol as typeof GAP_SYMBOLS[number]) >= 8);
const etfs = search(ETFsData, stocks, spy);
const shares = primary.length >= 4 ? search(primary, reserve, spy) : null;
writeFileSync(join('backtest', 'stock-gap-results.json'), JSON.stringify({ periods: PERIODS, costs: COSTS,
  equityFit: primary.map(row => row.symbol), equityTransfer: reserve.map(row => row.symbol),
  coverage: [...ETFsData, ...stocks].map(row => ({ symbol: row.symbol, days: row.days.length })), etfs, shares }, null, 2) + '\n');
console.log('Stock gap tests', etfs.rules, etfs.earlyPasses, shares?.rules ?? 0, shares?.earlyPasses ?? 0);
for (const config of [etfs, shares]) for (const row of config?.results ?? []) {
  console.log({ rule: row.rule, stress: row.stress.net, external: row.external?.net, days: row.stress.days, passes: row.passes });
}
