import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntradayBar } from '@/lib/stocks/etoro';
import { alignFactorSessions, FACTOR_RULES, runFactorRule, type EarningsFiling } from '@/lib/stocks/factor-research';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { OPENING_DIR, OPENING_END, OPENING_START, OPENING_WINDOW } from './stock-opening-data';
import { REPLICATION_DIR, REPLICATION_END, REPLICATION_START, REPLICATION_SYMBOLS } from './stock-event-replication-data';

const spy: IntradayBar[] = [];
for (let t = Date.parse(OPENING_START); t < Date.parse(OPENING_END); t += OPENING_WINDOW) {
  const file = join(OPENING_DIR, `SPY-${new Date(t).toISOString().slice(0, 10)}.json`);
  spy.push(...JSON.parse(readFileSync(file, 'utf8')));
}
const eventData = REPLICATION_SYMBOLS.map(symbol => {
  const raw = readFileSync(join(REPLICATION_DIR, `${symbol}.json`), 'utf8');
  return { symbol, ...JSON.parse(raw) as { bars: IntradayBar[]; filings: EarningsFiling[]; unavailable?: boolean } };
});
const history = Object.fromEntries(eventData.map(row => [row.symbol, regularStockSessions(row.bars, 30).sessions]));
history.SPY = regularStockSessions(spy, 30).sessions;
const filings = Object.fromEntries(eventData.map(r => [r.symbol, r.filings]));
const aligned = alignFactorSessions(history, filings);
const events = [...aligned.values()].flat().filter(x => x.day >= REPLICATION_START && x.day < REPLICATION_END && x.earningsGap != null).length;

const lead = FACTOR_RULES.find(rule => rule.id === 'event--1-0.01-12')!;
const short = FACTOR_RULES.find(rule => rule.id === 'event--1-0.01-2')!;
const result = runFactorRule(aligned, lead, REPLICATION_START, REPLICATION_END);
const q2 = runFactorRule(aligned, lead, REPLICATION_START, '2026-07-01');
const h2 = runFactorRule(aligned, lead, '2026-07-01', REPLICATION_END);
const shortResult = runFactorRule(aligned, short, REPLICATION_START, REPLICATION_END);
const paperCandidate = result.trades >= 30 && result.activeDays >= 20 && result.positiveSymbols >= 5 &&
  (result.netBps ?? 0) >= 3 && (result.stressBps ?? 0) > 0 && (result.tByDay ?? 0) >= 1.65 &&
  (q2.stressBps ?? 0) > 0 && (h2.stressBps ?? 0) > 0;

const summary = { symbols: REPLICATION_SYMBOLS, unavailable: eventData.filter(r => r.unavailable).map(r => r.symbol), from: REPLICATION_START, to: REPLICATION_END, events, result, q2, h2, shortResult, paperCandidate };
writeFileSync(join(process.cwd(), 'lib', 'stocks', 'factor-replication.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ events, result, q2, h2, shortResult, paperCandidate }));
