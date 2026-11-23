import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { EtoroError, isStockSymbol, type StockOrder } from '@/lib/stocks/etoro';
import { STOCK_RULES, stockSetups } from '@/lib/stocks/research';
import { freshStockAsk, previousStockSession, stockMarketClock } from '@/lib/stocks/session';
import { reconcileStockOrder, submitStockOrder } from '@/lib/stocks/autopilot';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const REVIEW_MS = 2 * 60_000;
const visible = 'id, environment, symbol, strategy, state, broker_order_id, position_ids, created_at';
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
const environment = z.enum(['demo', 'real']);
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), symbol: z.string(), strategy: z.string().optional(), amount: z.number().positive().max(100_000), environment }),
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
  const env = environment.safeParse(new URL(request.url).searchParams.get('environment'));
  if (!env.success) return fail('Select Demo or Real.', 400);
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
    if (body.action === 'review') {
      const rule = STOCK_RULES.find(rule => rule.id === body.strategy);
      if (!isStockSymbol(body.symbol) || (body.strategy && !rule)) return fail('Choose a supported stock and strategy.', 400);
      if (Math.round(body.amount * 100) <= 0) return fail('Enter an amount in dollars and cents.', 400);
      if (!stockMarketClock(Date.now()).open) return fail('Orders are available during the regular US market session.', 409);
      const instrument = await broker.instrument(body.symbol);
      if (!instrument) return fail('This stock is unavailable on eToro.', 422);
      const instrumentId = instrument.instrumentId;
      const [eligible, quotes, book, setup] = await Promise.all([
        broker.stockEligibility(instrumentId), broker.quotes([instrumentId]), broker.portfolio(),
        rule ? broker.candles(instrumentId, 240, Date.now(), true).then(stockSetups) : null,
      ]);
      const quote = quotes.find(quote => quote.instrumentId === instrumentId);
      const ask = freshStockAsk(quote, Date.now());
      if (!ask) return fail('Waiting for a fresh real-time eToro quote.', 409);
      if (rule && (setup?.day !== previousStockSession(Date.now()) || !setup.setups.includes(rule.id))) return fail('This strategy has no current entry signal for this stock.', 409);
      const amount = Math.round(body.amount * 100) / 100;
      if (!eligible.allowed) return fail('eToro did not confirm a cash-stock buy for this account.', 422);
      if (amount < eligible.minimum) return fail(`eToro’s minimum for this stock is $${eligible.minimum.toFixed(2)}.`, 422);
      const order: StockOrder = { action: 'open', transaction: 'buy', instrumentId, settlementType: 'real', orderType: 'mkt', leverage: 1, amount, orderCurrency: 'usd' };
      const costs = await broker.stockOrderCosts(order);
      const fees = costs.filter(cost => cost.currency.toUpperCase() === 'USD' && cost.costType === 'transactionFee').reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
      if (book.credit < amount + fees) return fail('Your eToro buying power is below the order amount and estimated fees.', 422);
      const saved = await orders().insert({
        user_id: user.id, environment: body.environment, connection_version: connection.data.updated_at,
        symbol: body.symbol, strategy: rule?.id ?? null, request: order, reference_price: ask,
      }).select(visible).single();
      if (saved.error) return fail('Could not save the order review.', 503);
      return NextResponse.json({ review: saved.data, name: instrument.displayName, ask, amount, costs });
    }

    const find = () => orders().select('*').eq('user_id', user.id).eq('environment', body.environment).eq('id', body.id).maybeSingle();
    const order = await find();
    if (order.error) return fail('Could not load the order.', 503);
    if (!order.data) return fail('Order not found.', 404);
    const row = order.data;
    const update = (value: object) => orders().update({ ...value, updated_at: new Date().toISOString() }).eq('user_id', user.id).eq('id', body.id);

    if (body.action === 'status') {
      if (['draft', 'filled', 'rejected'].includes(row.state)) return fail('This order needs no status refresh.', 409);
      const { message, ...summary } = await reconcileStockOrder(broker, row.id);
      const saved = await update(summary).eq('state', row.state).select(visible).maybeSingle();
      if (saved.error) return fail('Could not save the broker status.', 503);
      return NextResponse.json({ order: saved.data, brokerMessage: message });
    }

    if (row.state !== 'draft') return fail('This review was already submitted. Refresh its status.', 409);
    if (row.connection_version !== connection.data.updated_at || Date.now() - Date.parse(row.created_at) > REVIEW_MS) return fail('This review expired. Review the order again.', 409);
    const [quote] = await broker.quotes([row.request.instrumentId]);
    const ask = freshStockAsk(quote, Date.now());
    if (!ask || quote.instrumentId !== row.request.instrumentId || ask / Number(row.reference_price) > 1.005) return fail('The quote changed. Review the order again.', 409);
    const claimed = await update({ state: 'sending' }).eq('state', 'draft').select('id').maybeSingle();
    if (claimed.error?.code === '23505') return fail('Another order for this stock is pending. Refresh its status first.', 409);
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
    if (error instanceof EtoroError) {
      if (error.status === 404 && body.action === 'status') return fail('eToro has no matching confirmation yet. Check the eToro account before trying again.', 404);
      if (error.status === 401 || error.status === 403) return fail('eToro rejected the request. Check your account and key permissions.', 422);
      if (error.status === 429) return fail('eToro asked us to slow down. Try again in a minute.', 429);
    }
    return fail('eToro could not complete the request. Try again shortly.', 503);
  }
}
