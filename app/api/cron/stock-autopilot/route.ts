import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/server';
import { scanStockAutopilot, type StockAutoConfig } from '@/lib/stocks/autopilot';
import { stockMarketClock } from '@/lib/stocks/session';
import { notify } from '@/lib/notify';
import { controlledStockConfig } from '@/lib/automation/trading';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const clock = stockMarketClock(Date.now());
  if (!clock.open) return NextResponse.json({ scanned: 0, market: 'closed' });

  const db = createServiceClient();
  const claim = await db.rpc('claim_stock_scan_accounts');
  if (claim.error) return NextResponse.json({ error: 'Could not claim stock accounts' }, { status: 503 });
  const users = (claim.data ?? []) as string[];
  if (!users.length) return NextResponse.json({ scanned: 0, failed: 0 });
  const config = await db.from('stock_autopilot').select('*').in('user_id', users);
  if (config.error) return NextResponse.json({ error: 'Could not read stock settings' }, { status: 503 });
  const settings = new Map<string, StockAutoConfig>(config.data.map(row => [row.user_id, row]));
  const results = await Promise.allSettled(users.map(async userId => {
    const initial = settings.get(userId);
    let user = initial;
    let message: string;
    try {
      const controlled = await controlledStockConfig(db, userId, initial).catch(() => null);
      user = controlled ? controlled.config : initial ? { ...initial, active_environment: null } : undefined;
      message = await scanStockAutopilot(db, userId, user, Date.now(), controlled?.policy);
      if (!controlled) message = `Could not verify automation settings · ${message}`;
    } catch { message = 'Scan could not finish. Check Recent orders and your eToro account.'; }
    if (user) {
      const saved = await db.from('stock_autopilot').update({ last_run_at: new Date().toISOString(), last_message: message }).eq('user_id', userId).eq('updated_at', user.updated_at);
      if (saved.error) throw saved.error;
      if (user.active_environment && (message !== 'Waiting for the next scheduled strategy entry window' || /submitted/.test(message))) {
        await db.from('stock_scan_journal').insert({ user_id: userId, environment: user.active_environment,
          state: /buy submitted/.test(message) ? 'submitted' : /could not finish/i.test(message) ? 'error' : 'skipped', detail: message });
      }
    }
    // The last four are returned by one scan only, when the order or exit changes state, so each alerts once.
    if (/unconfirmed|declined the exit|could not finish|protective exit is required|not received|needs a manual check|closed outside|did not confirm the exit/.test(message)) await notify(`Stock Autopilot: ${message}`, undefined, userId);
  }));
  const failed = results.filter(result => result.status === 'rejected').length;
  return NextResponse.json({ scanned: results.length, failed }, { status: failed ? 503 : 200 });
}
