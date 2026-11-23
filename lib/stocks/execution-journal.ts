import type { EtoroClient, EtoroOrderStatus } from './etoro';
import type { StockTradeRule, StockTradeSymbol } from './trade-rules';

export type StockJournalQuote = { bid: number; ask: number; at: string | null; observedAt: string };
export type StockJournalCost = { costType: string; value: number; currency: string };
export type StockJournalFill = { price: number; units: number; executionAt: string | null; feesUsd: number | null; taxesUsd: number | null };
export type StockJournalClose = { orderId: number; quote: StockJournalQuote | null; rate?: number; closedAt?: string | null; units?: number; proceeds?: number; complete?: boolean };
export type StockJournalOrder = { id: string; created_at: string; symbol: StockTradeSymbol; strategy: StockTradeRule | null; state: string;
  reference_price: number; decision_quote: StockJournalQuote | null; submission_quote: StockJournalQuote | null;
  estimated_costs: StockJournalCost[] | null; fill_metrics: StockJournalFill | null; broker_message: string | null;
  close_execution: Record<string, StockJournalClose>; closed_at: string | null; signal_day: string | null; signal_expires_at: string | null;
  statement_financing_usd: number | null; broker_order_id: number | null; broker_state: number | null; request: { settlementType: string; instrumentId: number; leverage: number; amount: number } };

export function journalQuote(bid: number, ask: number, at: string | null): StockJournalQuote {
  return { bid, ask, at, observedAt: new Date().toISOString() };
}

export function stockJournalFill(order: EtoroOrderStatus): StockJournalFill | null {
  const fills = (order.positionExecutions ?? []).filter(position => position.positionId > 0).map(position => position.openingData);
  if (!fills.length || !fills.every(fill => fill && typeof fill.units === 'number' && fill.units > 0 && Number.isFinite(fill.units)
      && typeof fill.avgPrice === 'number' && fill.avgPrice > 0 && Number.isFinite(fill.avgPrice))) return null;
  const units = fills.reduce((sum, fill) => sum + fill!.units!, 0);
  const quoteValue = fills.reduce((sum, fill) => sum + fill!.units! * fill!.avgPrice!, 0);
  const times = fills.map(fill => Date.parse(fill?.executionTime ?? ''));
  const sumFee = (key: 'fees' | 'taxes') => fills.every(fill => typeof fill?.[key] === 'number' && Number.isFinite(fill[key]))
    ? fills.reduce((sum, fill) => sum + fill![key]!, 0) : null;
  return { price: quoteValue / units, units, executionAt: times.every(Number.isFinite) ? new Date(Math.max(...times)).toISOString() : null,
    feesUsd: sumFee('fees'), taxesUsd: sumFee('taxes') };
}

export async function readStockCloseExecution(broker: EtoroClient, instrumentId: number, positionId: string, close: StockJournalClose) {
  if (close.complete) return close;
  const status = await broker.stockCloseStatus(close.orderId);
  if (status.instrumentID !== instrumentId) return close;
  const position = status.positions?.find(item => item.positionID === Number(positionId));
  if (!position?.rate || !position.units || !Number.isFinite(position.rate) || !Number.isFinite(position.units)) return close;
  return { ...close, rate: position.rate, units: position.units, closedAt: position.occurred ?? null, proceeds: status.proceeds,
    complete: [3, 4, 7, 8, 9, 10].includes(status.statusID) };
}

export function stockFillMetrics(row: Pick<StockJournalOrder, 'submission_quote' | 'fill_metrics'>) {
  const { submission_quote: quote, fill_metrics: fill } = row;
  if (!quote || !fill) return null;
  const ms = fill.executionAt ? Date.parse(fill.executionAt) - Date.parse(quote.observedAt) : null;
  return { slipBps: (fill.price / quote.ask - 1) * 10_000, latencyMs: ms != null && Number.isFinite(ms) && ms >= 0 ? ms : null };
}

export function stockFillCalibration(orders: StockJournalOrder[], symbol: StockTradeSymbol, settlement: string) {
  const values = orders.filter(row => row.symbol === symbol && row.request.settlementType === settlement && row.state === 'filled' && row.broker_state !== 5)
    .flatMap(row => {
      const metrics = stockFillMetrics(row);
      return metrics ? [metrics.slipBps] : [];
    }).sort((a, b) => a - b);
  return { samples: values.length, slipBps: values.length >= 10 ? Math.max(0, values[Math.ceil(values.length * 0.75) - 1]) : null };
}

export function stockCalibrations(orders: StockJournalOrder[], symbols: readonly StockTradeSymbol[], leverage: number) {
  return Object.fromEntries(symbols.map(symbol => [symbol, stockFillCalibration(orders, symbol, leverage > 1 ? 'cfd' : 'real')]));
}
