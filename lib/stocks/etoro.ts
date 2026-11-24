import { randomUUID } from 'node:crypto';
import { STOCKS, type StockBar, type StockSymbol } from './research';
import { type StockOrderOption } from './leverage';

export type EtoroCredentials = { apiKey: string; userKey: string; environment: 'demo' | 'real' };
type Instrument = { instrumentId: number; symbol: string; displayName: string; type: string };
type Rate = { instrumentId: number; bid: number | null; ask: number | null; date: string | null; quoteType?: 'realtime' | 'delayed' | null };
type Candle = { time: string; open: string; high: string; low: string; close: string; volume?: string };
type AskRange = { askHigh?: number; askLow?: number; askClose?: number };
export type IntradayBar = { t: number; bidOpen: number; bidHigh: number; bidLow: number; bidClose: number; askOpen: number; volume: number } & AskRange;
function askRange(candle: Candle | undefined): AskRange {
  if (!candle) return {};
  const [open, high, low, close] = [candle.open, candle.high, candle.low, candle.close].map(Number);
  return [open, high, low, close].every(value => Number.isFinite(value) && value > 0) && high >= Math.max(open, close) && low <= Math.min(open, close)
    ? { askHigh: high, askLow: low, askClose: close } : {};
}
type BrokerPosition = {
  positionID: number; instrumentID: number; isBuy: boolean; units: number; amount: number;
  leverage: number; openRate: number; openDateTime: string; unrealizedPnL?: { pnL?: number } | null;
};
export type StockOrder = { action: 'open'; transaction: 'buy'; instrumentId: number; orderType: 'mkt'; amount: number; orderCurrency: 'usd' } & (
  { settlementType: 'real'; leverage: 1 } | { settlementType: 'cfd'; leverage: 2 | 5; stopLossRate: number; stopLossType: 'fixed' }
);
type Eligibility = {
  instrumentId: number; allowOpenPosition: boolean; allowClosePosition: boolean; minPositionExposure: number | null; allowedOrderQuantityType: string | null;
  leverageConfigs: { settlementType: string; direction: string; leverageValues: number[]; minPositionAmount: number | null; isPotential: boolean;
    allowStopLossTakeProfit: boolean; minStopLossPercentage: number | null; maxStopLossPercentage: number | null }[];
};
type OrderCost = { costType: string; value: number; currency: string };
type OpeningData = { avgPrice?: number | null; units?: number | null; executionTime?: string | null; openTime?: string | null;
  fees?: number | null; taxes?: number | null };
export type EtoroOrderStatus = { orderId: number; requestTime?: string | null; status: { id: number; errorMessage?: string };
  positionExecutions: { positionId: number; state?: string; stopLossRate?: number | null; openingData?: OpeningData | null }[] };
export type EtoroCloseStatus = { orderID: number; statusID: number; proceeds: number; instrumentID: number;
  positions?: { positionID: number; rate?: number | null; occurred?: string | null; units?: number | null }[] };
type PendingStockOrder = { orderId?: number; amount?: number; frozenAmount?: number };

export class EtoroError extends Error {
  constructor(readonly status: number) { super(`eToro HTTP ${status}`); }
}

const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const instruments = new Map<string, { value: Instrument; expires: number }>();

export class EtoroClient {
  constructor(private readonly credentials: EtoroCredentials) {}

