import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getMarkets } from '@/lib/hyperliquid/public';

export const dynamic = 'force-dynamic';

// Live overview of every Hyperliquid perp: price, funding, open interest, volume.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const markets = await getMarkets();
    return NextResponse.json({ markets, asOf: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
