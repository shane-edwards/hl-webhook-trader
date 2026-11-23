import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { EtoroError } from '@/lib/stocks/etoro';
import { freshStockAsk, stockMarketClock } from '@/lib/stocks/session';
import { reconcileStockOrder, submitStockOrder } from '@/lib/stocks/autopilot';
import { journalQuote } from '@/lib/stocks/execution-journal';
import { currentStockEntry, stockEntryWindow } from '@/lib/stocks/trade-signals';
import { isStockTradeRule, isStockTradeSymbol, supportsStockTradeRule } from '@/lib/stocks/trade-rules';
import { approvedStockStop, prepareStockOrder, stockLeverageSchema, stockOrderFees, StockSizingError, stopMarginSchema } from '@/lib/stocks/leverage';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const REVIEW_MS = 2 * 60_000;
const visible = 'id, environment, symbol, strategy, state, broker_order_id, position_ids, created_at, strategy_exit_at, closed_at, protection_state, leverage:request->leverage';
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
const environment = z.enum(['demo', 'real']);
const sizing = z.object({ symbol: z.string(), amount: z.number().positive().max(100_000), environment, leverage: stockLeverageSchema.default(1), stopMarginPct: stopMarginSchema.optional() });
const input = z.discriminatedUnion('action', [
  sizing.extend({ action: z.literal('review'), strategy: z.string().optional() }),
  sizing.extend({ action: z.literal('estimate') }),
  z.object({ action: z.literal('submit'), id: z.uuid(), environment }),
  z.object({ action: z.literal('status'), id: z.uuid(), environment }),
]);

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  return { user, db: createServiceClient() };
}

