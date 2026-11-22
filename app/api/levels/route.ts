import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { normalizeSymbol } from '@/lib/webhook';
import { BARS_FOR_LEVELS, buildTicketFrame, isTimeframe, TIMEFRAMES, type Timeframe } from '@/lib/timeframes';
import type { Bar } from '@/lib/autopilot/strategies';

export const dynamic = 'force-dynamic';

/** Candles sent for the chart: enough for its widest zoom. */
const CHART_BARS = 480;

// ?symbol=BTC&tf=4h  candles for the chart, the stop, target and levels sized for that timeframe,
// the nearest levels from the next slower chart, and the trend on all four timeframes.
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
    const tfs = Object.keys(TIMEFRAMES) as Timeframe[];
    const [mids, ...loaded] = await Promise.all([
      hl.getAllMids(),
      // One slow or missing timeframe (a newly listed coin has little daily history) must not sink the rest.
      ...tfs.map(k => hl.getCandles(symbol, TIMEFRAMES[k].interval, now - (BARS_FOR_LEVELS + 2) * TIMEFRAMES[k].ms, now).catch(() => [] as Bar[])),
    ]);
    const series = Object.fromEntries(tfs.map((k, i) => [k, loaded[i]])) as Record<Timeframe, Bar[]>;
    const bars = series[tf];
    const price = parseFloat(mids[symbol] ?? '');
    if (!(price > 0)) return NextResponse.json({ error: 'Not listed on Hyperliquid' }, { status: 404 });
    if (bars.length < 30) return NextResponse.json({ error: 'Not enough price history on this timeframe' }, { status: 404 });
    const frame = buildTicketFrame(series, tf, price);
    return NextResponse.json({ symbol, price, ...frame, candles: bars.slice(-CHART_BARS) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
