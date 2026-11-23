import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { sizeStockRisk } from '@/lib/stocks/dollar-risk';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { stockFillCalibration, type StockJournalOrder } from '@/lib/stocks/execution-journal';
import { prepareStockOrder, stockLeverageSchema, stockOrderFees, stockOrderOption, StockSizingError } from '@/lib/stocks/leverage';
import { stockGroupExposure, stockPortfolioRisk, stockPortfolioSchema } from '@/lib/stocks/portfolio';
import { freshStockAsk } from '@/lib/stocks/session';
import { isStockTradeSymbol, STOCK_INSTRUMENTS } from '@/lib/stocks/trade-rules';

export const dynamic = 'force-dynamic';
const input = z.object({
  symbol: z.string(), environment: z.enum(['demo', 'real']), leverage: stockLeverageSchema, stopMarginPct: z.number().positive().max(50),
  budget: z.number().min(1).max(10_000), gapPct: z.number().min(0).max(25), maximum: z.number().min(1).max(100_000),
});
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return fail('Unauthorized', 401);
  const value = input.safeParse(await request.json().catch(() => null));
  if (!value.success || !isStockTradeSymbol(value.data.symbol)) return fail('Choose a stock and enter a valid loss budget and stop.', 400);
  const { environment, symbol, leverage, stopMarginPct, budget, gapPct, maximum } = value.data;
  const db = createServiceClient();
  const [connection, autopilot, fills] = await Promise.all([
    db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', user.id).eq('environment', environment).maybeSingle(),
    db.from('stock_autopilot').select('portfolio, active_environment').eq('user_id', user.id).maybeSingle(),
    db.from('etoro_stock_orders').select('symbol, request, state, submission_quote, fill_metrics, broker_state').eq('user_id', user.id)
      .eq('environment', environment).eq('symbol', symbol).eq('state', 'filled').not('fill_metrics', 'is', null).limit(50),
  ]);
  if (connection.error || autopilot.error || fills.error) return fail('Could not read the account’s risk settings.', 503);
  if (!connection.data) return fail('Connect this eToro account first.', 409);
  try {
    const id = STOCK_INSTRUMENTS[symbol];
    const broker = etoroFromConnection(connection.data);
    const [options, [quote], portfolio] = await Promise.all([broker.stockOrderOptions(id), broker.quotes([id]), broker.portfolio()]);
    const ask = freshStockAsk(quote, Date.now());
    if (!ask || !quote?.bid) return fail('A fresh eToro quote is required during the regular US session.', 409);
    const risk = stockPortfolioRisk(portfolio);
    if (!risk) return fail('Pending orders, copy portfolios or missing position data prevent an exposure check.', 409);
    if (risk.positions.has(id)) return fail('The account already holds this ticker. Review the existing exposure before adding to it.', 422);
    const choice = options.find(option => option.leverage === leverage);
    if (!choice) return fail('eToro does not allow this leverage for the selected account and stock.', 422);
    const cap = stockPortfolioSchema.safeParse(autopilot.data?.portfolio).data;
    const applicable = !!cap && (!autopilot.data?.active_environment || autopilot.data.active_environment === environment);
    const group = stockGroupExposure(risk.group, id);
    if (applicable && risk.positions.size >= cap.maxPositions) return fail('The account is at the saved position limit.', 422);
    const exposureRoom = applicable ? Math.min(cap.maxExposure - risk.gross, cap.maxGroup - group) : Infinity;
    const maxAmount = Math.min(maximum, portfolio.availableCash, exposureRoom / leverage);
    const minimum = Math.max(0.01, Math.ceil(choice.minimum * 100) / 100);
    if (maxAmount < minimum) return fail('Available cash or the saved exposure limits are below eToro’s minimum order.', 422);
    const fixed = { leverage, stopMarginPct };
    stockOrderOption(options, { amount: minimum, ...fixed });
    const stop = Math.ceil(ask * (1 - stopMarginPct / (100 * leverage)) * 100) / 100;
    const fill = stockFillCalibration((fills.data ?? []) as StockJournalOrder[], symbol, leverage > 1 ? 'cfd' : 'real');
    const slippageBps = Math.max(3, fill.slipBps ?? 0);
    const assumptions = { ask, bid: quote.bid, stop, leverage, budget, gapPct, slippageBps, minimumAmount: minimum, maxAmount };
    const ceiling = sizeStockRisk({ ...assumptions, roundTripFeesUsd: 0 });
    if (!ceiling) return fail('Even eToro’s minimum order would exceed the modeled risk budget, or the stop is inside the spread.', 422);
    const order = prepareStockOrder(id, { ask, bid: quote.bid }, options, { amount: ceiling.amount, ...fixed });
    const costs = await broker.stockOrderCosts(order);
    const markup = costs.filter(cost => cost.costType === 'markup' && cost.currency.toUpperCase() === 'USD')
      .reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
    const roundTripFeesUsd = 2 * (stockOrderFees(costs) + markup);
    const plan = sizeStockRisk({ ...assumptions, maxAmount: Math.min(maxAmount, portfolio.availableCash - roundTripFeesUsd), roundTripFeesUsd });
    if (!plan) return fail('The loss budget, buying power or concentration limit is below eToro’s minimum after fees.', 422);
    if (!freshStockAsk(quote, Date.now())) return fail('The quote expired. Recalculate with a fresh price.', 409);
    return NextResponse.json({ ...plan, symbol, leverage, stopMarginPct, gapPct, quoteAt: quote.date, slippageBps,
      journalSamples: fill.samples, applicable, currentGroupExposure: group, roundTripFeesUsd });
  } catch (error) {
    return error instanceof StockSizingError ? fail(error.message, 422) : fail('Could not calculate risk from the current eToro quote and estimate.', 503);
  }
}
