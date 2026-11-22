import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { estimateFill, liquidityVerdict } from '@/lib/liquidity';
import { normalizeSymbol } from '@/lib/webhook';

export const dynamic = 'force-dynamic';

// ?symbol=BTC&side=long&sizeUsd=500  what a market order of that size would cost right now.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const symbol = normalizeSymbol(params.get('symbol') ?? '');
  const sizeUsd = Number(params.get('sizeUsd'));
  if (!/^[A-Z0-9]{1,20}$/.test(symbol) || !(sizeUsd > 0)) return NextResponse.json({ error: 'Give a symbol and a size' }, { status: 400 });
  try {
    const [book, { data: settings }] = await Promise.all([
      marketDataClient().getBook(symbol),
      createServiceClient().from('settings').select('slippage_percent').eq('user_id', user.id).single(),
    ]);
    const estimate = estimateFill(book, params.get('side') === 'short' ? 'sell' : 'buy', sizeUsd);
    return NextResponse.json({ symbol, estimate, verdict: liquidityVerdict(estimate, Number(settings?.slippage_percent ?? 2)) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
