import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { initializeMarketResearch, pairAccess, queueSelectedPair } from '@/lib/automation/pair-research';
import { readMarketResearch } from '@/lib/automation/market-research';
import { isSearchMarket, SEARCH_REFRESH_MS, SEARCH_REVISION, searchDue, searchKey, searchPair, type SearchPair, type SearchReport } from '@/lib/strategy-search/model';

async function currentUser() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  return user;
}

async function searchStatus(db: ReturnType<typeof createServiceClient>, user: string, pair: SearchPair, waitingForCapacity = false) {
  const [result, access] = await Promise.all([
    db.from('automation_runs').select('status,report,as_of,detail,completed_at').eq('user_id', user)
      .eq('market', pair.market).eq('kind', 'focused').eq('idea_id', searchKey(pair)).order('created_at', { ascending: false }).limit(8),
    pairAccess(db, user, pair.market),
  ]);
  if (result.error) throw new Error('Could not read strategy research.');
  const now = Date.now();
  const latest = result.data[0];
  const completed = result.data.find(row => row.status === 'completed' && row.report?.data?.search);
  const report: SearchReport | null = completed?.report?.data?.search ?? null;
  const fresh = report?.revision === SEARCH_REVISION && now - Date.parse(completed!.as_of) < SEARCH_REFRESH_MS;
  const due = searchDue(latest && { ...latest, revision: latest.report?.data?.search?.revision }, now, true);
  const status = access.paused ? 'paused' : !access.connected ? 'connect' : latest?.status === 'running' || latest?.status === 'queued'
    ? latest.status : waitingForCapacity && due ? 'busy' : latest?.status ?? 'new';
  return { status, report, fresh, completedAt: completed?.completed_at ?? null, detail: latest?.detail ?? null,
    canStart: access.connected && !access.paused && (due || waitingForCapacity) };
}

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const market = query.get('market');
  try {
    const db = createServiceClient();
    if (isSearchMarket(market) && !query.has('symbol') && !query.has('frame')) return NextResponse.json(await readMarketResearch(db, user.id, market));
    const pair = searchPair(market, query.get('symbol'), query.get('frame'));
    return NextResponse.json(pair ? await searchStatus(db, user.id, pair) : { status: 'unsupported', report: null, canStart: false });
  } catch {
    return NextResponse.json({ error: 'Could not read strategy research.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const db = createServiceClient();
  try {
    if (isSearchMarket(body?.market) && body.symbol === undefined && body.frame === undefined) {
      await initializeMarketResearch(db, user.id, body.market);
      return NextResponse.json(await readMarketResearch(db, user.id, body.market));
    }
    const pair = searchPair(body?.market, body?.symbol, body?.frame);
    if (!pair) return NextResponse.json({ status: 'unsupported', report: null, canStart: false });
    const queued = await queueSelectedPair(db, user.id, pair, Date.now());
    return NextResponse.json(await searchStatus(db, user.id, pair, queued?.waitingForCapacity));
  } catch {
    return NextResponse.json({ error: 'Could not queue strategy research.' }, { status: 503 });
  }
}
