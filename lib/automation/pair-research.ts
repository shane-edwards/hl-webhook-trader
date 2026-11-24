import type { createServiceClient } from '@/lib/supabase/server';
import { ideaId, ideasForPair } from './ideas';
import type { RunReport } from './model';
import { enqueueIdea } from './queue';
import { marketSearchPairs, searchDue, searchKey, searchRevision, RECOMMENDATION_FRESH_MS, SEARCH_RETRY_MS,
  type SearchJob, type SearchMarket, type SearchPair } from '@/lib/strategy-search/model';

type Db = ReturnType<typeof createServiceClient>;
type PairRun = SearchJob & { idea_id: string; verdict?: string | null };
type DailyRun = { as_of: string; report: RunReport | null };
const limit = 12;

function pairTargets(pair: SearchPair) {
  return [searchKey(pair), ...ideasForPair(pair).map(idea => ideaId(pair.market, idea.rule, pair.symbol))];
}

export async function pairAccess(db: Db, user: string, market: SearchMarket) {
  const [profile, feed] = await Promise.all([
    db.from('automation_profiles').select('enabled').eq('user_id', user).eq('market', market).maybeSingle(),
    market === 'stocks' ? db.from('etoro_connections').select('environment').eq('user_id', user).limit(1) : null,
  ]);
  if (profile.error || feed?.error) throw new Error('Could not check research access.');
  return { exists: !!profile.data, paused: profile.data?.enabled === false, connected: !feed || feed.data.length > 0 };
}

async function loadWork(db: Db, user: string, market: SearchMarket, now: number, ids?: string[]) {
  const domain = () => db.from('automation_runs').select('idea_id,status,as_of,revision:report->data->search->revision,verdict:report->data->search->>verdict')
    .eq('user_id', user).eq('market', market).eq('kind', 'focused');
  const [rows, pending, daily] = await Promise.all([
    (ids ? domain().in('idea_id', ids) : domain()).order('created_at', { ascending: false }).limit(ids ? 48 : 800),
    db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('user_id', user).eq('market', market)
      .eq('kind', 'focused').in('status', ['queued', 'running']),
    db.from('automation_runs').select('as_of,report').eq('user_id', user).eq('market', market).eq('kind', 'daily')
      .eq('status', 'completed').gte('as_of', new Date(now - RECOMMENDATION_FRESH_MS).toISOString())
      .order('as_of', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (rows.error || pending.error || daily.error) throw new Error('Could not read recent research work.');
  const history: PairRun[] = rows.data.map(row => ({ ...row, revision: typeof row.revision === 'number' ? row.revision : null }));
  const latest = new Map<string, PairRun>();
  for (const row of history) if (!latest.has(row.idea_id)) latest.set(row.idea_id, row);
  const report = (daily.data as DailyRun | null)?.report;
  const evidence = new Set(report?.data.missing?.some(item => item.symbol !== 'eToro journal') ? [] :
    report?.evidence.map(item => ideaId(item.market, item.rule, item.symbol)));
  return { latest, evidence, capacity: Math.max(0, limit - (pending.count ?? 0)) };
}

function dueTargets(pair: SearchPair, work: Awaited<ReturnType<typeof loadWork>>, now: number) {
  const key = searchKey(pair);
  return pairTargets(pair).filter(id => (id === key || !work.evidence.has(id)) &&
    searchDue(work.latest.get(id), now, id === key, searchRevision(pair.market)));
}

function queueTarget(db: Db, user: string, pair: SearchPair, id: string, now: number, selected: boolean) {
  const cycle = Math.floor(now / SEARCH_RETRY_MS);
  const key = `${selected ? 'selection' : 'rotation'}:${searchRevision(pair.market)}:${cycle}:${id}`;
  return enqueueIdea(db, user, { id, market: pair.market, symbol: pair.symbol }, new Date(now).toISOString(), key);
}

async function ensureResearchProfile(db: Db, user: string, market: SearchMarket) {
  const access = await pairAccess(db, user, market);
  if (access.paused || !access.connected) return false;
  if (!access.exists) {
    const created = await db.from('automation_profiles').upsert({ user_id: user, market },
      { onConflict: 'user_id,market', ignoreDuplicates: true });
    if (created.error) throw new Error('Could not initialize strategy research.');
  }
  return true;
}

export async function queueSelectedPair(db: Db, user: string, pair: SearchPair, now: number) {
  if (!await ensureResearchProfile(db, user, pair.market)) return;
  const work = await loadWork(db, user, pair.market, now, pairTargets(pair));
  const targets = dueTargets(pair, work, now);
  await Promise.all(targets.slice(0, work.capacity).map(id => queueTarget(db, user, pair, id, now, true)));
  return { waitingForCapacity: targets.length > work.capacity };
}

export async function initializeMarketResearch(db: Db, user: string, market: SearchMarket) {
  await ensureResearchProfile(db, user, market);
}

async function queueMarketBatch(db: Db, user: string, market: SearchMarket, now: number) {
  if (market === 'stocks' && !(await pairAccess(db, user, market)).connected) return 0;
  const work = await loadWork(db, user, market, now);
  // Refresh existing recommendations first, then fill coverage gaps across the whole catalog.
  const priority = (job?: PairRun) => job?.verdict === 'paper-candidate' ? 0 : !job || job.revision == null && job.status !== 'completed' ? 1 : 2;
  const jobs = marketSearchPairs(market).flatMap(pair => dueTargets(pair, work, now).map(id => ({ pair, id })))
    .sort((a, b) => priority(work.latest.get(a.id)) - priority(work.latest.get(b.id)) ||
      Date.parse(work.latest.get(a.id)?.as_of ?? '1970-01-01') - Date.parse(work.latest.get(b.id)?.as_of ?? '1970-01-01'))
    .slice(0, Math.min(4, work.capacity));
  const queued = await Promise.all(jobs.map(({ pair, id }) => queueTarget(db, user, pair, id, now, false)));
  return queued.filter(Boolean).length;
}

export async function queueMarketSearches(db: Db, now: number) {
  const profiles = await db.from('automation_profiles').select('user_id,market').eq('enabled', true);
  if (profiles.error) throw new Error('Could not read automated research profiles.');
  const results = await Promise.all(profiles.data.map(({ user_id, market }: { user_id: string; market: SearchMarket }) =>
    queueMarketBatch(db, user_id, market, now)));
  return results.reduce((sum, value) => sum + value, 0);
}
