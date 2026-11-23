import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntradayBar } from '@/lib/stocks/etoro';
import { regularStockSessions, replayStockIntraday, STOCK_INTRADAY_RULES, summarizeIntraday } from '@/lib/stocks/intraday';
import { STUDY_DIR, STUDY_END, STUDY_START, STUDY_SYMBOLS } from './stock-intraday-data';

const periods = [
  { label: '2025 screen', from: STUDY_START, to: '2026-01-01' },
  { label: '2026 H1 validation', from: '2026-01-01', to: '2026-07-01' },
  { label: '2026 H2 holdout', from: '2026-07-01', to: STUDY_END },
];
const history = Object.fromEntries(STUDY_SYMBOLS.map(symbol => {
  const input: IntradayBar[] = [];
  for (let from = Date.parse(STUDY_START); from < Date.parse(STUDY_END); from += 28 * 86_400_000) {
    const file = join(STUDY_DIR, `${symbol}-${new Date(from).toISOString().slice(0, 10)}.json`);
    if (!existsSync(file)) throw new Error(`Missing data: ${file}`);
    input.push(...JSON.parse(readFileSync(file, 'utf8')));
  }
  return [symbol, regularStockSessions(input)];
}));

const results = STOCK_INTRADAY_RULES.map(rule => {
  const markets = 'spyOnly' in rule ? ['SPY'] as const : STUDY_SYMBOLS;
  const passes = (slice: ReturnType<typeof summarizeIntraday>) =>
    slice.trades >= (markets.length === 1 ? 25 : 80) && slice.activeDays >= 25 &&
    (slice.netBps ?? 0) >= 3 && (slice.stressBps ?? 0) > 0 && (slice.tByDay ?? 0) >= 1.65 &&
    slice.positiveMarkets >= (markets.length === 1 ? 1 : 3);
  const stages = periods.map(p => {
    const byMarket = markets.map(symbol => replayStockIntraday(history[symbol].sessions, rule.id, p.from, p.to));
    return {
      ...p, ...summarizeIntraday(byMarket), markets: markets.map((symbol, i) => ({ symbol, ...summarizeIntraday([byMarket[i]]) })),
    };
  });
  return { id: rule.id, stages, paperCandidate: stages.every(passes) };
});

const coverage = STUDY_SYMBOLS.map(symbol => ({
  symbol, complete: history[symbol].sessions.length, incomplete: history[symbol].incomplete,
  first: history[symbol].sessions[0]?.day, last: history[symbol].sessions.at(-1)?.day,
}));
if (coverage.some(row => row.complete < 280)) throw new Error('Coverage is too sparse to publish the intraday study');
writeFileSync(join(process.cwd(), 'lib', 'stocks', 'intraday-evidence.json'), JSON.stringify({ from: STUDY_START, to: STUDY_END, coverage, results }, null, 2) + '\n');
console.table(results.map(r => ({ rule: r.id, screen: r.stages[0].netBps?.toFixed(2), validation: r.stages[1].netBps?.toFixed(2), holdout: r.stages[2].netBps?.toFixed(2), highCosts: r.stages[2].stressBps?.toFixed(2), trades: r.stages[2].trades, candidate: r.paperCandidate })));
