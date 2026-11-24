import type { createServiceClient } from '@/lib/supabase/server';
import { brokerStockGross } from '@/lib/stocks/strategy-guard';
import type { StockJournalOrder } from '@/lib/stocks/execution-journal';
import { automationVersion, paperThreshold, type AutomationMarket, type AutomationProfile, type Evidence, type RunReport } from './model';

type Db = ReturnType<typeof createServiceClient>;
const day = 86_400_000;
export type PaperResults = ReturnType<typeof paperThreshold>;
export type AutomationDecision = { profile: AutomationProfile | null; candidate: Evidence | null; results: PaperResults | null;
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

export async function readPaperResults(db: Db, userId: string, candidate: Evidence) {
  if (candidate.market === 'crypto') {
    const result = await db.from('autopilot_positions').select('pnl, exit_time').eq('user_id', userId).eq('mode', 'paper')
      .eq('automation_version', candidate.version).eq('status', 'closed').not('pnl', 'is', null).not('exit_time', 'is', null)
      .order('exit_time', { ascending: false }).limit(30);
    if (result.error) throw new Error('Could not read the versioned crypto Paper book.');
    return paperThreshold(result.data.map(row => ({ at: row.exit_time, pnl: Number(row.pnl) })));
  }
  const result = await db.from('etoro_stock_orders').select('closed_at, fill_metrics, close_execution, statement_result, estimated_costs')
    .eq('user_id', userId).eq('environment', 'demo').eq('automation_version', candidate.version)
    .eq('state', 'filled').not('closed_at', 'is', null).order('closed_at', { ascending: false }).limit(75);
  if (result.error) throw new Error('Could not read the versioned eToro Demo book.');
  return paperThreshold((result.data as StockJournalOrder[]).flatMap(row => {
    if (row.statement_result && row.closed_at) return [{ at: row.closed_at, pnl: row.statement_result.netUsd }];
    const gross = brokerStockGross(row);
    if (gross == null || !row.closed_at || row.fill_metrics?.feesUsd == null || row.fill_metrics.taxesUsd == null) return [];
    // Demo cash evidence uses broker execution prices and a conservative allowance for the exit fee.
    const estimate = (row.estimated_costs ?? []).filter(cost => cost.currency.toUpperCase() === 'USD' && ['transactionFee', 'sdrt', 'markup'].includes(cost.costType))
      .reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
    const paid = row.fill_metrics.feesUsd + row.fill_metrics.taxesUsd;
    return [{ at: row.closed_at, pnl: gross - paid - Math.max(1, estimate, paid) }];
  }));
}

export async function automationDecision(db: Db, userId: string, market: AutomationMarket): Promise<AutomationDecision> {
  const profile = await readAutomationProfile(db, userId, market);
  const response = (decision: AutomationDecision['decision'], detail: string, candidate: Evidence | null = null,
    results: PaperResults | null = null): AutomationDecision => ({ profile, decision, detail, candidate, results });
  if (profile?.entries_paused) return response('paused', 'New automated entries are paused.');
  if (!profile || profile.mode === 'research') return response('legacy', 'Research can run alongside your existing Autopilot settings.');
  if (!profile.enabled) return response('paused', 'Automation is paused.');
  const candidates = await latestCandidates(db, userId, market);
  const candidate = profile.mode === 'live' ? candidates.find(item => item.version === profile.live_version) : candidates[0];
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
