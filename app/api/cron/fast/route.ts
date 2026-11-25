import { processWebhookQueue } from '@/lib/webhook-queue';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { runFastPass } from '@/lib/upkeep';
import { cronAuthorized } from '@/lib/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The fast scan. Called every 10 seconds by Supabase's scheduler, but only
// while there is an open trade, a managed exit plan or a resting entry (the
// schedule itself checks; see supabase/migrations/007_execution.sql), so an
// idle account costs nothing.
//
// It does the time-critical part of the five-minute scan: moving trailing and
// break-even stops, following limit and chase entries, and noticing a position
// that has just been closed on the exchange. Everything slower (Autopilot,
// fee sync, daily summary) stays on the five-minute scan.
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createServiceClient();
  // Queued signals come first, but a failure there must never stop the upkeep
  // below: that is what moves stops and finishes a pending flatten.
  let webhookJobs = 0, webhookError: string | null = null;
  try { webhookJobs = await processWebhookQueue(); }
  catch (error) {
    webhookError = error instanceof Error ? error.message : 'Webhook queue failed';
    console.error('[fast] webhook queue:', webhookError);
  }

  const [plans, pending, open, recovery, unprotected] = await Promise.all([
    supabase.from('position_plans').select('user_id').eq('status', 'active'),
    supabase.from('pending_orders').select('user_id').eq('status', 'resting'),
    supabase.from('trades').select('user_id').eq('status', 'open'),
    supabase.from('settings').select('user_id').eq('flatten_pending', true),
    supabase.from('autopilot_positions').select('user_id').eq('mode', 'live').eq('status', 'open').eq('recovery_pending', true),
  ]);
  if ([plans, pending, open, recovery, unprotected].some(result => result.error))
    return NextResponse.json({ error: 'Could not identify accounts needing upkeep' }, { status: 503 });
  const users = [...new Set([...(plans.data ?? []), ...(pending.data ?? []), ...(open.data ?? []), ...(recovery.data ?? []), ...(unprotected.data ?? [])].map(r => r.user_id as string))];
  if (!users.length) return NextResponse.json({ ran: 0, webhookJobs, ...(webhookError ? { webhookError } : {}) }, { status: webhookError ? 500 : 200 });

  const { data: rows, error } = await supabase.from('settings').select('*').in('user_id', users);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let notes = 0, errors = 0;
  for (const settings of rows ?? []) {
    try {
      const hl = hlClientFromSettings(settings);
      if (!hl) { errors++; continue; }
      const r = await runFastPass(hl, supabase, settings);
      notes += r.notes.length; errors += r.errors.length;
      if (r.errors.length) console.error('[fast]', r.errors.join(' | '));
    } catch (error) {
      errors++;
      console.error('[fast]', error instanceof Error ? error.message : 'Account upkeep failed');
    }
  }
  return NextResponse.json({ ran: rows?.length ?? 0, notes, errors, webhookJobs, ...(webhookError ? { webhookError } : {}) }, { status: webhookError ? 500 : 200 });
}