  private async request<T>(path: string, body?: object, requestId = randomUUID(), timeoutMs = 6000): Promise<T> {
    const result = await fetch(`https://public-api.etoro.com/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-api-key': this.credentials.apiKey, 'x-user-key': this.credentials.userKey, 'x-request-id': requestId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!result.ok) throw new EtoroError(result.status);
    return result.json();
  }

  private get<T>(path: string) { return this.request<T>(path); }

  private get demoPath() { return this.credentials.environment === 'demo' ? 'demo/' : ''; }

  async stockOrderOptions(instrumentId: number): Promise<StockOrderOption[]> {
    return (await this.stockOrderOptionsFor([instrumentId])).get(instrumentId) ?? [];
  }

  async stockOrderOptionsFor(instrumentIds: number[]) {
    const result = await this.request<{ eligibilities: Eligibility[] }>(`/v2/trading/info/${this.demoPath}eligibility`, { instrumentIds, currency: 'USD' });
    return new Map(result.eligibilities.map(instrument => [instrument.instrumentId, this.orderOptions(instrument)]));
  }

  private orderOptions(instrument: Eligibility): StockOrderOption[] {
    const quantityType = instrument?.allowedOrderQuantityType?.toLowerCase();
    if (!instrument?.allowOpenPosition || ['unitsonly', 'onlyunits', 'units'].includes(quantityType ?? '')) return [];
    const options: StockOrderOption[] = [];
    for (const leverage of [1, 2, 5] as const) {
      const configuration = instrument.leverageConfigs.find(config => config.settlementType.toLowerCase() === (leverage === 1 ? 'real' : 'cfd')
        && config.direction.toLowerCase() === 'long' && config.leverageValues.includes(leverage) && !config.isPotential);
      if (!configuration) continue;
      const minimum = Math.max(configuration.minPositionAmount ?? 0, (instrument.minPositionExposure ?? 0) / leverage);
      if (!Number.isFinite(minimum)) continue;
      if (leverage === 1) { options.push({ leverage, minimum, stopMargin: null }); continue; }
      if (!instrument.allowClosePosition || !configuration.allowStopLossTakeProfit || configuration.minStopLossPercentage == null || configuration.maxStopLossPercentage == null) continue;
      const min = configuration.minStopLossPercentage;
      const max = Math.min(50, configuration.maxStopLossPercentage);
      if (Number.isFinite(min) && Number.isFinite(max) && max > 0 && max >= min && min >= 0) options.push({ leverage, minimum, stopMargin: { min, max } });
    }
    return options;
  }

  async stockOrderCosts(order: StockOrder) {
    const result = await this.request<{ instrumentId: number; costs: OrderCost[] }>(`/v2/trading/info/${this.demoPath}costs`, order);
    if (result.instrumentId !== order.instrumentId || !Array.isArray(result.costs)) throw new Error('Unexpected eToro order estimate');
    return result.costs.filter(cost => Number.isFinite(cost.value));
  }

  openStock(order: StockOrder, requestId: ReturnType<typeof randomUUID>) {
    return this.request<{ orderId: number; referenceId: string }>(`/v2/trading/execution/${this.demoPath}orders`, order, requestId);
  }

  stockOrderStatus(referenceId: string) {
    return this.get<EtoroOrderStatus>(`/v2/trading/info/${this.demoPath}orders:lookup?${new URLSearchParams({ referenceId })}`);
  }

  closeStock(positionId: number, instrumentId: number, requestId: ReturnType<typeof randomUUID>) {
    return this.request<{ orderForClose?: { orderID: number } }>(`/v1/trading/execution/${this.demoPath}market-close-orders/positions/${positionId}`, { InstrumentId: instrumentId }, requestId);
  }

  stockCloseStatus(orderId: number) {
    return this.get<EtoroCloseStatus>(`/v1/trading/info/${this.credentials.environment}/close-orders/${orderId}`);
  }
  async portfolio() {
    const { clientPortfolio: portfolio } = await this.get<{ clientPortfolio: { credit: number; positions: BrokerPosition[]; mirrors?: unknown[]; orders?: PendingStockOrder[]; ordersForOpen?: PendingStockOrder[] } }>(`/v1/trading/info/${this.credentials.environment}/pnl`);
    if (!portfolio || !Number.isFinite(portfolio.credit) || !Array.isArray(portfolio.positions)) throw new Error('Unexpected eToro portfolio response');
    const reserved = new Map<number | PendingStockOrder, number>();
    for (const order of [...(portfolio.orders ?? []), ...(portfolio.ordersForOpen ?? [])]) {
      const key = order.orderId ?? order;
      const margin = Math.max(reserved.get(key) ?? 0, order.amount ?? 0, order.frozenAmount ?? 0);
      if (!Number.isFinite(margin)) throw new Error('Unexpected eToro pending margin');
      reserved.set(key, margin);
    }
    const availableCash = Math.max(0, portfolio.credit - [...reserved.values()].reduce((sum, value) => sum + value, 0));
    return {
      availableCash,
      credit: portfolio.credit, pending: (portfolio.orders?.length ?? 0) + (portfolio.ordersForOpen?.length ?? 0), mirrors: portfolio.mirrors?.length ?? 0,
      positions: portfolio.positions.map(p => ({ id: p.positionID, instrumentId: p.instrumentID, side: p.isBuy ? 'Long' : 'Short', units: p.units, amount: p.amount, leverage: p.leverage, entry: p.openRate, opened: p.openDateTime, pnl: p.unrealizedPnL?.pnL ?? null })),
    };
  }

  async instrument(symbol: string, timeoutMs = 6000) {
    const cached = instruments.get(symbol);
    if (cached && cached.expires > Date.now()) return cached.value;
    const { results } = await this.request<{ results: Instrument[] }>(`/v2/market-data/instruments/search?query=${encodeURIComponent(symbol)}`, undefined, undefined, timeoutMs);
    const eligible = results.filter(i => i.type?.toLowerCase() === (symbol === 'SPY' ? 'etf' : 'stocks') && Number.isSafeInteger(i.instrumentId) && i.instrumentId > 0);
    // Some US tickers carry a country suffix when other exchanges share the base ticker.
    const suffixed = eligible.filter(i => i.symbol?.toUpperCase() === `${symbol}.US`);
    const matches = suffixed.length ? suffixed : eligible.filter(i => i.symbol?.toUpperCase() === symbol);
    if (matches.length !== 1) return null;
    instruments.set(symbol, { value: matches[0], expires: Date.now() + 86_400_000 });
    return matches[0];
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

  async candles(id: number, days: number, now = Date.now(), tradingDates = false, signalOnly = false, timeoutMs = 6000,
    includeAskRange = false): Promise<StockBar[]> {
    const from = new Date(now - days * 86_400_000).toISOString();
    const to = new Date(now).toISOString();
    const url = `/v1/data/instruments/${id}/candles?interval=1d&limit=2000&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const read = (side: 'bid' | 'ask') => this.request<{ results: Candle[] }>(`${url}&side=${side}`, undefined, undefined, timeoutMs);
    const [bid, ask] = await Promise.all([read('bid'), signalOnly ? null : read('ask')]);
    const askByTime = new Map((ask ?? bid).results.map(bar => [Date.parse(bar.time), bar]));
    const today = nyDate.format(now);
    const bars: StockBar[] = [];
    const dates = new Set<string>();
    for (const raw of [...bid.results].sort((a, b) => Date.parse(b.time) - Date.parse(a.time))) {
      const time = Date.parse(raw.time);
      if (!Number.isFinite(time) || time >= now) continue;
      // API daily buckets can be UTC midnight. Skip the entire latest UTC or New York date.
      // Broker buckets that begin after the core session contain the next day's session.
      const candleDate = new Date(time);
      const day = new Date(time + (tradingDates && candleDate.getUTCHours() >= 20 ? 86_400_000 : 0)).toISOString().slice(0, 10);
      if (day >= today) continue;
      // Some older series contain both the previous evening's bucket and a midnight
      // bucket for the same session. Prefer the explicit midnight session stamp.
      if (tradingDates && day < '2025-01-01' && candleDate.getUTCHours() >= 20 && dates.has(day)) continue;
      const opposite = askByTime.get(time);
      const b = { day, bidOpen: Number(raw.open), askOpen: Number(opposite?.open), bidClose: Number(raw.close), high: Number(raw.high), low: Number(raw.low),
        ...(ask && includeAskRange ? askRange(opposite) : {}) };
      if (![b.bidOpen, b.askOpen, b.bidClose, b.high, b.low].every(n => Number.isFinite(n) && n > 0) || b.askOpen < b.bidOpen || b.high < Math.max(b.bidOpen, b.bidClose) || b.low > Math.min(b.bidOpen, b.bidClose) || dates.has(day)) {
        throw new Error('Incomplete or invalid paired eToro candles');
      }
      dates.add(day);
      bars.push(b);
    }
    return bars.reverse();
  }

  /** One fixed history window, including every page from each quote side. */
  async intradayCandles(id: number, from: number, to: number, pace?: () => Promise<void>, interval: '5m' | '30m' = '5m',
    signalOnly = false, timeoutMs = 6000, includeAskRange = false): Promise<IntradayBar[]> {
    const maxDays = interval === '30m' ? 175 : 28;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > maxDays * 86_400_000) throw new Error('Invalid intraday candle range');
    const sides = async (side: 'bid' | 'ask') => {
      const query = new URLSearchParams({ interval, limit: '2000', from: new Date(from).toISOString(), to: new Date(to).toISOString(), side });
      const all: Candle[] = [];
      for (let page = 0; page < 8; page++) {
        await pace?.();
        const { results, pagination } = await this.request<{ results: Candle[]; pagination: { hasNext: boolean; nextCursor?: string | null } }>(`/v1/data/instruments/${id}/candles?${query}`, undefined, undefined, timeoutMs);
        all.push(...results);
        if (!pagination.hasNext) return all;
        if (!pagination.nextCursor || query.get('cursor') === pagination.nextCursor) throw new Error('Invalid intraday history cursor');
        query.set('cursor', pagination.nextCursor);
      }
      throw new Error('Intraday history did not finish paging');
    };
    const [bid, ask] = await Promise.all([sides('bid'), signalOnly ? null : sides('ask')]);
    const asks = new Map((ask ?? bid).map(b => [Date.parse(b.time), b]));
    const seen = new Set<number>();
    return bid.flatMap(b => {
      const t = Date.parse(b.time);
      if (!Number.isFinite(t) || t < from || t >= to) return [];
      if (seen.has(t)) throw new Error('Duplicate intraday candle');
      seen.add(t);
      const opposite = asks.get(t);
      const bar = { t, bidOpen: Number(b.open), bidHigh: Number(b.high), bidLow: Number(b.low), bidClose: Number(b.close),
        askOpen: Number(opposite?.open), volume: Number(b.volume ?? NaN), ...(ask && includeAskRange ? askRange(opposite) : {}) };
      const prices = [bar.bidOpen, bar.bidHigh, bar.bidLow, bar.bidClose, bar.askOpen];
      // An incomplete quote pair becomes a gap. Session validation decides whether it is usable.
      return prices.every(p => Number.isFinite(p) && p > 0) && bar.askOpen >= bar.bidOpen &&
        bar.bidHigh >= Math.max(bar.bidOpen, bar.bidClose) && bar.bidLow <= Math.min(bar.bidOpen, bar.bidClose) ? [bar] : [];
    }).sort((a, b) => a.t - b.t);
  }
}

export function isStockSymbol(symbol: string | null): symbol is StockSymbol {
  return STOCKS.some(known => known === symbol);
}
