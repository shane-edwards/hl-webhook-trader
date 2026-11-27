import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runMarketScan } from '@/lib/market-scan';
import { alertOnStalePeers, heartbeat } from '@/lib/health';
import { cronAuthorized } from '@/lib/cron-auth';
import { notify } from '@/lib/notify';
import { scanFundingGaps } from '@/lib/funding-scan/scan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The market scan: refreshes trade ideas for every liquid market a batch at a
// time, alerts when one turns long or short, and scores earlier ideas against
// what the price did. Scheduled separately from the trading scan so a slow
// candle download can never delay stop management (see migration 006).
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createServiceClient();
  try {
    // Record-only funding research. Its failure must never hold up or fail the market scan.
    const [result] = await Promise.all([runMarketScan(supabase),
      scanFundingGaps(supabase, Date.now()).catch(error => console.error('[market] funding scan', error instanceof Error ? error.message : error))]);
    if (result.flips.length) {
      await notify('Trade ideas changed (rule-based reads, not forecasts):\n' + result.flips.map(f =>
        `${f.symbol}: now ${f.strength} ${f.to} (was ${f.from === 'neutral' ? 'no trade' : f.from}) at ${f.price}; suggested stop ${f.stopPct}%, target ${f.targetPct}%`).join('\n'));
    }
    await heartbeat(supabase, 'market', true, result.errors.length ? `${result.errors.length} markets failed: ${result.errors.slice(0, 3).join('; ')}` : null);
    await alertOnStalePeers(supabase, 'market');
    return NextResponse.json({ liquid: result.liquid, refreshed: result.refreshed.length, flips: result.flips.length, scored: result.resolved, errors: result.errors.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market]', message);
    await heartbeat(supabase, 'market', false, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
