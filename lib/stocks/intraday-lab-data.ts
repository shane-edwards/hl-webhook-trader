import type { EtoroClient } from './etoro';
import { regularStockSessions } from './intraday';
import { replayLabMarket, stockLabWindows, type LabSymbol } from './intraday-lab';

const DAY = 86_400_000;
export async function loadLabMarket(broker: EtoroClient, symbol: LabSymbol, asOf: string, costs: { slipBps: number; fee: number }) {
  const asset = await broker.instrument(symbol, 12_000);
  if (!asset) return null;
  const { from } = stockLabWindows(asOf);
  const first = Date.parse(from), end = Date.parse(asOf);
  const prices = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    broker.intradayCandles(asset.instrumentId, first + i * 28 * DAY, Math.min(end, first + (i + 1) * 28 * DAY), undefined, '5m', false, 12_000)));
  return replayLabMarket(symbol, regularStockSessions(prices.flat()).sessions, asOf, costs);
}
