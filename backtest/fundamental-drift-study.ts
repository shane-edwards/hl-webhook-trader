import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILING_DIR, FILING_THROUGH, type EPS, type FilingRecord } from './fundamental-drift-data';
import type { StockBar } from '../lib/stocks/research';
import { STOCK_TRADE_SYMBOLS } from '../lib/stocks/trade-rules';

const discoverySymbols = ['AAPL', 'NVDA', 'META', 'AMD', 'WMT', 'XOM', 'JPM', 'LLY', 'TSLA', 'CAT'];
const validationSymbols: readonly string[] = STOCK_TRADE_SYMBOLS.filter(symbol => symbol !== 'SPY' && !discoverySymbols.includes(symbol));
const windows = [['2021-06-01', '2024-01-01'], ['2024-01-01', '2026-01-01'], ['2026-01-01', FILING_THROUGH]] as const;
type Window = typeof windows[number];
const day = 86_400_000;

type Rule = { growth: number; days: number; relativeTrend: boolean };
type Event = { filed: string; quarter: string; growth: number };
type Trade = { symbol: string; date: string; pnl: number; relative: number };

function qualifiedEvents(input: EPS[]) {
  const rows = input.filter(row => Number.isFinite(row.val) &&
    [row.start, row.end, row.filed].every(value => Number.isFinite(Date.parse(value))) && row.filed >= row.end &&
    Date.parse(row.end) - Date.parse(row.start) >= 69 * day && Date.parse(row.end) - Date.parse(row.start) <= 110 * day);
  const byAccession = new Map<string, EPS[]>();
  for (const row of rows) byAccession.set(row.accn, [...(byAccession.get(row.accn) ?? []), row]);
  const seen = new Set<string>();
  const events: Event[] = [];
  for (const row of [...rows].sort((a, b) => a.filed.localeCompare(b.filed))) {
    if (Date.parse(row.filed) - Date.parse(row.end) > 116 * day || seen.has(row.end)) continue;
    const peers = byAccession.get(row.accn)!;
    const equivalent = peers.filter(prior => {
      const delta = Date.parse(row.end) - Date.parse(prior.end);
      return delta >= 342 * day && delta <= 389 * day;
    }).sort((a, b) => Math.abs(Date.parse(row.end) - Date.parse(a.end) - 365 * day) -
      Math.abs(Date.parse(row.end) - Date.parse(b.end) - 365 * day))[0];
    if (!equivalent) continue;
    seen.add(row.end);
    events.push({ filed: row.filed, quarter: row.end, growth: (row.val - equivalent.val) / Math.max(.25, Math.abs(equivalent.val)) });
  }
  return events;
}

function inputs(records: FilingRecord[], spine: StockBar[]) {
  return records.map(item => {
    const onDate = new Map<string, Event>();
    for (const event of qualifiedEvents(item.earnings)) {
      const first = spine.findIndex(session => session.day > event.filed);
      if (first < 0 || !spine[first + 1]) continue;
      const date = spine[first + 1].day;
      const active = onDate.get(date);
      if (!active || event.quarter > active.quarter) onDate.set(date, event);
    }
    return { symbol: item.symbol, events: onDate, prices: new Map(item.daily.map(bar => [bar.day, bar])) };
  });
}

type Asset = ReturnType<typeof inputs>[number];
type Position = { asset: Asset; units: number; principal: number; benchmarkEntry: number; due: number; marked: number };

