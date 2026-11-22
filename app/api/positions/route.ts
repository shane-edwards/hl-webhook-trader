import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const serviceClient = createServiceClient();
  const { data: settings } = await serviceClient
    .from('settings')
    .select('*')
    .eq('user_id', user.id)
    .single();

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ positions: [], account: null });

    const [positions, account] = await Promise.all([
      hl.getPositions(),
      hl.getAccountSummary(),
    ]);

    return NextResponse.json({ positions, account });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
