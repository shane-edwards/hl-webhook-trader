import { findIdea, ideaId, ideaSearchFrame } from '@/lib/automation/ideas';
import { automationVersion, type Evidence } from '@/lib/automation/model';
import { ruleKey, ruleName, RULE_INTERPRETER_VERSION, marketSearchPairs, RECOMMENDATION_FRESH_MS, SEARCH_ASSETS, SEARCH_FRAMES, SEARCH_REFRESH_MS,
  searchOutcomes, searchRevision, searchKey, searchPair, type SearchMarket, type SearchPair, type SearchReport, type SearchSide } from './model';

export type SearchRecord = { id: string; status: string; asOf: string; completedAt: string | null; report: SearchReport | null };
export type EvidenceRecord = { evidence: Evidence; asOf: string };
export type MarketSetup = {
  id: string; pair: SearchPair; name: string; through: string; stressedReturn: number;
  drawdown: number; trades: number; benchmark: number; kind: 'trade' | 'research'; side: SearchSide; ideaId?: string;
  ruleKey?: string; trial?: { count: number; net: number; complete: boolean }; paperCloses?: number;
};

function fresh(asOf: string, now: number, maxAge: number) {
  const age = now - Date.parse(asOf);
  return age >= 0 && age < maxAge;
}

export function researchRank(setup: Pick<MarketSetup, 'stressedReturn' | 'benchmark' | 'drawdown' | 'trades'>) {
  return (setup.stressedReturn - Math.max(0, setup.benchmark)) / Math.max(.02, setup.drawdown) *
    Math.sqrt(setup.trades / (setup.trades + 25));
}

export function summarizeMarketResearch(market: SearchMarket, searches: SearchRecord[], evidence: EvidenceRecord[], now: number) {
  const catalog = marketSearchPairs(market);
  const allowed = new Set(catalog.map(searchKey));
  const state = new Map<string, SearchRecord>();
  const completed = new Map<string, SearchRecord>();
  const setups: MarketSetup[] = [];
  let lastChecked: string | null = null;
  let scanned = 0, queued = 0, limited = 0;

  for (const row of searches) {
    if (!allowed.has(row.id)) continue;
    if (!state.has(row.id) || Date.parse(row.asOf) > Date.parse(state.get(row.id)!.asOf)) state.set(row.id, row);
    if (row.status === 'completed' && (!completed.has(row.id) || Date.parse(row.asOf) > Date.parse(completed.get(row.id)!.asOf))) {
      completed.set(row.id, row);
    }
  }
  for (const pair of catalog) {
    const id = searchKey(pair);
    const row = completed.get(id), report = row?.report;
    const current = row && report && report.revision === searchRevision(market) && searchKey(report.pair) === id &&
      fresh(row.asOf, now, SEARCH_REFRESH_MS);
    if (!current) {
      const active = state.get(id)?.status;
      if (active === 'queued' || active === 'running') queued++;
      if (active === 'failed') limited++;
      continue;
    }
    if (row.completedAt && (!lastChecked || Date.parse(row.completedAt) > Date.parse(lastChecked))) lastChecked = row.completedAt;
    if (report.verdict === 'insufficient-history' || !report.tried) {
      limited++;
      continue;
    }
    scanned++;
    for (const outcome of searchOutcomes(report)) {
      if (outcome.verdict !== 'paper-candidate' || !outcome.rule || !outcome.stress || !(outcome.stress.net > 0) ||
        market === 'crypto' && !(outcome.venue && outcome.venue.net > 0)) continue;
      const side = outcome.rule.side ?? 'long';
      const key = ruleKey(outcome.rule);
      const book = report.forward?.find(b => b.version === RULE_INTERPRETER_VERSION && ruleKey(b.rule) === key);
      if (book && (book.state === 'stopped' || book.state === 'archived' || book.state === 'data-gap' ||
        (book.state === 'completed' && book.equity <= 1))) continue;
      setups.push({ id: `${id}:${key}`, ruleKey: key, pair, name: ruleName(outcome.rule), through: report.through,
        trial: book ? { count: book.count, net: book.equity - 1, complete: book.state === 'completed' } : undefined,
        stressedReturn: outcome.stress.net, drawdown: outcome.stress.drawdown, trades: outcome.stress.trades,
        benchmark: outcome.benchmark ?? 0, kind: 'research', side });
    }
  }
  const latestEvidence = new Map<string, EvidenceRecord>();
  for (const item of evidence) {
    const row = item.evidence;
    if (row.market !== market || row.version !== automationVersion(market, row.symbol, row.rule) ||
      !fresh(item.asOf, now, RECOMMENDATION_FRESH_MS)) continue;
    if (!latestEvidence.has(row.version) || Date.parse(latestEvidence.get(row.version)!.asOf) < Date.parse(item.asOf)) {
      latestEvidence.set(row.version, item);
    }
  }
  for (const { evidence: row } of latestEvidence.values()) {
    const idea = findIdea(ideaId(market, row.rule, row.symbol));
    const pair = idea && searchPair(market, row.symbol, ideaSearchFrame(idea));
    if (!idea || !pair || !row.qualified || !(row.stress > 0)) continue;
    setups.push({ id: idea.id, pair, name: idea.name, through: row.through, stressedReturn: row.stress,
      drawdown: row.drawdown, trades: row.holdoutTrades, benchmark: row.benchmark, kind: idea.executable ? 'trade' : 'research', side: 'long', ideaId: idea.id });
  }
  setups.sort((a, b) => researchRank(b) - researchRank(a) || a.id.localeCompare(b.id));
  return { setups, coverage: { symbols: SEARCH_ASSETS[market].length, timeframes: SEARCH_FRAMES[market].length,
    total: catalog.length, scanned, queued, limited, lastChecked } };
}

export type MarketResearch = ReturnType<typeof summarizeMarketResearch> & { needsSetup: boolean; paused: boolean; connected: boolean };
