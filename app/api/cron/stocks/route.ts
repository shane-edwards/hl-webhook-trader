import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { discoverStocks } from '@/lib/stocks/discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = createServiceClient();
  const cutoff = new Date(Date.now() - 4 * 3_600_000).toISOString();
  const { data, error } = await db.from('etoro_connections').select('user_id, environment, credentials_encrypted, updated_at')
    .or(`scan_attempted_at.is.null,scan_attempted_at.lt.${cutoff}`).order('scan_attempted_at', { nullsFirst: true }).limit(1).maybeSingle();
  if (error) return NextResponse.json({ error: 'Could not read scan queue.' }, { status: 503 });
  if (!data) return NextResponse.json({ scanned: 0 });

  const started = new Date().toISOString();
  const claim = await db.from('etoro_connections').update({ scan_attempted_at: started })
    .eq('user_id', data.user_id).eq('updated_at', data.updated_at).or(`scan_attempted_at.is.null,scan_attempted_at.lt.${cutoff}`)
    .select('user_id').maybeSingle();
  if (claim.error) return NextResponse.json({ error: 'Could not claim scan.' }, { status: 503 });
  if (!claim.data) return NextResponse.json({ scanned: 0 });

  try {
    const result = await discoverStocks(etoroFromConnection(data));
    const saved = await db.from('etoro_connections').update({ discovery: result }).eq('user_id', data.user_id)
      .eq('updated_at', data.updated_at).eq('scan_attempted_at', started).select('user_id').maybeSingle();
    if (saved.error) return NextResponse.json({ error: 'Could not save scan.' }, { status: 503 });
    return NextResponse.json({ scanned: saved.data ? result.rows.length : 0, unavailable: result.unavailable.length });
  } catch {
    return NextResponse.json({ error: 'eToro or stock data unavailable.' }, { status: 503 });
  }
}
