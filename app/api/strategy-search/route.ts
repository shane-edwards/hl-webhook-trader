import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { enqueueSearch } from '@/lib/automation/queue';
import { SEARCH_REVISION, searchKey, searchPair, type SearchPair } from '@/lib/strategy-search/model';

async function currentUser() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  return user;
}

async function searchStatus(db: ReturnType<typeof createServiceClient>, user: string, pair: SearchPair) {
  const result = await db.from('automation_runs').select('status,report,created_at,detail').eq('user_id', user)
    .eq('market', pair.market).eq('kind', 'focused').eq('idea_id', searchKey(pair)).order('created_at', { ascending: false }).limit(8);
  if (result.error) throw new Error('Could not read strategy research.');
  const latest = result.data[0];
  const completed = result.data.find(row => row.report?.data?.search?.revision === SEARCH_REVISION);
  const ttl = latest?.status === 'failed' ? 12 * 3_600_000 : 7 * 86_400_000;
  return { status: latest?.status ?? 'new', detail: latest?.detail ?? null, report: completed?.report?.data?.search ?? null,
    canStart: !latest || !['queued', 'running'].includes(latest.status) && Date.now() - Date.parse(latest.created_at) >= ttl };
}

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const pair = searchPair(query.get('market'), query.get('symbol'), query.get('frame'));
  if (!pair) return NextResponse.json({ status: 'unsupported', report: null, canStart: false });
  try {
    return NextResponse.json(await searchStatus(createServiceClient(), user.id, pair));
  } catch {
    return NextResponse.json({ error: 'Could not read strategy research.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const pair = searchPair(body?.market, body?.symbol, body?.frame);
  if (!pair) return NextResponse.json({ status: 'unsupported', report: null, canStart: false });
  const db = createServiceClient();
  try {
    const status = await searchStatus(db, user.id, pair);
    if (!status.canStart) return NextResponse.json(status);
    if (pair.market === 'stocks') {
      const feed = await db.from('etoro_connections').select('environment').eq('user_id', user.id).limit(1);
      if (feed.error) throw new Error('Could not check the market-data feed.');
      if (!feed.data.length) return NextResponse.json({ ...status, status: 'connect', canStart: false });
    }
    const pending = await db.from('automation_runs').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      .eq('kind', 'focused').like('idea_id', 'search:%').in('status', ['queued', 'running']);
    if (pending.error) throw new Error('Could not check the research queue.');
    if ((pending.count ?? 0) >= 12) return NextResponse.json({ ...status, status: 'busy', canStart: false });
    const profile = await db.from('automation_profiles').upsert({ user_id: user.id, market: pair.market }, { onConflict: 'user_id,market', ignoreDuplicates: true });
    if (profile.error) throw new Error('Could not initialize research.');
    await enqueueSearch(db, user.id, pair, new Date().toISOString());
    return NextResponse.json({ ...status, status: 'queued', canStart: false });
  } catch {
    return NextResponse.json({ error: 'Could not queue strategy research.' }, { status: 503 });
  }
}
