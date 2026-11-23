import { z } from 'zod';
import type { StockOrder } from './etoro';

export const stockLeverageSchema = z.union([z.literal(1), z.literal(2), z.literal(5)]);
export type StockLeverage = z.infer<typeof stockLeverageSchema>;
export const stopMarginSchema = z.number().positive().max(50);
export type StockOrderOption = { leverage: StockLeverage; minimum: number; stopMargin: { min: number; max: number } | null };
export type StockSizing = { amount: number; leverage: StockLeverage; stopMarginPct?: number | null };
export const stockSizingSchema = z.object({
  amount: z.number().min(1).max(10_000),
  leverage: stockLeverageSchema,
  stopMarginPct: stopMarginSchema.optional(),
}).refine(sizing => sizing.leverage === 1 || sizing.stopMarginPct != null);

export function stockSizingParams(sizing: StockSizing) {
  return { amount: String(sizing.amount), leverage: String(sizing.leverage),
    ...(sizing.leverage > 1 && sizing.stopMarginPct != null ? { stopMarginPct: String(sizing.stopMarginPct) } : {}) };
}

export function stockSizingQuery(query: { get(name: string): string | null }) {
  return stockSizingSchema.safeParse({
    amount: Number(query.get('amount')), leverage: Number(query.get('leverage') ?? 1),
    stopMarginPct: query.get('stopMarginPct') ? Number(query.get('stopMarginPct')) : undefined,
  });
}

export class StockSizingError extends Error {}

export function stockOrderOption(options: StockOrderOption[], sizing: StockSizing) {
  const option = options.find(option => option.leverage === sizing.leverage);
  if (!option) throw new StockSizingError(`eToro does not allow ${sizing.leverage}× for this stock and account.`);
  if (!Number.isFinite(sizing.amount) || sizing.amount <= 0 || sizing.amount < option.minimum) throw new StockSizingError(`eToro’s minimum for ${sizing.leverage}× is $${option.minimum.toFixed(2)}.`);
  if (sizing.leverage !== 1) {
    const stop = sizing.stopMarginPct;
    const range = option.stopMargin;
    if (!range || stop == null || !stopMarginSchema.safeParse(stop).success || stop < range.min || stop > range.max) {
      throw new StockSizingError(`Enter a stop loss above 0% and within eToro’s ${range?.min ?? 0}–${range?.max ?? 0}% of margin range.`);
    }
  }
  return option;
}

export function prepareStockOrder(instrumentId: number, quote: { ask: number; bid: number }, options: StockOrderOption[], sizing: StockSizing): StockOrder {
  const option = stockOrderOption(options, sizing);
  const common = { action: 'open', transaction: 'buy', instrumentId, orderType: 'mkt', amount: sizing.amount, orderCurrency: 'usd' } as const;
  if (sizing.leverage === 1) return { ...common, settlementType: 'real', leverage: 1 };

  // eToro accepts an absolute rate. Its percentage limits are measured against margin.
  const stopLossRate = Math.ceil(quote.ask * (1 - sizing.stopMarginPct! / (100 * sizing.leverage)) * 100) / 100;
  const marginLossPct = (1 - stopLossRate / quote.ask) * sizing.leverage * 100;
  if (!Number.isFinite(stopLossRate) || stopLossRate <= 0 || stopLossRate >= quote.bid || marginLossPct + 1e-8 < option.stopMargin!.min) {
    throw new StockSizingError('The stop loss is too close to the current bid. Review the quote or choose a wider stop.');
  }
  return { ...common, settlementType: 'cfd', leverage: sizing.leverage, stopLossRate, stopLossType: 'fixed' };
}

export function approvedStockStop(order: StockOrder, quote: { ask: number; bid: number }, stopMarginPct: number | null) {
  if (order.settlementType === 'real') return true;
  if (stopMarginPct == null || order.stopLossRate >= quote.bid) return false;
  return (1 - order.stopLossRate / quote.ask) * order.leverage * 100 <= stopMarginPct + 1e-8;
}

export function stockOrderFees(costs: { currency: string; value: number; costType: string }[]) {
  return costs.filter(cost => cost.currency.toUpperCase() === 'USD' && ['transactionFee', 'sdrt'].includes(cost.costType))
    .reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
}
