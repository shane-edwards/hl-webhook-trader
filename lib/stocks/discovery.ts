import type { EtoroClient } from './etoro';
import { STOCKS, type StockSymbol } from './research';
import { gradeStock } from './grade';
import { getFundamentals } from './fundamentals';

type DiscoveryRow = NonNullable<ReturnType<typeof gradeStock>> & {
  symbol: StockSymbol; instrumentId: number; name: string;
  quote: Awaited<ReturnType<EtoroClient['quotes']>>[number] | null;
};

export async function discoverStocks(broker: EtoroClient) {
  const now = Date.now();
  const instruments = await Promise.all(STOCKS.map(symbol => broker.instrument(symbol)));
  const quotes = await broker.quotes(instruments.flatMap(i => i ? [i.instrumentId] : []));
  const spy = instruments.at(-1);
  const benchmark = spy ? await broker.candles(spy.instrumentId, 460, now).catch(() => []) : [];
  const rows: DiscoveryRow[] = [];
  const unavailable: string[] = [];
  const symbols = STOCKS.slice(0, -1);
  for (let start = 0; start < symbols.length; start += 4) {
    const batch = await Promise.allSettled(symbols.slice(start, start + 4).map(async (symbol, index) => {
      const instrument = instruments[start + index];
      if (!instrument) throw new Error('No unique eToro match');
      const quote = quotes.find(q => q.instrumentId === instrument.instrumentId);
      const bars = await broker.candles(instrument.instrumentId, 460, now);
      const latest = bars.at(-1);
      if (!latest) throw new Error('No candles');
      const time = Date.parse(quote?.date ?? '');
      const spread = quote?.bid && quote.ask && quote.ask >= quote.bid && quote.bid > 0 && time <= now + 60_000 && now - time < 20 * 60_000
        ? (quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2) : null;
      const grade = gradeStock(bars, benchmark, await getFundamentals(symbol, latest.bidClose, latest.day), spread, now);
      if (!grade) throw new Error('Insufficient market data');
      return { symbol, instrumentId: instrument.instrumentId, name: instrument.displayName, quote: quote ?? null, ...grade };
    }));
    batch.forEach((row, index) => row.status === 'fulfilled' ? rows.push(row.value) : unavailable.push(symbols[start + index]));
  }
  if (!rows.length) throw new Error('eToro did not return enough paired candles for the stock screen');
  return { rows: rows.sort((a, b) => Number(b.label === 'Strong buy') - Number(a.label === 'Strong buy') || b.score - a.score), unavailable, scannedAt: new Date(now).toISOString() };
}
