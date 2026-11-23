import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/server';
import { catalystWindow } from '@/lib/stocks/catalyst-data';
import { captureOpeningShadow, settleOpeningShadow } from '@/lib/stocks/shadow-book';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
type Account = { user_id: string; environment: 'demo' | 'real' };

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = createServiceClient();
  const now = Date.now();
  const due = catalystWindow(now);
  const [scheduled, pending] = await Promise.all([
    due ? db.from('stock_catalyst_settings').select('user_id, environment').eq('enabled', true).order('last_checked_at', { nullsFirst: true }).limit(8)
      : { data: [], error: null },
    db.from('stock_shadow_observations').select('user_id, environment').is('outcomes', null).lte('settle_after', new Date(now).toISOString())
      .order('settle_after').limit(120),
  ]);
  if (scheduled.error || pending.error) return NextResponse.json({ error: 'Could not read shadow capture queue' }, { status: 503 });
  const captures = (scheduled.data ?? []) as Account[];
  const accounts = new Map<string, Account>();
  for (const account of [...captures, ...(pending.data ?? []) as Account[]]) accounts.set(`${account.user_id}:${account.environment}`, account);
  const jobs = await Promise.allSettled([...accounts.values()].slice(0, due ? 2 : 4).map(async account => {
    if (captures.some(row => row.user_id === account.user_id && row.environment === account.environment)) {
      try { await captureOpeningShadow(db, account.user_id, account.environment, now); }
      finally { await db.from('stock_catalyst_settings').update({ last_checked_at: new Date().toISOString() }).eq('user_id', account.user_id); }
    }
    await settleOpeningShadow(db, account.user_id, account.environment, now);
  }));
  return NextResponse.json({ checked: jobs.length, errors: jobs.filter(job => job.status === 'rejected').length });
}
