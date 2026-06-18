import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { createHLClient } from '@/lib/hyperliquid/client';
import { decrypt } from '@/lib/encryption';

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

  if (!settings?.hl_private_key_encrypted && !process.env.HL_PRIVATE_KEY) {
    return NextResponse.json({ positions: [], account: null });
  }

  try {
    const privateKey = process.env.HL_PRIVATE_KEY ?? decrypt(settings!.hl_private_key_encrypted!);
    const isTestnet = process.env.HL_TESTNET === 'true' || settings?.is_testnet;
    const hl = createHLClient({ privateKey, isTestnet });

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
