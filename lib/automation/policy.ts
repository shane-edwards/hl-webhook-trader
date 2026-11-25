import type { createServiceClient } from '@/lib/supabase/server';
import { brokerStockGross } from '@/lib/stocks/strategy-guard';
import type { StockJournalOrder } from '@/lib/stocks/execution-journal';
import { automationVersion, paperThreshold, type AutomationMarket, type AutomationProfile, type Evidence, type RunReport } from './model';
import { findIdea, ideaId } from './ideas';
import { trialAdmission } from './forward-trials';

type Db = ReturnType<typeof createServiceClient>;
const day = 86_400_000;
export type PaperResults = ReturnType<typeof paperThreshold>;
export type AutomationDecision = { profile: AutomationProfile | null; candidate: Evidence | null; results: PaperResults | null;
  paperTests?: Evidence[];
  decision: 'legacy' | 'paused' | 'research' | 'paper' | 'live' | 'waiting'; detail: string };

export async function readAutomationProfile(db: Db, userId: string, market: AutomationMarket) {
  const saved = await db.from('automation_profiles').select('*').eq('user_id', userId).eq('market', market).maybeSingle();
  if (saved.error) throw new Error('Could not read Automation Center controls.');
  return saved.data as AutomationProfile | null;
}

export async function latestCandidates(db: Db, userId: string, market: AutomationMarket, now = Date.now()) {
  const result = await db.from('automation_runs').select('report, as_of').eq('user_id', userId).eq('market', market)
    .eq('kind', 'daily').eq('status', 'completed').gte('as_of', new Date(now - 4 * day).toISOString())
    .order('as_of', { ascending: false }).order('completed_at', { ascending: false }).limit(1).maybeSingle();
  if (result.error) throw new Error('Could not read the latest completed research.');
  const report = result.data?.report as RunReport | undefined;
  return (report?.evidence ?? []).filter(item => item.qualified &&
    item.version === automationVersion(market, item.symbol, item.rule)).sort((a, b) => b.stress - a.stress);
}

