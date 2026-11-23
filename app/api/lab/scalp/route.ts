import { unstable_cache } from 'next/cache';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { loadScalpCandles } from '@/lib/hyperliquid/scalp-candles';
import { replayScalp, scalpCoverage, SCALP_INTERVALS, SCALP_MARKETS, SCALP_RULES, summarizeScalps, type ScalpInterval, type ScalpMarket } from '@/lib/scalp-study';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const recentReplay = unstable_cache(async (coin: ScalpMarket, interval: ScalpInterval) => {
  const now = Date.now();
  const ms = SCALP_INTERVALS[interval];
  const bars = await loadScalpCandles(coin, interval, now);
  if (bars.length < 1000) throw new Error('Insufficient candles');
  const from = bars[0].t + 4 * 3_600_000;
  const to = Math.floor(now / ms) * ms;
  const coverage = scalpCoverage(bars, interval, from, to);
  if (coverage < 0.995 || bars.at(-1)!.t + 2 * ms < to) throw new Error('Incomplete or stale Hyperliquid candle history');
  return {
    coin, interval, from: new Date(from).toISOString(), to: new Date(to).toISOString(), coverage,
    results: SCALP_RULES.map(rule => ({ id: rule.id, ...summarizeScalps([replayScalp(bars, interval, rule.id, from, to)]) })),
  };
}, ['scalp-replay-v1'], { revalidate: 300 });

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const coin = SCALP_MARKETS.find(symbol => symbol === params.get('coin'));
  const interval = params.get('interval');
  if (!coin || (interval !== '5m' && interval !== '15m')) {
    return NextResponse.json({ error: 'Choose BTC, ETH or SOL and a 5m or 15m interval.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await recentReplay(coin, interval));
  } catch (error) {
    console.error('[scalp-replay]', error);
    return NextResponse.json({ error: 'Complete Hyperliquid candle history is temporarily unavailable.' }, { status: 503 });
  }
}
