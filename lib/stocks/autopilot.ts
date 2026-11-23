import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { etoroFromConnection } from './connection';
import { EtoroError, type EtoroClient, type StockOrder } from './etoro';
import { freshStockAsk, previousStockSession, stockMarketClock } from './session';
import { currentStockEntry, dailyTradeSignal, stockEntryWindow, stockTradeDailyBars } from './trade-signals';
import { type StockTradeRule, type StockTradeSymbol } from './trade-rules';

export type StockEnvironment = 'demo' | 'real';
export type StockAutoConfig = {
  user_id: string; symbol: StockTradeSymbol; strategy: StockTradeRule; amount: number; active_environment: StockEnvironment | null; updated_at: string;
};
type AutoOrder = { id: string; environment: StockEnvironment; connection_version: string; state: string; position_ids: number[]; request: StockOrder; strategy: StockTradeRule; signal_day: string | null; strategy_exit_at: string | null; updated_at: string; close_requests: Record<string, string> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export async function reconcileStockOrder(broker: EtoroClient, id: string) {
  const order = await broker.stockOrderStatus(id);
  const ids = (order.positionExecutions ?? []).map(p => p.positionId).filter(id => Number.isSafeInteger(id) && id > 0);
  const code = order.status?.id;
  const state = (code === 3 || code === 10) && ids.length ? 'filled'
    : [4, 6, 7, 8, 9, 10].includes(code) && !ids.length ? 'rejected' : 'submitted';
  return { state, broker_order_id: order.orderId, position_ids: ids, message: order.status?.errorMessage ?? null };
}

export async function submitStockOrder(db: Db, broker: EtoroClient, userId: string, id: ReturnType<typeof randomUUID>, request: StockOrder) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id).eq('state', 'sending');
  try {
    const response = await broker.openStock(request, id);
    if (!Number.isSafeInteger(response.orderId) || response.orderId <= 0) throw new Error('Missing broker order ID');
    const saved = await update({ state: 'submitted', broker_order_id: response.orderId });
    if (saved.error) throw new Error('Could not save the broker response');
    return response.orderId;
  } catch (error) {
    const rejected = error instanceof EtoroError && [400, 401, 403, 404, 422, 429].includes(error.status);
    await update({ state: rejected ? 'rejected' : 'review' });
    throw error;
  }
}

export async function scanStockAutopilot(db: Db, userId: string, config?: StockAutoConfig, now = Date.now()) {
  const session = stockMarketClock(now);
  const previous = previousStockSession(now);
  if (!session.open || !previous) return 'Waiting for the US market';
  const { data, error } = await db.from('etoro_stock_orders').select('*').eq('user_id', userId)
    .or('signal_day.not.is.null,strategy_exit_at.not.is.null').is('closed_at', null).not('state', 'in', '(draft,rejected)');
  if (error) throw new Error('Could not read managed positions');
  const active = (data ?? []) as AutoOrder[];
  const modes = new Set(active.map(row => row.environment));
  if (config?.active_environment) modes.add(config.active_environment);
  const messages: string[] = [];

  for (const environment of modes) {
    const { data: connection, error } = await db.from('etoro_connections').select('credentials_encrypted, environment, updated_at').eq('user_id', userId).eq('environment', environment).maybeSingle();
    if (error || !connection) { messages.push(`Reconnect eToro ${environment} to manage orders`); continue; }
    const broker = etoroFromConnection(connection);
    const open = active.filter(row => row.environment === environment);
    if (open.length) {
      for (const row of open) messages.push(await manageStockOrder(db, broker, userId, row, connection.updated_at, previous, now));
      continue;
    }
    if (!config || config.active_environment !== environment || !stockEntryWindow(config.strategy, now, true)) continue;
    const instrument = await broker.instrument(config.symbol);
    if (!instrument) { messages.push('Selected ticker is unavailable'); continue; }
    const instrumentId = instrument.instrumentId;
    const signal = await currentStockEntry(broker, config.symbol, instrumentId, config.strategy, now);
    if (!signal) {
      messages.push(`No current strategy entry for ${config.symbol}`);
      continue;
    }
    const [eligible, quotes, portfolio] = await Promise.all([broker.stockEligibility(instrumentId), broker.quotes([instrumentId]), broker.portfolio()]);
    const quote = quotes.find(q => q.instrumentId === instrumentId);
    const ask = freshStockAsk(quote, Date.now());
    const amount = Number(config.amount);
    if (!ask || !quote?.bid || (ask - quote.bid) / ask > signal.maxSpread) { messages.push('No fresh quote within the spread limit'); continue; }
    if (!eligible.allowed || amount < eligible.minimum || portfolio.credit <= amount) { messages.push('Check eToro eligibility, buying power, and minimum order size'); continue; }
    const request: StockOrder = { action: 'open', transaction: 'buy', instrumentId, settlementType: 'real', orderType: 'mkt', amount, leverage: 1, orderCurrency: 'usd' };
    const estimate = await broker.stockOrderCosts(request);
    const fees = estimate.filter(cost => cost.currency.toUpperCase() === 'USD' && cost.costType === 'transactionFee').reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
    if (portfolio.credit < amount + fees) { messages.push('Buying power is below the order and estimated fees'); continue; }
    const checked = Date.now();
    if (!freshStockAsk(quote, checked) || checked >= signal.validUntil || !stockEntryWindow(config.strategy, checked, true)) { messages.push('Entry window or quote expired'); continue; }
    const reserved = await db.rpc('reserve_stock_autopilot_order', {
      account: userId, mode: environment, config_version: config.updated_at, key_version: connection.updated_at, session_day: session.day,
      instrument: instrumentId, price: ask, signal_expiry: new Date(signal.validUntil).toISOString(),
      timed_exit: signal.exitAt == null ? null : new Date(signal.exitAt).toISOString(),
    });
    if (reserved.error) throw new Error('Could not reserve the strategy order');
    if (reserved.data) {
      await submitStockOrder(db, broker, userId, reserved.data, request);
      messages.push(`${config.symbol} buy submitted to eToro ${environment}`);
    }
  }
  return messages.join(' · ') || 'Waiting for the next market opening';
}

