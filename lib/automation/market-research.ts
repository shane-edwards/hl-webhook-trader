import type { createServiceClient } from '@/lib/supabase/server';
import { pairAccess } from './pair-research';
import type { RunReport } from './model';
import { RECOMMENDATION_FRESH_MS, SEARCH_REFRESH_MS, type SearchMarket, type SearchReport } from '@/lib/strategy-search/model';
import { summarizeMarketResearch, type MarketResearch } from '@/lib/strategy-search/recommendations';

type Db = ReturnType<typeof createServiceClient>;

export async function readMarketResearch(db: Db, user: string, market: SearchMarket, now = Date.now()): Promise<MarketResearch> {
  const research = () => db.from('automation_runs').select('idea_id,status,as_of,completed_at,report')
    .eq('user_id', user).eq('market', market);
  const evidenceCutoff = new Date(now - RECOMMENDATION_FRESH_MS).toISOString();
  const [searches, daily, named, access] = await Promise.all([
    research().eq('kind', 'focused').like('idea_id', 'search:%')
      .gte('as_of', new Date(now - SEARCH_REFRESH_MS).toISOString()).order('as_of', { ascending: false }).limit(650),
    research().eq('kind', 'daily').eq('status', 'completed').gte('as_of', evidenceCutoff)
      .order('as_of', { ascending: false }).limit(1).maybeSingle(),
    research().eq('kind', 'focused').not('idea_id', 'like', 'search:%').eq('status', 'completed').gte('as_of', evidenceCutoff)
      .order('as_of', { ascending: false }).limit(300),
    pairAccess(db, user, market),
  ]);
  if (searches.error || daily.error || named.error) throw new Error('Could not read market recommendations.');
  const summaries = searches.data.map(row => ({ id: row.idea_id, status: row.status, asOf: row.as_of, completedAt: row.completed_at,
    report: ((row.report as RunReport | null)?.data?.search as SearchReport | undefined) ?? null }));
  const evidence = [...named.data, ...(daily.data ? [daily.data] : [])].flatMap(row =>
    ((row.report as RunReport | null)?.evidence ?? []).map(evidence => ({ evidence, asOf: row.as_of })));
  const dashboard = summarizeMarketResearch(market, summaries, evidence, now);
  return { ...dashboard, needsSetup: !access.exists && access.connected, paused: access.paused, connected: access.connected };
}