function replay(assets: Asset[], spine: StockBar[], cfg: Rule, [from, to]: Window, cost: number) {
  let cash = 1, value = 1, high = 1, drawdown = 0;
  const positions: Position[] = [], trades: Trade[] = [];
  const weeks = new Map<number, number>();
  for (let i = 21; i < spine.length; i++) {
    const ref = spine[i];
    if (ref.day < from) continue;
    if (ref.day >= to) break;
    const closeAll = spine[i + 1]?.day >= to;
    for (let j = positions.length - 1; j >= 0; j--) {
      const position = positions[j];
      const quote = position.asset.prices.get(ref.day);
      if (!quote || (i < position.due && !closeAll)) continue;
      const proceeds = quote.bidOpen * (1 - cost) * position.units;
      cash += proceeds;
      const pnl = proceeds / position.principal - 1;
      trades.push({ symbol: position.asset.symbol, date: ref.day, pnl, relative: pnl - (ref.bidOpen / position.benchmarkEntry - 1) });
      positions.splice(j, 1);
    }
    if (!closeAll && positions.length < 3 && spine[i + cfg.days]?.day < to) {
      const prior = spine[i - 1], base = spine[i - 21];
      const candidates = assets.flatMap(asset => {
        const match = asset.events.get(ref.day), now = asset.prices.get(ref.day);
        const last = asset.prices.get(prior.day), year = asset.prices.get(base.day);
        if (!match || !now || match.growth < cfg.growth || positions.some(open => open.asset.symbol === asset.symbol)) return [];
        if ((now.askOpen - now.bidOpen) / now.askOpen > .004) return [];
        if (cfg.relativeTrend && (!last || !year || last.bidClose / year.bidClose <= prior.bidClose / base.bidClose)) return [];
        return [{ asset, now, growth: match.growth }];
      }).sort((a, b) => b.growth - a.growth).slice(0, 3 - positions.length);
      for (const { asset, now } of candidates) {
        const principal = Math.min(cash, .25 * value);
        if (principal <= 0) break;
        const units = principal / (now.askOpen * (1 + cost));
        positions.push({ asset, units, principal, benchmarkEntry: ref.askOpen, due: i + cfg.days, marked: units * now.bidOpen * (1 - cost) });
        cash -= principal;
      }
    }
    const equivalent = cash + positions.reduce((sum, position) => {
      const quote = position.asset.prices.get(ref.day);
      if (quote) position.marked = position.units * quote.bidClose * (1 - cost);
      return sum + position.marked;
    }, 0);
    const week = Math.floor((Date.parse(ref.day) - Date.parse(from)) / (7 * day));
    weeks.set(week, (weeks.get(week) ?? 0) + equivalent - value);
    value = equivalent;
    high = Math.max(high, value);
    drawdown = Math.max(drawdown, 1 - value / high);
  }
  const t = [...weeks.values()];
  const average = t.reduce((sum, row) => sum + row, 0) / t.length;
  const noise = Math.sqrt(t.reduce((sum, row) => sum + (row - average) ** 2, 0) / (t.length - 1) / t.length);
  const averageOf = (key: 'pnl' | 'relative') => trades.length ? trades.reduce((sum, row) => sum + row[key], 0) / trades.length : null;
  const ticker = new Map<string, number>();
  for (const trade of trades) ticker.set(trade.symbol, (ticker.get(trade.symbol) ?? 0) + trade.pnl);
  return { net: value - 1, drawdown, score: noise > 0 ? average / noise : 0, trades: trades.length,
    days: new Set(trades.map(trade => trade.date)).size, positiveSymbols: [...ticker.values()].filter(x => x > 0).length,
    perTrade: averageOf('pnl'), excessPerTrade: averageOf('relative'), openAtEnd: positions.length };
}

const records: FilingRecord[] = STOCK_TRADE_SYMBOLS.flatMap(symbol => {
  const file = join(FILING_DIR, `${symbol}.json`);
  return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as FilingRecord] : [];
});
const spy = records.find(item => item.symbol === 'SPY');
if (!spy || records.length < 17) throw new Error('The filing study requires at least 16 stock feeds and SPY.');
const initial = inputs(records.filter(asset => discoverySymbols.includes(asset.symbol)), spy.daily);
const reserved = inputs(records.filter(asset => validationSymbols.includes(asset.symbol)), spy.daily);
if (initial.length < 8 || reserved.length < 8) throw new Error('Both independent market sets require at least eight stock feeds.');
const variants: Rule[] = [.15, .30, .50].flatMap(growth => [3, 7, 15, 25].flatMap(days =>
  [false, true].map(relativeTrend => ({ growth, days, relativeTrend }))));
const evaluated = variants.map(rule => {
  const discovery = replay(initial, spy.daily, rule, windows[0], .0004);
  const validation = replay(reserved, spy.daily, rule, windows[1], .0009);
  return { rule, discovery, validation, rank: Math.min(discovery.score, validation.score) };
}).sort((a, b) => b.rank - a.rank);
const selected = evaluated.find(row => [row.discovery, row.validation].every(r => r.net > 0 && (r.excessPerTrade ?? -1) > 0 &&
  r.score >= 1.25 && r.trades >= 20 && r.days >= 10 && r.positiveSymbols >= 4 && r.drawdown <= .12 && r.openAtEnd === 0));
const combined = [...initial, ...reserved];
const holdout = selected ? replay(combined, spy.daily, selected.rule, windows[2], .0004) : null;
const stressed = selected ? replay(combined, spy.daily, selected.rule, windows[2], .0009) : null;
const paper = !!holdout && !!stressed && stressed.score >= 2 && holdout.net > 0 && stressed.net > 0 &&
  stressed.trades >= 15 && stressed.days >= 12 && stressed.positiveSymbols >= 4 && stressed.openAtEnd === 0 &&
  (stressed.excessPerTrade ?? -1) > 0 && stressed.drawdown <= .12;
const report = { windows, discovery: initial.map(({ symbol, events }) => ({ symbol, events: events.size })),
  independentSymbols: reserved.map(({ symbol, events }) => ({ symbol, events: events.size })), tested: variants.length, selected: selected ?? null,
  holdout, stressed, paper, diagnostic: evaluated.slice(0, 3) };
writeFileSync(join(process.cwd(), 'backtest', 'fundamental-drift-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ assets: records.length - 1, tested: report.tested, selected: report.selected, holdout, stressed, paper,
  bestEarlier: report.diagnostic[0] }));