async function manageStockOrder(db: Db, broker: EtoroClient, userId: string, row: AutoOrder, connectionVersion: string, previous: string, now: number) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', row.id);
  if (row.state !== 'filled') {
    try {
      const { message, ...summary } = await reconcileStockOrder(broker, row.id);
      const saved = await update(summary).eq('state', row.state);
      if (saved.error) throw new Error('Could not reconcile stock order');
      return message ?? `eToro order ${summary.state}`;
    } catch (error) {
      if (error instanceof EtoroError && error.status === 404) return 'Waiting for eToro to confirm the submitted order';
      throw error;
    }
  }

  const book = await broker.portfolio();
  const positions = book.positions.filter(position => row.position_ids.includes(position.id) && position.instrumentId === row.request.instrumentId && position.side === 'Long');
  if (!positions.length) {
    if (connectionVersion !== row.connection_version) return 'The key changed and the tracked position is missing. Check the original eToro account.';
    // A newly filled order can reach order history before the portfolio feed.
    if (now - Date.parse(row.updated_at) < 10 * 60_000) return 'Waiting for the filled position to appear in the portfolio';
    const saved = await update({ closed_at: new Date(now).toISOString() });
    if (saved.error) throw new Error('Could not finalize stock exits');
    return 'Managed position closed';
  }
  if (row.strategy_exit_at) {
    if (now < Date.parse(row.strategy_exit_at)) return 'Holding until the scheduled exit';
  } else if (row.signal_day && row.strategy !== 'earnings-rebound') {
    const bars = await stockTradeDailyBars(broker, row.request.instrumentId, row.strategy, now);
    if (bars.at(-1)?.day !== previous) return 'Waiting for the previous session’s complete daily bar';
    const held = bars.filter(bar => bar.day >= row.signal_day!).length;
    if (held === 0 || !dailyTradeSignal(bars, row.strategy, held)) return 'Holding the open strategy position';
  } else {
    return 'Managed exit data is missing. Check the position in eToro.';
  }
  const [quote] = await broker.quotes([row.request.instrumentId]);
  if (!freshStockAsk(quote, Date.now())) return 'Waiting for a real-time quote to send the exit';
  const pending = { ...row.close_requests };
  let version = row.updated_at;
  for (const position of positions) {
    if (pending[position.id]) continue;
    const reference = randomUUID();
    const next = new Date().toISOString();
    pending[position.id] = reference;
    const claim = await db.from('etoro_stock_orders').update({ close_requests: pending, updated_at: next }).eq('user_id', userId).eq('id', row.id).eq('updated_at', version).select('id').maybeSingle();
    if (claim.error || !claim.data) return 'Another scan is handling the exit';
    version = next;
    try {
      await broker.closeStock(position.id, row.request.instrumentId, reference);
    } catch (error) {
      // Preserve the durable request reference. A network error can happen after eToro accepted the order.
      if (!(error instanceof EtoroError) || error.status >= 500) return 'Exit submission unconfirmed. Check the position in eToro.';
      return `eToro declined the exit (HTTP ${error.status}). Check the position in eToro.`;
    }
  }
  return 'Exit sent or awaiting confirmation in eToro';
}
