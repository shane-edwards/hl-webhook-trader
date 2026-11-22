import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { configFromSettings, runAutopilot } from '@/lib/autopilot/run';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { notify } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // never run unauthenticated
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Called every few minutes by a scheduler (see supabase/migrations/004_autopilot.sql).
// Signals come from completed hourly candles, so scanning more often than
// every five minutes gains nothing; stops are held on the exchange in between.
export async function GET(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase.from('settings').select('*').eq('autopilot_enabled', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary: Array<{ mode: string; events: number; error?: string }> = [];
  for (const settings of rows ?? []) {
    const cfg = configFromSettings(settings);
    try {
      // Paper mode only reads public prices, so it needs no wallet.
      const hl = cfg.mode === 'paper' ? marketDataClient() : hlClientFromSettings(settings);
      if (!hl) throw new Error('No wallet connected');
      const result = await runAutopilot(hl, supabase, settings.user_id, cfg);
      summary.push({ mode: result.mode, events: result.events.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[autopilot]', message);
      await supabase.from('autopilot_events').insert({ user_id: settings.user_id, mode: cfg.mode, level: 'error', message: `Scan failed: ${message}` });
      await notify(`Autopilot scan FAILED: ${message}`);
      summary.push({ mode: cfg.mode, events: 0, error: message });
    }
  }
  return NextResponse.json({ ran: summary.length, results: summary });
}
