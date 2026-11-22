import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { normalizeSymbol } from '@/lib/webhook';

export const dynamic = 'force-dynamic';

// ?symbol=BTC&hours=120  recent hourly candles for the levels chart (public market data).
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const symbol = normalizeSymbol(params.get('symbol') ?? '');
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 });
  const hours = Math.min(720, Math.max(24, Number(params.get('hours')) || 120));
  try {
    const candles = await marketDataClient().getHourlyCandles(symbol, hours);
    return NextResponse.json({ symbol, candles: candles.slice(-hours) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
