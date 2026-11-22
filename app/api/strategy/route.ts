import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { runStrategyOnce, strategyConfigFromSettings } from '@/lib/strategy/run';

export const dynamic = 'force-dynamic';

// Recent runs of the built-in strategy for the signed-in user.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('strategy_runs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ runs: data });
}

// Preview: computes what the strategy would do right now. Never sends an order.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const serviceClient = createServiceClient();
  const { data: settings } = await serviceClient.from('settings').select('*').eq('user_id', user.id).single();
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 });

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ error: 'Hyperliquid credentials not configured' }, { status: 400 });
    const result = await runStrategyOnce(hl, strategyConfigFromSettings(settings, true));
    return NextResponse.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