export async function exactCandidate(db: Db, userId: string, market: AutomationMarket, version: string, now = Date.now()) {
  const [, scope, symbol, rule] = version.split('.');
  if (scope !== market || version !== automationVersion(market, symbol, rule)) return null;
  const idea = findIdea(ideaId(market, rule, symbol));
  if (!idea?.executable) return null;
  const fresh = new Date(now - 4 * day).toISOString();
  const [focused, daily] = await Promise.all([
    db.from('automation_runs').select('report, as_of').eq('user_id', userId).eq('market', market).eq('kind', 'focused')
      .eq('status', 'completed').eq('idea_id', idea.id).gte('as_of', fresh)
      .order('as_of', { ascending: false }).limit(1).maybeSingle(),
    db.from('automation_runs').select('report, as_of').eq('user_id', userId).eq('market', market).eq('kind', 'daily')
      .eq('status', 'completed').gte('as_of', fresh).order('as_of', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (focused.error || daily.error) throw new Error('Could not verify this version’s research.');
  const latest = [focused.data, daily.data].flatMap(data => {
    const evidence = (data?.report as RunReport | undefined)?.evidence?.find(item => item.version === version);
    return data && evidence ? [{ asOf: data.as_of, evidence }] : [];
  }).sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf))[0]?.evidence;
  return latest?.qualified ? latest : null;
}

export async function opportunityCandidates(db: Db, userId: string, market: AutomationMarket, exploratory = false) {
  const fresh = new Date(Date.now() - 4 * day).toISOString();
  const [daily, focused] = await Promise.all([
    db.from('automation_runs').select('report, as_of').eq('user_id', userId).eq('market', market).eq('kind', 'daily').eq('status', 'completed')
      .gte('as_of', fresh).order('as_of', { ascending: false }).limit(1).maybeSingle(),
    db.from('automation_runs').select('report, as_of').eq('user_id', userId).eq('market', market).eq('kind', 'focused').eq('status', 'completed')
      .not('idea_id', 'like', 'search:%').gte('as_of', fresh).order('as_of', { ascending: false }).limit(150),
  ]);
  if (daily.error || focused.error) throw new Error('Could not verify opportunity research.');
  const reports = [...(focused.data ?? []), ...(daily.data ? [daily.data] : [])].sort((a, b) => Date.parse(b.as_of) - Date.parse(a.as_of));
  const latest = new Map<string, Evidence>();
  for (const row of reports) for (const item of (row.report as RunReport | null)?.evidence ?? []) {
    const idea = findIdea(ideaId(market, item.rule, item.symbol));
    if (idea?.executable && item.version === automationVersion(market, item.symbol, item.rule) && !latest.has(item.version)) latest.set(item.version, item);
  }
  return [...latest.values()].filter(item => exploratory ? trialAdmission(item) !== null : item.qualified).sort((a, b) => b.stress - a.stress);
}

export async function liveOpportunityCandidates(db: Db, userId: string, market: AutomationMarket, versions?: readonly string[]) {
  const candidates = (await opportunityCandidates(db, userId, market)).filter(item => !versions || versions.includes(item.version));
  const verified = await Promise.all(candidates.map(async candidate => ({ candidate, results: await readPaperResults(db, userId, candidate) })));
  return verified.filter(row => row.results.passed);
}

export async function readPaperResults(db: Db, userId: string, candidate: Evidence) {
  if (candidate.market === 'crypto') {
    const result = await db.from('autopilot_positions').select('pnl, exit_time').eq('user_id', userId).eq('mode', 'paper')
      .eq('automation_version', candidate.version).eq('paper_book_fill', true).eq('status', 'closed').not('pnl', 'is', null).not('exit_time', 'is', null)
      .order('exit_time', { ascending: false }).limit(30);
    if (result.error) throw new Error('Could not read the versioned crypto Paper book.');
    return paperThreshold(result.data.map(row => ({ at: row.exit_time, pnl: Number(row.pnl) })));
  }
  const result = await db.from('etoro_stock_orders').select('closed_at, fill_metrics, close_execution, statement_result, estimated_costs')
    .eq('user_id', userId).eq('environment', 'demo').eq('automation_version', candidate.version)
    .eq('state', 'filled').not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(75);
  if (result.error) throw new Error('Could not read the versioned eToro Demo book.');
  return paperThreshold((result.data as StockJournalOrder[]).flatMap(row => {
    const pnl = stockDemoNet(row);
    return row.closed_at && pnl != null ? [{ at: row.closed_at, pnl }] : [];
  }));
}

export function stockDemoNet(row: Pick<StockJournalOrder, 'closed_at' | 'statement_result' | 'fill_metrics' | 'close_execution' | 'estimated_costs'>) {
  if (!row.closed_at) return null;
  if (row.statement_result) return row.statement_result.netUsd;
  const gross = brokerStockGross(row);
  if (gross == null || row.fill_metrics?.feesUsd == null || row.fill_metrics.taxesUsd == null) return null;
  const estimate = (row.estimated_costs ?? []).filter(cost => cost.currency.toUpperCase() === 'USD' && ['transactionFee', 'sdrt', 'markup'].includes(cost.costType))
    .reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
  const paid = row.fill_metrics.feesUsd + row.fill_metrics.taxesUsd;
  return gross - paid - Math.max(1, estimate, paid);
}

// Resolve the actual paper runner, including older profiles that follow the best daily candidate.
export async function paperVersionsInUse(db: Db, userId: string, market: AutomationMarket) {
  const versions = new Set<string>();
  const profile = await readAutomationProfile(db, userId, market);
  if (profile?.mode !== 'paper' || !profile.enabled || profile.entries_paused) return versions;
  if (market === 'stocks') {
    const demo = await db.from('etoro_connections').select('environment').eq('user_id', userId).eq('environment', 'demo').maybeSingle();
    if (demo.error) throw new Error('Could not verify paper trading status.');
    if (!demo.data) return versions;
  }
  if (profile.scan_for_opportunities) {
    for (const candidate of await opportunityCandidates(db, userId, market, market === 'crypto')) versions.add(candidate.version);
  } else {
    const version = profile.paper_version ?? (await latestCandidates(db, userId, market))[0]?.version;
    if (version) versions.add(version);
  }
  return versions;
}

export async function automationDecision(db: Db, userId: string, market: AutomationMarket,
  pickSignal?: (candidates: Evidence[], mode: 'paper' | 'live') => Promise<Evidence | null>): Promise<AutomationDecision> {
  const profile = await readAutomationProfile(db, userId, market);
  const response = (decision: AutomationDecision['decision'], detail: string, candidate: Evidence | null = null,
    results: PaperResults | null = null): AutomationDecision => ({ profile, decision, detail, candidate, results });
  if (profile?.entries_paused) return response('paused', 'New automated entries are paused.');
  if (!profile || profile.mode === 'research') return response('legacy', 'Research can run alongside your existing Autopilot settings.');
  if (!profile.enabled) return response('paused', 'Automation is paused.');
  if (profile.scan_for_opportunities) {
    const mode = profile.mode;
    if (market === 'stocks') {
      const environment = mode === 'paper' ? 'demo' : 'real';
      const connection = await db.from('etoro_connections').select('environment').eq('user_id', userId).eq('environment', environment).maybeSingle();
      if (connection.error) throw new Error('Could not read the eToro connection.');
      if (!connection.data) return response('waiting', `Connect eToro ${mode === 'paper' ? 'Demo' : 'Real'} to start scanning.`);
    }
    const live = mode === 'live' ? await liveOpportunityCandidates(db, userId, market, profile.live_scan_versions ?? []) : [];
    const independent = mode === 'paper' && market === 'crypto';
    const candidates = mode === 'live' ? live.map(row => row.candidate) : await opportunityCandidates(db, userId, market, independent);
    if (independent && candidates.length)
      return { ...response('paper', 'Forward testing every eligible signal.', candidates[0]), paperTests: candidates };
    if (!candidates.length) return response('waiting', 'Waiting for a strategy to pass its backtest.');
    const candidate = pickSignal ? await pickSignal(candidates, mode) : candidates[0];
    return candidate ? response(mode, mode === 'live' ? 'Scanning approved Live strategies.' : 'Scanning qualified strategies in Paper.', candidate,
      live.find(row => row.candidate.version === candidate.version)?.results ?? await readPaperResults(db, userId, candidate)) :
      response('waiting', 'Waiting for a qualified entry signal.');
  }
  const version = profile.mode === 'live' ? profile.live_version : profile.paper_version;
  const candidate = version ? await exactCandidate(db, userId, market, version) : (await latestCandidates(db, userId, market))[0];
  if (!candidate) return response('waiting', 'Waiting for a strategy version to pass the current research checks.');
  const results = await readPaperResults(db, userId, candidate);
  if (profile.mode === 'live') {
    if (!results.passed) return response('waiting', 'The approved version is below the current Paper requirement.', candidate, results);
    return response('live', 'Approved version ready for Live entry checks.', candidate, results);
  }
  if (market === 'stocks') {
    const demo = await db.from('etoro_connections').select('environment').eq('user_id', userId).eq('environment', 'demo').maybeSingle();
    if (demo.error) throw new Error('Could not check the stock Paper connection.');
    if (!demo.data) return response('waiting', 'A version passed research. Connect eToro Demo to start Paper.', candidate, results);
  }
  return response('paper', 'Qualified version ready for automatic Paper testing.', candidate, results);
}

export async function sameAutomationProfile(db: Db, original: AutomationProfile | null, userId: string, market: AutomationMarket) {
  const current = await readAutomationProfile(db, userId, market);
  return !current?.entries_paused && (current?.updated_at ?? null) === (original?.updated_at ?? null);
}
