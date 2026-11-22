import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { getAccountTruth } from '@/lib/hyperliquid/public';

export const dynamic = 'force-dynamic';

// The account's history as the exchange recorded it: equity, P&L, fees, funding.
// This is the source of truth; the trades table is only this app's own log.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const serviceClient = createServiceClient();
  const { data: settings } = await serviceClient.from('settings').select('*').eq('user_id', user.id).single();

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ account: null });
    const isTestnet = process.env.HL_TESTNET === 'true' || settings?.is_testnet === true;
    const account = await getAccountTruth(hl.address, isTestnet);
    return NextResponse.json({ account, isTestnet });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
