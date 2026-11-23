import { SCALP_INTERVALS, type ScalpBar, type ScalpInterval, type ScalpMarket } from '@/lib/scalp-study';

export async function loadScalpCandles(coin: ScalpMarket, interval: ScalpInterval, now = Date.now()): Promise<ScalpBar[]> {
  const ms = SCALP_INTERVALS[interval];
  const end = Math.floor(now / ms) * ms;
  const result = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: end - 4999 * ms, endTime: end - 1 } }),
  });
  if (!result.ok) throw new Error(`Hyperliquid returned HTTP ${result.status}`);
  const candles = await result.json() as Array<{ t: number; T: number; o: string; h: string; l: string; c: string; v: string }>;
  return candles.filter(c => c.T < end).map(c => ({ t: c.t, o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) })).sort((a, b) => a.t - b.t);
}
