import { NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/server';
import { scanStockAutopilot, type StockAutoConfig } from '@/lib/stocks/autopilot';
import { stockMarketClock } from '@/lib/stocks/session';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const clock = stockMarketClock(Date.now());
  if (!clock.open) return NextResponse.json({ scanned: 0, market: 'closed' });

  const db = createServiceClient();
  const [config, positions] = await Promise.all([
    db.from('stock_autopilot').select('*').order('last_run_at', { nullsFirst: true }),
    db.from('etoro_stock_orders').select('user_id').not('signal_day', 'is', null).is('closed_at', null).neq('state', 'rejected'),
  ]);
  if (config.error || positions.error) return NextResponse.json({ error: 'Could not read stock Autopilot queue' }, { status: 503 });
  const manage = new Set(positions.data?.map(row => row.user_id));
  const users: StockAutoConfig[] = (config.data ?? []).filter(row => row.active_environment || manage.has(row.user_id)).slice(0, 2);
  const results = await Promise.allSettled(users.map(async user => {
    let message: string;
    try { message = await scanStockAutopilot(db, user); }
    catch { message = 'Scan could not finish. Check Recent orders and your eToro account.'; }
    const saved = await db.from('stock_autopilot').update({ last_run_at: new Date().toISOString(), last_message: message }).eq('user_id', user.user_id).eq('updated_at', user.updated_at);
    if (saved.error) throw saved.error;
    if (/unconfirmed|declined the exit|could not finish/.test(message)) await notify(`Stock Autopilot: ${message}`, undefined, user.user_id);
  }));
  const failed = results.filter(result => result.status === 'rejected').length;
  return NextResponse.json({ scanned: results.length, failed }, { status: failed ? 503 : 200 });
}
