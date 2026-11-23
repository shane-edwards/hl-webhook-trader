import { z } from 'zod';
import { stockLeverageSchema, stopMarginSchema } from './leverage';

export const STOCK_REPLAY_CAPITAL = 10_000;
export const stockReplaySchema = z.object({
  slipBps: z.number().min(0).max(100),
  commission: z.number().min(0).max(30),
  amount: z.number().min(1).max(STOCK_REPLAY_CAPITAL).optional(),
  leverage: stockLeverageSchema.optional(),
  stopMarginPct: stopMarginSchema.optional(),
  cfdFeeBps: z.number().min(0).max(100).optional(),
  annualFinancingPct: z.number().min(0).max(100).optional(),
}).refine(sizing => !sizing.leverage || sizing.leverage === 1 || sizing.stopMarginPct != null);

export type StockReplayCost = z.infer<typeof stockReplaySchema>;

export function stockReplayCosts(cost: StockReplayCost) {
  return { ...cost, slipBps: Math.max(3, cost.slipBps * 2), commission: cost.commission * 2,
    cfdFeeBps: (cost.cfdFeeBps ?? 0) * 2, annualFinancingPct: (cost.annualFinancingPct ?? 0) * 2 };
}

export function replayEntry(cash: number, ask: number, bid: number, cost: StockReplayCost) {
  const leverage = cost.leverage ?? 1;
  const cfdFee = leverage > 1 ? (cost.cfdFeeBps ?? 0) / 10_000 : 0;
  const margin = cost.amount ?? Math.max(0, (cash - cost.commission) / (1 + cfdFee * leverage));
  const exposure = margin * leverage;
  const entryFee = cost.commission + exposure * cfdFee;
  const stop = leverage > 1 ? Math.ceil(ask * (1 - cost.stopMarginPct! / (100 * leverage)) * 100) / 100 : null;
  if (margin <= 0 || cash + 1e-8 < margin + entryFee || (stop != null && (stop <= 0 || stop >= bid))) return null;
  const filledAsk = ask * (1 + cost.slipBps / 10_000);
  return { cash: cash - margin - entryFee, margin, units: exposure / filledAsk, filledAsk, stop,
    cfdFee, nightlyFee: leverage > 1 ? exposure * (cost.annualFinancingPct ?? 0) / 36_500 : 0 };
}

export function replayExit(position: NonNullable<ReturnType<typeof replayEntry>>, bid: number, cost: StockReplayCost) {
  const price = bid * (1 - cost.slipBps / 10_000);
  return position.cash + position.margin + position.units * (price - position.filledAsk - price * position.cfdFee) - cost.commission;
}

export function replayStop(stop: number | null, bidOpen: number, bidLow: number) {
  return stop != null && bidLow <= stop ? Math.min(bidOpen, stop) : null;
}

export function replayNights(day: string) {
  return new Date(`${day}T12:00:00Z`).getUTCDay() === 5 ? 3 : 1;
}
