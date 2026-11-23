import { randomUUID } from 'node:crypto';
import { STOCKS, type StockBar, type StockSymbol } from './research';

export type EtoroCredentials = { apiKey: string; userKey: string; environment: 'demo' | 'real' };
type Instrument = { instrumentId: number; symbol: string; displayName: string; type: string };
type Rate = { instrumentId: number; bid: number | null; ask: number | null; date: string | null; quoteType?: 'realtime' | 'delayed' | null };
type Candle = { time: string; open: string; high: string; low: string; close: string };
type BrokerPosition = {
  positionID: number; instrumentID: number; isBuy: boolean; units: number; amount: number;
  leverage: number; openRate: number; openDateTime: string; unrealizedPnL?: { pnL?: number } | null;
};

export class EtoroError extends Error {
  constructor(readonly status: number) { super(`eToro HTTP ${status}`); }
}

const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

export class EtoroClient {
  constructor(private readonly credentials: EtoroCredentials) {}

  private async get<T>(path: string): Promise<T> {
    const result = await fetch(`https://public-api.etoro.com/api${path}`, {
      headers: { 'x-api-key': this.credentials.apiKey, 'x-user-key': this.credentials.userKey, 'x-request-id': randomUUID() },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(6000),
    });
    if (!result.ok) throw new EtoroError(result.status);
    return result.json();
  }

  async portfolio() {
    const { clientPortfolio: portfolio } = await this.get<{ clientPortfolio: { credit: number; positions: BrokerPosition[]; mirrors?: unknown[]; orders?: unknown[]; ordersForOpen?: unknown[] } }>(`/v1/trading/info/${this.credentials.environment}/pnl`);
    if (!portfolio || !Number.isFinite(portfolio.credit) || !Array.isArray(portfolio.positions)) throw new Error('Unexpected eToro portfolio response');
    return {
      credit: portfolio.credit, pending: (portfolio.orders?.length ?? 0) + (portfolio.ordersForOpen?.length ?? 0), mirrors: portfolio.mirrors?.length ?? 0,
      positions: portfolio.positions.map(p => ({ id: p.positionID, instrumentId: p.instrumentID, side: p.isBuy ? 'Long' : 'Short', units: p.units, amount: p.amount, leverage: p.leverage, entry: p.openRate, opened: p.openDateTime, pnl: p.unrealizedPnL?.pnL ?? null })),
    };
  }

  async instrument(symbol: StockSymbol) {
    const { results } = await this.get<{ results: Instrument[] }>(`/v2/market-data/instruments/search?query=${encodeURIComponent(symbol)}`);
    const matches = results.filter(i => i.symbol?.toUpperCase() === symbol && i.type?.toLowerCase() === (symbol === 'SPY' ? 'etf' : 'stocks') && Number.isSafeInteger(i.instrumentId) && i.instrumentId > 0);
    return matches.length === 1 ? matches[0] : null;
  }

  async quotes(ids: number[]) {
    if (!ids.length) return [];
    // Repeating the parameter silently returns a single instrument in production.
    const query = new URLSearchParams({ instrumentIds: ids.join(',') });
    const { results } = await this.get<{ results: Rate[] }>(`/v2/market-data/rates?${query}`);
    return results.map(rate => ({
      ...rate,
      // eToro can omit the UTC suffix in its quote response.
      date: rate.date && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(rate.date) ? `${rate.date}Z` : rate.date,
    }));
  }

  async candles(id: number, days: number, now = Date.now()): Promise<StockBar[]> {
    const from = new Date(now - days * 86_400_000).toISOString();
    const to = new Date(now).toISOString();
    const url = `/v1/data/instruments/${id}/candles?interval=1d&limit=2000&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const [bid, ask] = await Promise.all([this.get<{ results: Candle[] }>(`${url}&side=bid`), this.get<{ results: Candle[] }>(`${url}&side=ask`)]);
    const askByTime = new Map(ask.results.map(bar => [Date.parse(bar.time), Number(bar.open)]));
    const today = nyDate.format(now);
    const bars: StockBar[] = [];
    const dates = new Set<string>();
    for (const raw of [...bid.results].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
      const time = Date.parse(raw.time);
      if (!Number.isFinite(time) || time >= now) continue;
      // API daily buckets can be UTC midnight. Skip the entire latest UTC or New York date.
      const day = new Date(time).toISOString().slice(0, 10);
      if (day >= today) continue;
      const b = { day, bidOpen: Number(raw.open), askOpen: askByTime.get(time) ?? NaN, bidClose: Number(raw.close), high: Number(raw.high), low: Number(raw.low) };
      if (![b.bidOpen, b.askOpen, b.bidClose, b.high, b.low].every(n => Number.isFinite(n) && n > 0) || b.askOpen < b.bidOpen || b.high < Math.max(b.bidOpen, b.bidClose) || b.low > Math.min(b.bidOpen, b.bidClose) || dates.has(day)) {
        throw new Error('Incomplete or invalid paired eToro candles');
      }
      dates.add(day);
      bars.push(b);
    }
    return bars;
  }
}

export function isStockSymbol(symbol: string | null): symbol is StockSymbol {
  return STOCKS.some(known => known === symbol);
}
