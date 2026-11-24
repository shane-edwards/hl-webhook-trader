import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regularStockSessions, type StockSession } from '../lib/stocks/intraday';
import { earningsBeforeOpen, type EarningsFiling } from '../lib/stocks/factor-research';
import type { IntradayBar } from '../lib/stocks/etoro';

const cache = join(process.cwd(), 'backtest', 'data', 'intraday');
const opening = join(cache, 'stock-opening');
const events = join(cache, 'stock-events');
const external = join(cache, 'stock-event-replication');
const files = readdirSync(opening);
const devSymbols = readdirSync(events).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5));
const market = (paths: string[]) => regularStockSessions(paths.flatMap(path => JSON.parse(readFileSync(path, 'utf8')) as IntradayBar[]), 30).sessions;
const large = (symbol: string) => market(files.filter(file => file.startsWith(`${symbol}-`)).map(file => join(opening, file)));
const spy = large('SPY');
const reference = new Map(spy.map((session, i) => [session.day, i]));
const mid = (bar: IntradayBar) => (bar.askOpen + bar.bidOpen) / 2;
const expiry = { 'same-day': 0, 'two-session': 2 } as const;
type Rule = { profile: 'continuation' | 'rebound'; exit: keyof typeof expiry; gap: number; confirm: boolean };
type Trial = { day: string; symbol: string; net: number; excess: number };
type EarningsMarket = { symbol: string; sessions: StockSession[]; events: EarningsFiling[] };
const openBar = 2;
const rules: Rule[] = (['continuation', 'rebound'] as const).flatMap(profile =>
  (['same-day', 'two-session'] as const).flatMap(exit => [.01, .02, .03].flatMap(gap => [false, true].map(confirm => ({ profile, exit, gap, confirm })))));

function replay(inputs: EarningsMarket[], cfg: Rule, from: string, to: string, fee: number) {
  const trades: Trial[] = [];
  let eligibleFilings = 0;
  for (const { symbol, sessions, events: filings } of inputs) for (let i = 1; i < sessions.length; i++) {
    const session = sessions[i], prior = sessions[i - 1], idx = reference.get(session.day);
    if (session.day < from || session.day >= to || idx == null || !idx || spy[idx - 1].day !== prior.day) continue;
    if (!earningsBeforeOpen(filings, prior.bars.at(-1)!.t + 1_800_000, session.bars[0].t)) continue;
    eligibleFilings++;
    const broad = spy[idx];
    const gap = mid(session.bars[0]) / prior.bars.at(-1)!.bidClose - mid(broad.bars[0]) / spy[idx - 1].bars.at(-1)!.bidClose;
    const drift = mid(session.bars[openBar]) / mid(session.bars[0]) - mid(broad.bars[openBar]) / mid(broad.bars[0]);
    if (Math.abs(gap) > .25 || (cfg.profile === 'continuation' ? gap < cfg.gap : gap > -cfg.gap) || cfg.confirm && drift <= 0) continue;
    const days = expiry[cfg.exit];
    const last = sessions[i + days];
    if (!last || last.day >= to || last.day !== spy[idx + days]?.day) continue;
    if (days && sessions[i + 1]?.day !== spy[idx + 1]?.day) continue;
    const exitBar = days ? openBar : 12;
    const entry = session.bars[openBar], exit = last.bars[exitBar];
    if ((entry.askOpen - entry.bidOpen) / mid(entry) > .0015) continue;
    const benchmark = mid(spy[idx + days].bars[exitBar]) / mid(broad.bars[openBar]) - 1;
    const net = exit.bidOpen * (1 - fee) / (entry.askOpen * (1 + fee)) - 1;
    trades.push({ day: session.day, symbol, net, excess: net - benchmark });
  }
  const byDay = new Map<string, number[]>();
  for (const trade of trades) byDay.set(trade.day, [...(byDay.get(trade.day) ?? []), trade.excess]);
  const means = [...byDay.values()].map(day => day.reduce((sum, n) => sum + n, 0) / day.length);
  const center = means.reduce((sum, n) => sum + n, 0) / Math.max(means.length, 1);
  const stderr = Math.sqrt(means.reduce((sum, n) => sum + (n - center) ** 2, 0) / Math.max(means.length - 1, 1) / Math.max(means.length, 1));
  const avg = (key: 'net' | 'excess') => trades.length ? trades.reduce((sum, row) => sum + row[key], 0) / trades.length * 1e4 : null;
  const symbols = new Map<string, number>();
  for (const trade of trades) symbols.set(trade.symbol, (symbols.get(trade.symbol) ?? 0) + trade.net);
  return { eligibleFilings, trades: trades.length, tradingDays: byDay.size, netBps: avg('net'), excessBps: avg('excess'),
    positiveSymbols: [...symbols.values()].filter(value => value > 0).length, score: stderr > 0 ? center / stderr : null };
}

const discovery = devSymbols.map(symbol => ({ symbol, sessions: large(symbol),
  events: JSON.parse(readFileSync(join(events, `${symbol}.json`), 'utf8')) as EarningsFiling[] }));
const validation = readdirSync(external).filter(file => file.endsWith('.json')).map(file => {
  const { bars, filings } = JSON.parse(readFileSync(join(external, file), 'utf8')) as { bars: IntradayBar[]; filings: EarningsFiling[] };
  return { symbol: file.slice(0, -5), sessions: regularStockSessions(bars, 30).sessions, events: filings };
});
const before = rules.map(rule => ({ rule, initial: replay(discovery, rule, '2025-05-01', '2026-04-01', .0004),
  replication: replay(validation, rule, '2026-04-01', '2026-07-01', .0009) }));
const eligible = before.filter(row => [row.initial, row.replication].every(x => x.trades >= 12 && x.tradingDays >= 10 &&
  x.positiveSymbols >= 5 && (x.netBps ?? -Infinity) > 0 && (x.excessBps ?? -Infinity) > 0 && (x.score ?? 0) >= 1.25))
  .sort((a, b) => Math.min(b.initial.score!, b.replication.score!) - Math.min(a.initial.score!, a.replication.score!))[0];
const final = eligible ? replay(validation, eligible.rule, '2026-07-01', '2026-11-21', .0009) : null;
const mostActive = [...before].sort((a, b) => Math.min(b.initial.trades, b.replication.trades) -
  Math.min(a.initial.trades, a.replication.trades))[0];
const report = { tested: rules.length, source: 'Paired eToro 30-minute bid/ask candles, SPY benchmark and SEC Item 2.02 filing timestamps',
  symbols: [discovery.length, validation.length], mostActive, selected: eligible ?? null, final };
writeFileSync(join(process.cwd(), 'backtest', 'earnings-drift-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
