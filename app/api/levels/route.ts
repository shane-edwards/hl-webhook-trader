import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { normalizeSymbol } from '@/lib/webhook';
import { BARS_FOR_LEVELS, buildTimeframeLevels, isTimeframe, TIMEFRAMES } from '@/lib/timeframes';

export const dynamic = 'force-dynamic';

const CHART_BARS = 120;

// ?symbol=BTC&tf=4h  candles for the chart, and the stop, target and levels sized for that timeframe.
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const symbol = normalizeSymbol(params.get('symbol') ?? '');
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 });
  const tf = params.get('tf') ?? '1h';
  if (!isTimeframe(tf)) return NextResponse.json({ error: `Timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}` }, { status: 400 });

  try {
    const hl = marketDataClient();
    const now = Date.now();
    const [bars, mids] = await Promise.all([
      hl.getCandles(symbol, TIMEFRAMES[tf].interval, now - (BARS_FOR_LEVELS + 2) * TIMEFRAMES[tf].ms, now),
      hl.getAllMids(),
    ]);
    const price = parseFloat(mids[symbol] ?? '');
    if (!(price > 0)) return NextResponse.json({ error: 'Not listed on Hyperliquid' }, { status: 404 });
    if (bars.length < 30) return NextResponse.json({ error: 'Not enough price history on this timeframe' }, { status: 404 });
    return NextResponse.json({ symbol, price, levels: buildTimeframeLevels(tf, bars, price), candles: bars.slice(-CHART_BARS) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
