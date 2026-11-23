import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntradayBar } from '@/lib/stocks/etoro';
import { alignFactorSessions, FACTOR_RULES, runFactorRule, type EarningsFiling } from '@/lib/stocks/factor-research';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { EVENTS_DIR, EVENT_ISSUERS } from './stock-events-data';
import { OPENING_BASKET, OPENING_DIR, OPENING_END, OPENING_START, OPENING_WINDOW } from './stock-opening-data';

const parts = [
  { label: '2025 price signal', from: OPENING_START, to: '2026-01-01' },
  { label: '2026 Q2 validation', from: '2026-04-01', to: '2026-07-01' },
  { label: '2026 H2 later test', from: '2026-07-01', to: OPENING_END },
];
const history = Object.fromEntries(OPENING_BASKET.map(symbol => {
  const bars: IntradayBar[] = [];
  for (let from = Date.parse(OPENING_START); from < Date.parse(OPENING_END); from += OPENING_WINDOW) {
    const path = join(OPENING_DIR, `${symbol}-${new Date(from).toISOString().slice(0, 10)}.json`);
    bars.push(...JSON.parse(readFileSync(path, 'utf8')));
  }
  const regular = regularStockSessions(bars, 30);
  if (regular.sessions.length < 330) throw new Error(`Insufficient paired sessions for ${symbol}`);
  return [symbol, regular.sessions];
}));
const filings = Object.fromEntries(Object.keys(EVENT_ISSUERS).map(symbol => [symbol, JSON.parse(readFileSync(join(EVENTS_DIR, `${symbol}.json`), 'utf8')) as EarningsFiling[]]));
const data = alignFactorSessions(history, filings);
type Summary = ReturnType<typeof runFactorRule>;
const enough = (s: Summary, earnings: boolean) => s.trades >= (earnings ? 15 : 50) && s.activeDays >= (earnings ? 12 : 35);
const passes = (s: Summary, earnings: boolean) => enough(s, earnings) && (s.netBps ?? 0) >= 3 && (s.stressBps ?? 0) > 0 && (s.tByDay ?? 0) >= 1.65 && s.positiveSymbols >= 3;
const selectionScore = (stages: Summary[]) => Math.min(stages[0].grossBps ?? -Infinity, stages[1].stressBps ?? -Infinity);
const previouslyExamined = new Set(['rev-2-2-0.006-1', 'close-0.006', 'event--1-0.01-2']);

const screened = FACTOR_RULES.map(rule => {
  const stages = parts.slice(0, 2).map((p, i) => runFactorRule(data, rule, p.from, p.to, i === 0 ? Infinity : 10));
  const earnings = rule.family === 'earnings';
  const discovery = stages[0];
  const valid = (discovery.grossBps ?? 0) >= 3 && enough(discovery, earnings) && passes(stages[1], earnings);
  return { rule, stages, selected: valid && !previouslyExamined.has(rule.id), enough: stages.every(s => enough(s, earnings)) };
});

// Later returns are evaluated once per family, after making the decision from
// the first two periods. A failed screen can be shown for context only.
const rows = (['reversal', 'close', 'earnings'] as const).map(family => {
  const familyRows = screened.filter(row => row.rule.family === family);
  const order = [...familyRows].sort((a, b) => Number(b.selected) - Number(a.selected) || Number(b.enough) - Number(a.enough) || selectionScore(b.stages) - selectionScore(a.stages));
  const best = order[0];
  const later = runFactorRule(data, best.rule, parts[2].from, parts[2].to);
  return {
    family, rule: best.rule, tested: familyRows.length, selected: familyRows.filter(r => r.selected).length,
    stages: [...best.stages, later], previouslyExamined: previouslyExamined.has(best.rule.id), paperCandidate: best.selected && passes(later, family === 'earnings'),
  };
});

const eventCount = [...data.values()].flat().filter(c => c.earningsGap != null).length;
const coverage = Object.entries(history).map(([symbol, sessions]) => ({ symbol, sessions: sessions.length }));
const quoteAudit = parts.map(period => {
  const spreads = Object.values(history).flatMap(sessions => sessions.filter(s => s.day >= period.from && s.day < period.to)
    .flatMap(s => s.bars.slice(1).map(b => (b.askOpen - b.bidOpen) / ((b.askOpen + b.bidOpen) / 2) * 10_000))).sort((a, b) => a - b);
  return { label: period.label, count: spreads.length, medianBps: spreads[Math.floor(spreads.length / 2)], underTen: spreads.filter(x => x <= 10).length };
});
const eventLead = FACTOR_RULES.find(rule => rule.id === 'event--1-0.01-12')!;
const otherGapControl = runFactorRule(data, eventLead, parts[2].from, parts[2].to, 10, true);
writeFileSync(join(process.cwd(), 'lib', 'stocks', 'factor-evidence.json'), JSON.stringify({ parts, rows, coverage, eventCount, quoteAudit, otherGapControl }, null, 2) + '\n');
console.table(rows.map(r => ({
  family: r.family, rule: r.rule.name, tested: r.tested, selected: r.selected,
  screenGross: r.stages[0].grossBps?.toFixed(2), validation: r.stages[1].netBps?.toFixed(2), holdout: r.stages[2].netBps?.toFixed(2),
  stress: r.stages[2].stressBps?.toFixed(2), holdoutTrades: r.stages[2].trades, paper: r.paperCandidate,
})));