export async function GET(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const query = new URL(request.url).searchParams;
  const env = environment.safeParse(query.get('environment'));
  if (!env.success) return fail('Select Demo or Real.', 400);
  if (query.has('symbol')) {
    const symbol = query.get('symbol');
    if (!isStockTradeSymbol(symbol)) return fail('Choose a supported stock.', 400);
    const connection = await ctx.db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', ctx.user.id).eq('environment', env.data).maybeSingle();
    if (connection.error || !connection.data) return fail('Connect this eToro account first.', 409);
    try {
      const broker = etoroFromConnection(connection.data);
      const instrument = await broker.instrument(symbol);
      if (!instrument) return fail('This stock is unavailable on eToro.', 422);
      return NextResponse.json({ options: await broker.stockOrderOptions(instrument.instrumentId) });
    } catch {
      return fail('Could not check eToro leverage for this stock.', 503);
    }
  }
  const { data, error } = await ctx.db.from('etoro_stock_orders').select(visible).eq('user_id', ctx.user.id).eq('environment', env.data).neq('state', 'draft').order('created_at', { ascending: false }).limit(15);
  return error ? fail('Could not load orders.', 503) : NextResponse.json({ marketOpen: stockMarketClock(Date.now()).open, orders: data ?? [] });
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Check the trade details.', 400);
  const body = parsed.data;
  const { db, user } = ctx;
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted, updated_at').eq('user_id', user.id).eq('environment', body.environment).maybeSingle();
  if (connection.error) return fail('eToro connection is unavailable.', 503);
  if (!connection.data) return fail(`Connect eToro ${body.environment === 'demo' ? 'Demo' : 'Real'} first.`, 409);
  const broker = etoroFromConnection(connection.data);
  const orders = () => db.from('etoro_stock_orders');

  try {
    if (body.action === 'estimate') {
      if (!isStockTradeSymbol(body.symbol)) return fail('Choose a supported stock.', 400);
      const instrument = await broker.instrument(body.symbol);
      if (!instrument) return fail('This stock is unavailable on eToro.', 422);
      const [options, quotes] = await Promise.all([broker.stockOrderOptions(instrument.instrumentId), broker.quotes([instrument.instrumentId])]);
      const quote = quotes.find(rate => rate.instrumentId === instrument.instrumentId);
      if (!quote?.ask || !quote.bid) return fail('eToro has no indicative quote for this stock.', 422);
      const order = prepareStockOrder(instrument.instrumentId, { ask: quote.ask, bid: quote.bid }, options, { ...body, amount: Math.round(body.amount * 100) / 100 });
      return NextResponse.json({ costs: await broker.stockOrderCosts(order), quotedAt: quote.date });
    }
    if (body.action === 'review') {
      const rule = isStockTradeRule(body.strategy) ? body.strategy : null;
      if (!isStockTradeSymbol(body.symbol) || (body.strategy && !rule) || (rule && !supportsStockTradeRule(rule, body.symbol))) return fail('Choose a stock and a strategy that supports it.', 400);
      if (Math.round(body.amount * 100) <= 0) return fail('Enter an amount in dollars and cents.', 400);
      const now = Date.now();
      if (!stockMarketClock(now).open) return fail('Orders are available during the regular US market session.', 409);
      if (rule && !stockEntryWindow(rule, now, false)) return fail(
        rule === 'earnings-rebound' ? 'This strategy checks entries from 10:00 to 10:05 a.m. ET on full trading days.' : 'This strategy checks entries from 9:30 to 10:00 a.m. ET.', 409);
      const instrument = await broker.instrument(body.symbol);
      if (!instrument) return fail('This stock is unavailable on eToro.', 422);
      const instrumentId = instrument.instrumentId;
      const [options, quotes, book, signal] = await Promise.all([
        broker.stockOrderOptions(instrumentId), broker.quotes([instrumentId]), broker.portfolio(),
        rule ? currentStockEntry(broker, body.symbol, instrumentId, rule, now) : null,
      ]);
      const quote = quotes.find(quote => quote.instrumentId === instrumentId);
      const ask = freshStockAsk(quote, Date.now());
      if (!ask || !quote?.bid) return fail('Waiting for a fresh real-time eToro quote.', 409);
      if (rule && !signal) return fail('This strategy has no current entry signal for this stock.', 409);
      if (signal && (!quote?.bid || (ask - quote.bid) / ask > signal.maxSpread)) return fail('The spread is too wide for this strategy entry.', 409);
      const amount = Math.round(body.amount * 100) / 100;
      const order = prepareStockOrder(instrumentId, { ask, bid: quote.bid }, options, { ...body, amount });
      const costs = await broker.stockOrderCosts(order);
      if (book.availableCash < amount + stockOrderFees(costs)) return fail('Your eToro buying power is below the order amount and estimated fees.', 422);
      if (rule && signal && (Date.now() >= signal.validUntil || !stockEntryWindow(rule, Date.now(), false))) return fail('The strategy entry window expired.', 409);
      const saved = await orders().insert({
        user_id: user.id, environment: body.environment, connection_version: connection.data.updated_at,
        symbol: body.symbol, strategy: rule, request: order, reference_price: ask,
        decision_quote: journalQuote(quote.bid, ask, quote.date), estimated_costs: costs,
        stop_margin_pct: order.settlementType === 'cfd' ? body.stopMarginPct : null,
        protection_state: order.settlementType === 'cfd' ? 'unverified' : null,
        signal_expires_at: signal ? new Date(signal.validUntil).toISOString() : null,
        strategy_exit_at: signal?.exitAt ? new Date(signal.exitAt).toISOString() : null,
      }).select(visible).single();
      if (saved.error) return fail('Could not save the order review.', 503);
      return NextResponse.json({
        review: saved.data, name: instrument.displayName, ask, amount, leverage: order.leverage, exposure: amount * order.leverage,
        stopPrice: order.settlementType === 'cfd' ? order.stopLossRate : null,
        estimatedStopLoss: order.settlementType === 'cfd' ? amount * order.leverage * (1 - order.stopLossRate / ask) : null,
        costs, signal: signal?.description,
      });
    }

    const find = () => orders().select('*').eq('user_id', user.id).eq('environment', body.environment).eq('id', body.id).maybeSingle();
    const order = await find();
    if (order.error) return fail('Could not load the order.', 503);
    if (!order.data) return fail('Order not found.', 404);
    const row = order.data;
    const update = (value: object) => orders().update({ ...value, updated_at: new Date().toISOString() }).eq('user_id', user.id).eq('id', body.id);

    if (body.action === 'status') {
      if (['draft', 'filled', 'rejected'].includes(row.state)) return fail('This order needs no status refresh.', 409);
      const { message, ...summary } = await reconcileStockOrder(broker, row.id, row.request);
      const saved = await update(summary).eq('state', row.state).select(visible).maybeSingle();
      if (saved.error) return fail('Could not save the broker status.', 503);
      return NextResponse.json({ order: saved.data, brokerMessage: message });
    }

    if (row.state !== 'draft') return fail('This review was already submitted. Refresh its status.', 409);
    if (row.connection_version !== connection.data.updated_at || Date.now() - Date.parse(row.created_at) > REVIEW_MS) return fail('This review expired. Review the order again.', 409);
    const [quote] = await broker.quotes([row.request.instrumentId]);
    const checked = Date.now();
    if ((row.signal_expires_at && checked >= Date.parse(row.signal_expires_at))
      || (isStockTradeRule(row.strategy) && !stockEntryWindow(row.strategy, checked, false))) return fail('The strategy entry window expired.', 409);
    const ask = freshStockAsk(quote, checked);
    if (!ask || quote.instrumentId !== row.request.instrumentId || ask / Number(row.reference_price) > (row.strategy_exit_at ? 1.001 : 1.005)
      || (row.strategy_exit_at && (!quote.bid || (ask - quote.bid) / ask > 0.001))) return fail('The quote changed. Review the order again.', 409);
    if (!quote.bid || !approvedStockStop(row.request, { ask, bid: quote.bid }, row.stop_margin_pct)) return fail('The quote moved outside the reviewed stop. Review the order again.', 409);
    const claimed = await update({ state: 'sending', submission_quote: journalQuote(quote.bid, ask, quote.date) }).eq('state', 'draft').select('id').maybeSingle();
    if (claimed.error?.code === '23505') return fail('This signal already has an order, or an order for the stock is pending.', 409);
    if (claimed.error || !claimed.data) return fail('Could not reserve the order for submission.', 409);

    try {
      const orderId = await submitStockOrder(db, broker, user.id, row.id, row.request);
      return NextResponse.json({ orderId });
    } catch (error) {
      const rejected = error instanceof EtoroError && [400, 401, 403, 404, 422, 429].includes(error.status);
      return rejected
        ? fail(error.status === 401 || error.status === 403 ? 'eToro denied order execution. Check Write permission and account eligibility.' : `eToro rejected the order (HTTP ${error.status}).`, 422)
        : fail('The submission outcome is unknown. Refresh its status before placing another order.', 502);
    }
  } catch (error) {
    if (error instanceof StockSizingError) return fail(error.message, 422);
    if (error instanceof EtoroError) {
      if (error.status === 404 && body.action === 'status') return fail('eToro has no matching confirmation yet. Check the eToro account before trying again.', 404);
      if (error.status === 401 || error.status === 403) return fail('eToro rejected the request. Check your account and key permissions.', 422);
      if (error.status === 429) return fail('eToro asked us to slow down. Try again in a minute.', 429);
    }
    return fail('eToro could not complete the request. Try again shortly.', 503);
  }
}
