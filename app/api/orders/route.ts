import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { cancelLimitEntry } from '@/lib/pending';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  return { service, user, settings };
}

// Resting limit entries placed from the trade ticket, plus the managed exit
// plans (split targets, break-even, trailing) on open positions.
export async function GET() {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { service, user } = ctx;
  const [orders, plans, chase] = await Promise.all([
    service.from('pending_orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30),
    service.from('position_plans').select('*').eq('user_id', user.id).eq('status', 'active'),
    // Chase entries need the columns from migration 007.
    service.from('pending_orders').select('mode').limit(1),
  ]);
  // Before migration 006 the tables do not exist: report that rather than an error.
  return NextResponse.json({ available: !orders.error, chase: !chase.error, orders: orders.data ?? [], plans: plans.data ?? [] });
}

// ?id=<pending order id>  cancel a resting limit entry
export async function DELETE(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { service, user, settings } = ctx;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Missing order id' }, { status: 400 });
  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ error: 'Connect your wallet in Settings first' }, { status: 400 });
    const events = await cancelLimitEntry(hl, service, user.id, id);
    return NextResponse.json({ success: true, events });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
