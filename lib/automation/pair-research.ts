import type { createServiceClient } from '@/lib/supabase/server';
import { ideaId, ideasForPair } from './ideas';
import { isoDay, type RunReport } from './model';
import { enqueueIdea } from './queue';
import { pairFromKey, scheduledPairs, searchDue, searchKey, RECOMMENDATION_FRESH_MS, SEARCH_RETRY_MS, SEARCH_REVISION,
  type SearchJob, type SearchMarket, type SearchPair } from '@/lib/strategy-search/model';

type Db = ReturnType<typeof createServiceClient>;
type PairRun = SearchJob & { idea_id: string; schedule_key: string | null };
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
  const domain = () => db.from('automation_runs').select('idea_id,status,as_of,schedule_key,revision:report->data->search->revision')
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
  return { history, latest, evidence, capacity: Math.max(0, limit - (pending.count ?? 0)) };
}

function dueTargets(pair: SearchPair, work: Awaited<ReturnType<typeof loadWork>>, now: number) {
  const key = searchKey(pair);
  return pairTargets(pair).filter(id => (id === key || !work.evidence.has(id)) && searchDue(work.latest.get(id), now, id === key));
}

function queueTarget(db: Db, user: string, pair: SearchPair, id: string, now: number, selected: boolean) {
  const cycle = Math.floor(now / SEARCH_RETRY_MS);
  const key = `${selected ? 'selection' : 'rotation'}:${SEARCH_REVISION}:${cycle}:${id}`;
  return enqueueIdea(db, user, { id, market: pair.market, symbol: pair.symbol }, new Date(now).toISOString(), key);
}

export async function queueSelectedPair(db: Db, user: string, pair: SearchPair, now: number) {
  const access = await pairAccess(db, user, pair.market);
  if (access.paused || !access.connected) return;
  if (!access.exists) {
    const created = await db.from('automation_profiles').upsert({ user_id: user, market: pair.market },
      { onConflict: 'user_id,market', ignoreDuplicates: true });
    if (created.error) throw new Error('Could not initialize strategy research.');
  }
  const work = await loadWork(db, user, pair.market, now, pairTargets(pair));
  const targets = dueTargets(pair, work, now);
  await Promise.all(targets.slice(0, work.capacity).map(id => queueTarget(db, user, pair, id, now, true)));
  return { waitingForCapacity: targets.length > work.capacity };
}

export async function queueRotatingPairs(db: Db, now: number) {
  const profiles = await db.from('automation_profiles').select('user_id,market').eq('enabled', true);
  if (profiles.error) throw new Error('Could not read automated research profiles.');
  const results = await Promise.all(profiles.data.map(async ({ user_id, market }: { user_id: string; market: SearchMarket }) => {
    if (market === 'stocks' && !(await pairAccess(db, user_id, market)).connected) return 0;
    const work = await loadWork(db, user_id, market, now);
    const watched = work.history.flatMap(row => {
      if (row.schedule_key !== null && !row.schedule_key.startsWith('selection:')) return [];
      if (now - Date.parse(row.as_of) > 45 * 86_400_000) return [];
      const pair = pairFromKey(row.idea_id);
      return pair ? [pair] : [];
    });
    const pairs = [...new Map([...watched, ...scheduledPairs(market, isoDay(now))].map(pair => [searchKey(pair), pair])).values()];
    const jobs = pairs.flatMap(pair => dueTargets(pair, work, now).map(id => ({ pair, id }))).slice(0, Math.min(4, work.capacity));
    const queued = await Promise.all(jobs.map(({ pair, id }) => queueTarget(db, user_id, pair, id, now, false)));
    return queued.filter(Boolean).length;
  }));
  return results.reduce((sum, value) => sum + value, 0);
}
