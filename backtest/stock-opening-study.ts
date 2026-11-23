import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntradayBar } from '@/lib/stocks/etoro';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { OPENING_RULES, prepareOpening, replayOpening, summarizeOpening } from '@/lib/stocks/opening-research';
import { OPENING_BASKET, OPENING_DIR, OPENING_END, OPENING_START, OPENING_WINDOW } from './stock-opening-data';
import { STUDY_DIR, STUDY_SYMBOLS } from './stock-intraday-data';

const periods = [
  { label: '2025 screen', from: OPENING_START, to: '2026-01-01' },
  { label: '2026 H1 validation', from: '2026-01-01', to: '2026-07-01' },
  { label: '2026 H2 holdout', from: '2026-07-01', to: OPENING_END },
];
type Summary = ReturnType<typeof summarizeOpening>;

function load(symbols: readonly string[], directory: string, span: number, interval: 5 | 30) {
  return Object.fromEntries(symbols.map(symbol => {
    const bars: IntradayBar[] = [];
    for (let from = Date.parse(OPENING_START); from < Date.parse(OPENING_END); from += span) {
      const path = join(directory, `${symbol}-${new Date(from).toISOString().slice(0, 10)}.json`);
      if (!existsSync(path)) throw new Error(`Missing paired broker data: ${path}`);
      bars.push(...JSON.parse(readFileSync(path, 'utf8')));
    }
    const daily = regularStockSessions(bars, interval);
    if (daily.sessions.length < 330) throw new Error(`Too few complete ${interval}m sessions for ${symbol}: ${daily.sessions.length}`);
    return [symbol, daily];
  }));
}

const thirty = load(OPENING_BASKET, OPENING_DIR, OPENING_WINDOW, 30);
const five = load(STUDY_SYMBOLS, STUDY_DIR, 28 * 86_400_000, 5);
const prepared = {
  30: prepareOpening(Object.fromEntries(Object.entries(thirty).map(([symbol, c]) => [symbol, c.sessions]))),
  5: prepareOpening(Object.fromEntries(Object.entries(five).map(([symbol, c]) => [symbol, c.sessions]))),
};
const meetsGate = (s: Summary) => s.trades >= 60 && s.days >= 40 && (s.netBps ?? 0) >= 3 &&
  (s.stressBps ?? 0) > 0 && (s.tByDay ?? 0) >= 1.65 && s.positiveSymbols >= 3;
const rows = OPENING_RULES.map(rule => {
  const stages = periods.map(period => ({ ...period, ...summarizeOpening(replayOpening(prepared[rule.interval], rule, period.from, period.to)) }));
  const diagnostic = rule.id === 'control' || rule.id === 'fast';
  return { id: rule.id, diagnostic, stages, paperCandidate: !diagnostic && stages.every(meetsGate) };
});

const coverage = Object.entries(thirty).map(([symbol, daily]) => ({ symbol, complete: daily.sessions.length, incomplete: daily.incomplete, through: daily.sessions.at(-1)?.day }));
writeFileSync(join(process.cwd(), 'lib', 'stocks', 'opening-evidence.json'), JSON.stringify({ rows, coverage, periods }, null, 2) + '\n');
console.table(rows.map(row => ({ rule: row.id, screen: row.stages[0].netBps?.toFixed(2), validation: row.stages[1].netBps?.toFixed(2), holdout: row.stages[2].netBps?.toFixed(2), highCosts: row.stages[2].stressBps?.toFixed(2), cfd: row.stages[2].cfdBps?.toFixed(2), holdoutTrades: row.stages[2].trades, candidate: row.paperCandidate })));
