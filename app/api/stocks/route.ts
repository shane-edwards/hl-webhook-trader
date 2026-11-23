import { NextResponse } from 'next/server';
import { encrypt } from '@/lib/encryption';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { EtoroClient, EtoroError, isStockSymbol } from '@/lib/stocks/etoro';
import { STOCK_RULES, researchStock } from '@/lib/stocks/research';
import { Credentials, etoroFromConnection } from '@/lib/stocks/connection';
import { discoverStocks } from '@/lib/stocks/discovery';

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
    }, { onConflict: 'user_id' });
    if (error) return fail('Could not save the eToro connection.', 503);
    return NextResponse.json({ environment });
  } catch (error) { return failure(error); }
}

export async function DELETE() {
  const user = await signedInUser();
  if (!user) return fail('Unauthorized', 401);
  const { error } = await createServiceClient().from('etoro_connections').delete().eq('user_id', user.id);
  return error ? fail('Could not remove the eToro connection.', 503) : NextResponse.json({ environment: null });
}

export async function GET(request: Request) {
  const user = await signedInUser();
  if (!user) return fail('Unauthorized', 401);
  const db = createServiceClient();
  const { data, error } = await db.from('etoro_connections').select('environment, credentials_encrypted, discovery, scan_attempted_at, updated_at').eq('user_id', user.id).maybeSingle();
  if (error) return fail('eToro connection storage is unavailable.', 503);
  const query = new URL(request.url).searchParams;
  const view = query.get('view');
  if (!view) return NextResponse.json({ environment: data?.environment ?? null, discovery: data?.discovery ?? null });
  if (!data) return fail('Connect eToro first.', 409);

  try {
    const broker = etoroFromConnection(data);
    if (view === 'portfolio') return NextResponse.json(await broker.portfolio());
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
    const claim = db.from('etoro_connections').update({ scan_attempted_at: started }).eq('user_id', user.id).eq('updated_at', data.updated_at);
    const { data: claimed, error: claimError } = await (data.scan_attempted_at ? claim.eq('scan_attempted_at', data.scan_attempted_at) : claim.is('scan_attempted_at', null)).select('user_id').maybeSingle();
    if (claimError) return fail('Could not start the stock scan.', 503);
    if (!claimed) return fail('A scan has just started. Try again in a minute.', 429);
    const result = await discoverStocks(broker);
    const { error: saveError } = await db.from('etoro_connections').update({ discovery: result }).eq('user_id', user.id).eq('updated_at', data.updated_at).eq('scan_attempted_at', started);
    if (saveError) return fail('Could not save the stock scan.', 503);
    return NextResponse.json(result);
  } catch (error) { return failure(error); }
}
