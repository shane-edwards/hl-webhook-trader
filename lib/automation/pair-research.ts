import type { createServiceClient } from '@/lib/supabase/server';
import { ideaId, ideasForPair } from './ideas';
import { enqueueIdea } from './queue';
import { trialAdmission } from './forward-trials';
import type { Evidence } from './model';
import { marketSearchPairs, searchDue, searchKey, searchRevision, SEARCH_RETRY_MS,
  type SearchJob, type SearchMarket, type SearchPair } from '@/lib/strategy-search/model';

type Db = ReturnType<typeof createServiceClient>;
type PairRun = SearchJob & { idea_id: string; verdict?: string | null; tracking?: boolean };
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

async function loadWork(db: Db, user: string, market: SearchMarket, ids?: string[]) {
  const domain = () => db.from('automation_runs').select('idea_id,status,as_of,revision:report->data->search->revision,verdict:report->data->search->>verdict,trial:report->data->trial->>state,book:report->data->search->forward->0->>state,evidence:report->evidence->0')
    .eq('user_id', user).eq('market', market).eq('kind', 'focused');
  // Keep repeated discovery rounds from displacing the latest named-strategy tests.
  const histories = ids ? [domain().in('idea_id', ids)] :
    [domain().like('idea_id', 'search:%'), domain().not('idea_id', 'like', 'search:%')];
  const [pages, pending] = await Promise.all([
    Promise.all(histories.map(query => query.order('created_at', { ascending: false }).limit(ids ? 48 : 800))),
    db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('user_id', user).eq('market', market)
      .eq('kind', 'focused').in('status', ['queued', 'running']),
  ]);
  if (pages.some(page => page.error) || pending.error) throw new Error('Could not read recent research work.');
  const history: PairRun[] = pages.flatMap(page => page.data ?? []).map(row => ({ ...row, revision: typeof row.revision === 'number' ? row.revision : null,
    tracking: ['tracking','data-gap'].includes(row.trial ?? row.book) || (!row.trial && !!row.evidence && !!trialAdmission(row.evidence as unknown as Evidence)) }));
  const latest = new Map<string, PairRun>();
  for (const row of history) if (!latest.has(row.idea_id)) latest.set(row.idea_id, row);
  return { latest, capacity: Math.max(0, limit - (pending.count ?? 0)) };
}

function dueTargets(pair: SearchPair, work: Awaited<ReturnType<typeof loadWork>>, now: number) {
  const key = searchKey(pair);
  return pairTargets(pair).filter(id => searchDue(work.latest.get(id), now, id === key, searchRevision(pair.market)));
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
  const work = await loadWork(db, user, pair.market, pairTargets(pair));
  const targets = dueTargets(pair, work, now);
  await Promise.all(targets.slice(0, work.capacity).map(id => queueTarget(db, user, pair, id, now, true)));
  return { waitingForCapacity: targets.length > work.capacity };
}

export async function initializeMarketResearch(db: Db, user: string, market: SearchMarket) {
  await ensureResearchProfile(db, user, market);
}

export function nextDiscoveryPair(market: SearchMarket, latest: Map<string, PairRun>, now: number) {
  return marketSearchPairs(market).flatMap(pair => {
    const last = latest.get(searchKey(pair));
    if (last?.status !== 'completed' || !last.verdict || last.verdict === 'insufficient-history' ||
        now - Date.parse(last.as_of) < 60 * 60_000) return [];
    return [{ pair, last }];
  }).sort((a, b) => Date.parse(a.last.as_of) - Date.parse(b.last.as_of))[0];
}

async function queueMarketBatch(db: Db, user: string, market: SearchMarket, now: number) {
  if (market === 'stocks' && !(await pairAccess(db, user, market)).connected) return 0;
  const work = await loadWork(db, user, market);
  // Refresh existing recommendations first, then fill coverage gaps across the whole catalog.
  const priority = (job?: PairRun) => job?.tracking || job?.verdict === 'paper-candidate' || job?.verdict === 'small-sample' ? 0 : !job || job.revision == null && job.status !== 'completed' ? 1 : 2;
  const catalog = marketSearchPairs(market);
  const jobs = catalog.flatMap(pair => dueTargets(pair, work, now).map(id => ({ pair, id })))
    .sort((a, b) => priority(work.latest.get(a.id)) - priority(work.latest.get(b.id)) ||
      Date.parse(work.latest.get(a.id)?.as_of ?? '1970-01-01') - Date.parse(work.latest.get(b.id)?.as_of ?? '1970-01-01'))
    .slice(0, Math.min(4, work.capacity));
  const checkpoint = catalog.flatMap(pair => pairTargets(pair).map(id => ({pair,id,last:work.latest.get(id)})))
    .filter(({last}) => last?.tracking && last.status === 'completed' && now - Date.parse(last.as_of) >= 3_600_000)
    .sort((a,b) => Date.parse(a.last!.as_of) - Date.parse(b.last!.as_of))[0];
  let tracked = 0;
  if (work.capacity && checkpoint && !jobs.some(j => j.id === checkpoint.id)) {
    const {pair,id,last} = checkpoint;
    tracked = Number(!!await enqueueIdea(db,user,{market,symbol:pair.symbol,id},new Date(now).toISOString(),`forward:${last!.as_of}:${id}`));
  }
  if (!jobs.length && work.capacity === limit) {
    const next = nextDiscoveryPair(market, work.latest, now);
    if (!next || next.last.idea_id === checkpoint?.id && tracked) return tracked;
    // Concurrent schedulers revisiting the same completed run share one successor.
    const { last, pair } = next;
    const queued = await enqueueIdea(db, user, { id: last.idea_id, market, symbol: pair.symbol },
      new Date(now).toISOString(), `discovery:${last.as_of}:${last.idea_id}`);
    return tracked + Number(!!queued);
  }
  const queued = await Promise.all(jobs.slice(0,work.capacity-tracked).map(({ pair, id }) => queueTarget(db, user, pair, id, now, false)));
  return tracked + queued.filter(Boolean).length;
}

export async function queueMarketSearches(db: Db, now: number) {
  const profiles = await db.from('automation_profiles').select('user_id,market').eq('enabled', true);
  if (profiles.error) throw new Error('Could not read automated research profiles.');
  const results = await Promise.all(profiles.data.map(({ user_id, market }: { user_id: string; market: SearchMarket }) =>
    queueMarketBatch(db, user_id, market, now)));
  return results.reduce((sum, value) => sum + value, 0);
}
