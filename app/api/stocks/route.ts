import { NextResponse } from 'next/server';
import { encrypt } from '@/lib/encryption';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { EtoroClient, EtoroError, isStockSymbol } from '@/lib/stocks/etoro';
import { STOCK_RULES, researchStock } from '@/lib/stocks/research';
import { Credentials, etoroFromConnection } from '@/lib/stocks/connection';
import { discoverStocks } from '@/lib/stocks/discovery';
import { regularStockSessions, replayStockIntraday, STOCK_INTRADAY_RULES, summarizeIntraday } from '@/lib/stocks/intraday';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

async function signedInUser() {
  const db = await createClient();
  return (await db.auth.getUser()).data.user;
}

function failure(error: unknown) {
  if (error instanceof EtoroError && [401, 403].includes(error.status)) return fail('eToro rejected the keys. Check their expiry, Read permission, and Demo or Real environment.', 422);
  if (error instanceof EtoroError && error.status === 429) return fail('eToro asked us to slow down. Try again in a minute.', 429);
  return fail('Stock data is temporarily unavailable. Try again shortly.', 503);
}

export async function POST(request: Request) {
  const user = await signedInUser();
  if (!user) return fail('Unauthorized', 401);
  const parsed = Credentials.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Enter both eToro keys and select their environment.', 400);
  try {
    await new EtoroClient(parsed.data).portfolio();
    const { apiKey, userKey, environment } = parsed.data;
    const { error } = await createServiceClient().from('etoro_connections').upsert({
      user_id: user.id, environment, credentials_encrypted: encrypt(JSON.stringify({ apiKey, userKey })), updated_at: new Date().toISOString(),
      discovery: null, scan_attempted_at: null,
    }, { onConflict: 'user_id,environment' });
    if (error) return fail('Could not save the eToro connection.', 503);
    return NextResponse.json({ environment });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  const user = await signedInUser();
  if (!user) return fail('Unauthorized', 401);
  const environment = new URL(request.url).searchParams.get('environment');
  if (environment !== 'demo' && environment !== 'real') return fail('Select the connection to remove.', 400);
  const db = createServiceClient();
  const [autopilot, orders] = await Promise.all([
    db.from('stock_autopilot').select('user_id').eq('user_id', user.id).eq('active_environment', environment).maybeSingle(),
    db.from('etoro_stock_orders').select('id').eq('user_id', user.id).eq('environment', environment)
      .or('signal_day.not.is.null,strategy_exit_at.not.is.null,protection_state.in.(unverified,exit_required)').is('closed_at', null).not('state', 'in', '(draft,rejected)').limit(1),
  ]);
  if (autopilot.error || orders.error) return fail('Could not check for managed positions.', 503);
  if (autopilot.data || orders.data?.length) return fail('Pause this Autopilot and finish its managed positions before disconnecting.', 409);
  const { error } = await db.from('etoro_connections').delete().eq('user_id', user.id).eq('environment', environment);
  return error ? fail('Could not remove the eToro connection.', 503) : NextResponse.json({ environment: null });
}

export async function GET(request: Request) {
  const user = await signedInUser();
  if (!user) return fail('Unauthorized', 401);
  const db = createServiceClient();
  const query = new URL(request.url).searchParams;
  const view = query.get('view');
  const { data: connections, error } = await db.from('etoro_connections').select('environment, credentials_encrypted, discovery, scan_attempted_at, updated_at').eq('user_id', user.id).order('environment', { ascending: false });
  if (error) return fail('eToro connection storage is unavailable.', 503);
  const data = query.get('environment') ? connections.find(row => row.environment === query.get('environment')) : connections[0];
  if (!view) return NextResponse.json({ environment: data?.environment ?? null, connections: connections.map(row => row.environment), discovery: data?.discovery ?? null });
  if (!data) return fail('Connect eToro first.', 409);

  try {
    const broker = etoroFromConnection(data);
    if (view === 'portfolio') return NextResponse.json(await broker.portfolio());
    if (view === 'intraday') {
      const symbol = query.get('symbol');
      if (!isStockSymbol(symbol)) return fail('Choose a supported US stock.', 400);
      const instrument = await broker.instrument(symbol);
      if (!instrument) return fail('eToro did not return a unique match for this ticker.', 404);
      const to = Math.floor(Date.now() / 300_000) * 300_000;
      const middle = to - 28 * 86_400_000;
      const from = middle - 28 * 86_400_000;
      // Reserve the first 28 days for the relative-volume warm-up. If holidays
      // leave less than 20 sessions, the rule self-suppresses until it is ready.
      const history = await broker.intradayCandles(instrument.instrumentId, from, middle);
      const recent = await broker.intradayCandles(instrument.instrumentId, middle, to);
      const coverage = regularStockSessions([...history, ...recent]);
      const start = new Date(middle).toISOString().slice(0, 10);
      const end = new Date(to + 86_400_000).toISOString().slice(0, 10);
      const sessions = coverage.sessions.filter(s => s.day >= start);
      if (sessions.length < 10) return fail('Fewer than ten complete paired five-minute sessions are available.', 422);
      const results = STOCK_INTRADAY_RULES.filter(rule => !('spyOnly' in rule) || symbol === 'SPY').map(rule => ({
        id: rule.id, ...summarizeIntraday([replayStockIntraday(coverage.sessions, rule.id, start, end)]),
      }));
      return NextResponse.json({ symbol, from: sessions[0].day, to: sessions.at(-1)!.day, sessions: sessions.length, results });
    }
    if (view === 'research') {
      const symbol = query.get('symbol'), rule = STOCK_RULES.find(r => r.id === query.get('rule'));
      const slipBps = Number(query.get('slipBps') ?? 3), commission = Number(query.get('commission') ?? 1);
      if (!isStockSymbol(symbol) || !rule || !Number.isFinite(slipBps) || slipBps < 0 || slipBps > 100 || !Number.isFinite(commission) || commission < 0 || commission > 30) {
        return fail('Select a stock, strategy, and valid cost assumptions.', 400);
      }
      const instrument = await broker.instrument(symbol);
      if (!instrument) return fail('eToro did not return a unique match for this ticker.', 404);
      const bars = await broker.candles(instrument.instrumentId, 1800);
      const result = researchStock(bars, rule.id, { slipBps, commission });
      return result ? NextResponse.json({ symbol, rule: rule.id, result }) : fail('There are fewer than 260 paired daily candles for this ticker.', 422);
    }
    if (view !== 'discover') return fail('Unknown stocks view.', 400);

    if (data.discovery?.scannedAt && Date.now() - Date.parse(data.discovery.scannedAt) < 120_000) return NextResponse.json(data.discovery);
    if (data.scan_attempted_at && Date.now() - Date.parse(data.scan_attempted_at) < 60_000) return fail('A scan has just started. Try again in a minute.', 429);
    const started = new Date().toISOString();
    const claim = db.from('etoro_connections').update({ scan_attempted_at: started }).eq('user_id', user.id).eq('environment', data.environment).eq('updated_at', data.updated_at);
    const { data: claimed, error: claimError } = await (data.scan_attempted_at ? claim.eq('scan_attempted_at', data.scan_attempted_at) : claim.is('scan_attempted_at', null)).select('user_id').maybeSingle();
    if (claimError) return fail('Could not start the stock scan.', 503);
    if (!claimed) return fail('A scan has just started. Try again in a minute.', 429);
    const result = await discoverStocks(broker);
    const { error: saveError } = await db.from('etoro_connections').update({ discovery: result }).eq('user_id', user.id).eq('environment', data.environment).eq('updated_at', data.updated_at).eq('scan_attempted_at', started);
    if (saveError) return fail('Could not save the stock scan.', 503);
    return NextResponse.json(result);
  } catch (error) { return failure(error); }
}
