import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { haltAndFlatten } from '@/lib/risk/flatten';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = createServiceClient();
  const { data: settings } = await db.from('settings').select('*').eq('user_id', user.id).single();
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 });
  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) throw new Error('Hyperliquid credentials not configured');
    const results = await haltAndFlatten(hl, db, user.id, Number(settings.slippage_percent));
    await notify('Kill switch completed. Trading halted, entry orders cancelled, and account verified flat.', undefined, user.id);
    return NextResponse.json({ automationPaused: true, tradingHalted: true, results });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Kill switch failed';
    await notify(`KILL SWITCH FAILED: ${error}`, undefined, user.id);
    return NextResponse.json({ error }, { status: 500 });
  }
}
