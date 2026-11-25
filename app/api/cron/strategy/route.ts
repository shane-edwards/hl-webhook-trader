import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { alertOnStalePeers } from '@/lib/health';
import { runStrategyForAccount } from '@/lib/strategy/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Another worker (the five-minute scan fires at the same minute) may hold the
// account's trading lease. Wait for it rather than skip the day's rebalance;
// the rest of the 60 seconds is left for the run itself. If it still fails, the
// scan retries it (see the catch-up in app/api/cron/autopilot/route.ts).
const LOCK_WAIT_MS = 40_000;

// Called once a day shortly after the 00:00 UTC candle close by Supabase's scheduler
// (job hl-strategy, see supabase/migrations/007_execution.sql), with `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const started = Date.now();

  const supabase = createServiceClient();
  // A once-a-day second look at the two scans and the database.
  await alertOnStalePeers(supabase, null).catch(() => {});

  const { data: rows, error } = await supabase.from('settings').select('*').eq('strategy_enabled', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary: Array<{ status: string; message: string }> = [];
  for (const settings of rows ?? []) {
    // The wait is one budget for the whole request, so several accounts cannot add up past maxDuration.
    const result = await runStrategyForAccount(supabase, settings, { lockWaitMs: Math.max(0, LOCK_WAIT_MS - (Date.now() - started)) });
    summary.push({ status: result.status, message: result.message });
  }

  return NextResponse.json({ ran: summary.length, results: summary });
}
