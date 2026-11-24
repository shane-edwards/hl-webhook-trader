import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { EMPTY_HEDGE, HEDGE_MARKETS, HEDGE_REVISION, HOUR, projectHedge, type HedgeObservation, type HedgeMarket } from './model';

type Db = ReturnType<typeof createServiceClient>;
const markets = Object.keys(HEDGE_MARKETS) as HedgeMarket[];

export async function watchFundingHedges(db: Db, time: number, now = Date.now) {
  const bucket = Math.floor(time / HOUR) * HOUR;
  const reference = new Date(bucket).toISOString();
  const client = marketDataClient();
  const results = await Promise.allSettled(markets.map(async symbol => {
    const recent = await db.from('funding_hedge_observations').select('hour,reading').eq('revision', HEDGE_REVISION).eq('symbol', symbol)
      .order('hour', { ascending: false }).limit(1).maybeSingle();
    if (recent.error) throw new Error('Could not read the funding hedge model.');
    if (recent.data && Date.parse(recent.data.hour) >= bucket) return null;
    const prior = recent.data?.reading as HedgeObservation | undefined;
    const previousPayment = prior?.state.position?.lastPaid;
    const [funding, closes] = await Promise.all([
      client.getFundingRates(symbol, bucket - 336 * HOUR, time),
      previousPayment == null ? [] : client.getCandles(symbol, '1h', Math.max(bucket - 336 * HOUR, previousPayment), bucket),
    ]);
    const marks = new Map(closes.filter(bar => Number.isFinite(bar.c) && bar.c > 0).map(bar => [bar.t + HOUR, bar.c]));
    const [spot, perp] = await Promise.all([client.getBookSnapshot(HEDGE_MARKETS[symbol]), client.getBookSnapshot(symbol)]);
    const observed = now();
    if (Math.floor(observed / HOUR) * HOUR !== bucket) return null;
    const reading = projectHedge(prior?.state ?? EMPTY_HEDGE, spot, perp, funding.map(row => ({
      ...row, referencePrice: marks.get(Math.round(row.time / HOUR) * HOUR),
    })), observed);
    // Leave a second chance to catch the daily check if the first pair of books was stale.
    if (reading.status === 'unavailable' && observed - bucket < 9 * 60_000) return null;
    const result = await db.from('funding_hedge_observations').insert({ revision: HEDGE_REVISION, symbol, hour: reference,
      observed_at: new Date(observed).toISOString(), reading });
    if (result.error?.code === '23505') return null;
    if (result.error) throw new Error('Could not record the hedge observation.');
    return reading.status;
  }));
  const failures = results.filter(row => row.status === 'rejected').length;
  return { captured: results.filter(row => row.status === 'fulfilled' && row.value != null).length, failures };
}
