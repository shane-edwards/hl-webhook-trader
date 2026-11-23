import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { etoroFromConnection } from './connection';
import { EtoroError, type EtoroClient, type StockOrder } from './etoro';
import { freshStockAsk, previousStockSession, stockMarketClock } from './session';
import { currentStockEntry, dailyTradeSignal, stockEntryWindow, stockTradeDailyBars } from './trade-signals';
import { STOCK_INSTRUMENTS, type StockTradeRule, type StockTradeSymbol } from './trade-rules';
import { prepareStockOrder, stockOrderFees, StockSizingError, type StockLeverage } from './leverage';
import { stockPortfolioEntry, stockPortfolioRisk, stockPortfolioSchema, type StockPortfolio } from './portfolio';
import { estimatedStockEntryCost, scanStockSetups } from './setups';
import { journalQuote, readStockCloseExecution, stockCalibrations, stockJournalFill, type StockJournalClose, type StockJournalCost, type StockJournalOrder, type StockJournalQuote } from './execution-journal';

export type StockEnvironment = 'demo' | 'real';
export type StockAutoConfig = {
  user_id: string; symbol: StockTradeSymbol; strategy: StockTradeRule; amount: number; active_environment: StockEnvironment | null; updated_at: string;
  leverage: StockLeverage; stop_margin_pct: number | null; portfolio?: StockPortfolio | null;
};
type AutoOrder = { id: string; environment: StockEnvironment; connection_version: string; state: string; position_ids: number[]; request: StockOrder; strategy: StockTradeRule; signal_day: string | null; strategy_exit_at: string | null; updated_at: string; close_requests: Record<string, string>; protection_state: string | null; close_execution?: Record<string, StockJournalClose> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export async function reconcileStockOrder(broker: EtoroClient, id: string, request?: StockOrder) {
  const order = await broker.stockOrderStatus(id);
  const ids = (order.positionExecutions ?? []).map(p => p.positionId).filter(id => Number.isSafeInteger(id) && id > 0);
  const code = order.status?.id;
  const state = [3, 5, 9, 10].includes(code) && ids.length ? 'filled'
    : [4, 7, 8, 9, 10].includes(code) && !ids.length ? 'rejected' : 'submitted';
  const protection = request?.settlementType === 'cfd' && state === 'filled'
    ? order.positionExecutions.some(p => p.state?.toLowerCase() !== 'closed'
      && (typeof p.stopLossRate !== 'number' || p.stopLossRate < request.stopLossRate - 0.005)) ? 'exit_required' : 'protected'
    : undefined;
  const fill = stockJournalFill(order);
  const message = order.status?.errorMessage ?? null;
  return { state, broker_order_id: order.orderId, broker_state: code ?? null, position_ids: ids, ...(protection ? { protection_state: protection } : {}),
    ...(fill ? { fill_metrics: fill } : {}), broker_message: message, message };
}

type AutoExecution = { decision: StockJournalQuote; submission: StockJournalQuote; costs: StockJournalCost[] };
export async function submitStockOrder(db: Db, broker: EtoroClient, userId: string, id: ReturnType<typeof randomUUID>, request: StockOrder, execution?: AutoExecution) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id).eq('state', 'sending');
  if (execution) {
    const saved = await update({ decision_quote: execution.decision, submission_quote: execution.submission, estimated_costs: execution.costs }).select('id').maybeSingle();
    if (saved.error || !saved.data) {
      await update({ state: 'rejected', broker_message: 'The Tideframe execution journal could not save the quote before submission.' });
      throw new Error('Could not save the execution quote');
    }
  }
  try {
    const response = await broker.openStock(request, id);
    if (!Number.isSafeInteger(response.orderId) || response.orderId <= 0) throw new Error('Missing broker order ID');
    const saved = await update({ state: 'submitted', broker_order_id: response.orderId });
    if (saved.error) throw new Error('Could not save the broker response');
    return response.orderId;
  } catch (error) {
    const rejected = error instanceof EtoroError && [400, 401, 403, 404, 422, 429].includes(error.status);
    await update({ state: rejected ? 'rejected' : 'review',
      broker_message: error instanceof EtoroError ? `eToro HTTP ${error.status}` : 'No confirmed response from eToro' });
    throw error;
  }
}

export async function scanStockAutopilot(db: Db, userId: string, config?: StockAutoConfig, now = Date.now()) {
  const session = stockMarketClock(now);
  const previous = previousStockSession(now);
  if (!session.open || !previous) return 'Waiting for the US market';
  const { data, error } = await db.from('etoro_stock_orders').select('*').eq('user_id', userId)
    .or('signal_day.not.is.null,strategy_exit_at.not.is.null,protection_state.in.(unverified,exit_required)').is('closed_at', null).not('state', 'in', '(draft,rejected)');
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
      const book = open.some(row => row.state === 'filled') ? broker.portfolio() : undefined;
      const managed = await Promise.allSettled(open.map(row => manageStockOrder(db, broker, userId, row, connection.updated_at, previous, now, book)));
      messages.push(...new Set(managed.map(result => result.status === 'fulfilled' ? result.value : 'Position management could not finish. Check eToro.')));
      if (managed.some(result => result.status === 'rejected') || !config?.portfolio) continue;
    }
    if (config?.portfolio && config.active_environment === environment) {
      messages.push(await scanPortfolio(db, broker, config, environment, connection.updated_at, open, now));
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
    const [options, quotes, portfolio] = await Promise.all([broker.stockOrderOptions(instrumentId), broker.quotes([instrumentId]), broker.portfolio()]);
    const quote = quotes.find(q => q.instrumentId === instrumentId);
    const ask = freshStockAsk(quote, Date.now());
    const amount = Number(config.amount);
    if (!ask || !quote?.bid || (ask - quote.bid) / ask > signal.maxSpread) { messages.push('No fresh quote within the spread limit'); continue; }
    let request: StockOrder;
    try {
      request = prepareStockOrder(instrumentId, { ask, bid: quote.bid }, options, { amount, leverage: config.leverage, stopMarginPct: config.stop_margin_pct });
    } catch (error) {
      if (!(error instanceof StockSizingError)) throw error;
      messages.push(error.message);
      continue;
    }
    const estimate = await broker.stockOrderCosts(request);
    if (portfolio.availableCash < amount + stockOrderFees(estimate)) { messages.push('Buying power is below the order and estimated fees'); continue; }
    const checked = Date.now();
    if (!freshStockAsk(quote, checked) || checked >= signal.validUntil || !stockEntryWindow(config.strategy, checked, true)) { messages.push('Entry window or quote expired'); continue; }
    const reserved = await db.rpc('reserve_stock_autopilot_order', {
      account: userId, mode: environment, config_version: config.updated_at, key_version: connection.updated_at, session_day: session.day,
      instrument: instrumentId, price: ask, signal_expiry: new Date(signal.validUntil).toISOString(),
      timed_exit: signal.exitAt == null ? null : new Date(signal.exitAt).toISOString(),
      stop_rate: request.settlementType === 'cfd' ? request.stopLossRate : null,
    });
    if (reserved.error) throw new Error('Could not reserve the strategy order');
    if (reserved.data) {
      const baseline = journalQuote(quote.bid, ask, quote.date);
      await submitStockOrder(db, broker, userId, reserved.data, request, { decision: baseline, submission: baseline, costs: estimate });
      messages.push(`${config.symbol} buy submitted to eToro ${environment}`);
    }
  }
  return messages.join(' · ') || 'Waiting for the next market opening';
}

async function scanPortfolio(db: Db, broker: EtoroClient, config: StockAutoConfig, environment: StockEnvironment, connectionVersion: string, open: AutoOrder[], now: number) {
  const { data: settings, success } = stockPortfolioSchema.safeParse(config.portfolio);
  if (!success) return 'Portfolio settings need review';
  const account = config.user_id;
  const day = stockMarketClock(now).day;
  const scanUntil = new Date(Date.now() + 70_000).toISOString();
  const { data: claim, error: claimError } = await db.from('stock_autopilot').update({ scan_until: scanUntil })
    .eq('user_id', account).eq('updated_at', config.updated_at)
    .or(`scan_until.is.null,scan_until.lt.${new Date().toISOString()}`).select('user_id').maybeSingle();
  if (claimError) throw claimError;
  if (!claim) return 'Another scan is checking this portfolio';
  try {
    const sessionKey = { user_id: account, environment, session_day: day };
    const sessionQuery = () => db.from('stock_portfolio_sessions').select('opening_equity, loss_locked').match(sessionKey);
    const read = await sessionQuery().maybeSingle();
    if (read.error) throw read.error;
    if (read.data?.loss_locked) return 'Daily loss limit reached. New entries paused for this US session.';
    const riskCheck = (book: Awaited<ReturnType<EtoroClient['portfolio']>>) => {
      const risk = stockPortfolioRisk(book);
      if (!risk || open.some(row => row.state !== 'filled' || !row.position_ids.length
          || row.protection_state === 'exit_required' || row.protection_state === 'unverified'
          || !row.position_ids.some(id => book.positions.some(position => position.id === id)))) return null;
      return risk;
    };
    const book = await broker.portfolio();
    const risk = riskCheck(book);
    if (!risk) return 'Skipped entries while exposure or eToro orders are unresolved';
    let baseline = read.data;
    if (!baseline && risk.equity > 0) {
      const saved = await db.from('stock_portfolio_sessions').upsert({ ...sessionKey, opening_equity: risk.equity },
        { onConflict: 'user_id,environment,session_day', ignoreDuplicates: true });
      if (saved.error) throw saved.error;
      const reread = await sessionQuery().single();
      if (reread.error) throw reread.error;
      baseline = reread.data;
    }
    if (!baseline) return 'Skipped entries because opening account equity is unavailable';
    const lossMessage = 'Daily loss limit reached. New entries paused for this US session.';
    const lossReached = async (equity: number) => {
      if (!baseline.loss_locked && Number(baseline.opening_equity) - equity < settings.dailyLoss) return false;
      const saved = await db.from('stock_portfolio_sessions').update({ loss_locked: true }).match(sessionKey);
      if (saved.error) throw saved.error;
      return true;
    };
    if (await lossReached(risk.equity)) return lossMessage;
    if (!settings.strategies.some(rule => stockEntryWindow(rule, now, true))) return 'Waiting for the next scheduled strategy entry window';
    const amount = Number(config.amount);
    const exposure = amount * config.leverage;
    if (risk.positions.size >= settings.maxPositions || risk.gross + exposure > settings.maxExposure) return 'Skipped entries at the portfolio position or exposure limit';
    if (book.availableCash < amount) return 'Skipped entries because buying power is below the order amount';
    const priorAttempts = await db.from('etoro_stock_orders').select('symbol').eq('user_id', account).eq('environment', environment).eq('signal_day', day);
    if (priorAttempts.error) throw priorAttempts.error;
    const used = new Set(priorAttempts.data.map(row => row.symbol));
    const symbols = settings.symbols.filter(symbol => !used.has(symbol) && !stockPortfolioEntry(settings, risk, STOCK_INSTRUMENTS[symbol], exposure));
    if (!symbols.length) return 'All selected stocks already attempted an entry or reached a portfolio limit';
    const sizing = { amount, leverage: config.leverage, stopMarginPct: config.stop_margin_pct };
    const fills = await db.from('etoro_stock_orders').select('symbol, request, state, submission_quote, fill_metrics, broker_state').eq('user_id', account)
      .eq('environment', environment).eq('state', 'filled').not('fill_metrics', 'is', null).order('created_at', { ascending: false }).limit(300);
    const slippageBySymbol = stockCalibrations((fills.data ?? []) as StockJournalOrder[], symbols, sizing.leverage);
    const scan = await scanStockSetups(broker, sizing, { symbols, rules: settings.strategies, automatic: true, slippageBySymbol }, now);
    const candidate = scan.rows.find(candidate => candidate.evidence.status !== 'Skip' && (!settings.evidenceOnly || candidate.evidence.status === 'Qualified')
      && candidate.entryCost * 10_000 / exposure <= settings.maxCostBps
      && book.availableCash >= amount + candidate.entryCost);
    if (!candidate) {
      if (scan.rows.length && scan.rows.every(row => row.evidence.status === 'Skip' || (settings.evidenceOnly && row.evidence.status === 'Watch'))) {
        return 'Skipped entries with weak or insufficient historical evidence';
      }
      if (scan.rows.length) return 'Skipped entries that exceeded cost or buying power limits';
      if (scan.unavailable.length || scan.estimateSkipped || scan.spreadSkipped) return 'No eligible setup with complete data, an executable quote and a broker estimate';
      return 'No selected strategy has a qualifying entry';
    }
    const [freshBook, quotes] = await Promise.all([broker.portfolio(), broker.quotes([candidate.id])]);
    const updatedRisk = riskCheck(freshBook);
    if (!updatedRisk) return 'Skipped entry because the eToro book changed';
    if (await lossReached(updatedRisk.equity)) return lossMessage;
    const riskBlock = stockPortfolioEntry(settings, updatedRisk, candidate.id, exposure);
    if (riskBlock) return `${candidate.symbol} skipped · ${riskBlock}`;
    const quote = quotes.find(item => item.instrumentId === candidate.id);
    const checked = Date.now();
    const ask = freshStockAsk(quote, checked);
    if (!ask || !quote?.bid || checked >= candidate.signal.validUntil || !stockEntryWindow(candidate.rule, checked, true)
        || (ask - quote.bid) / ask > candidate.signal.maxSpread) return 'The best setup expired or its spread widened';
    const cost = estimatedStockEntryCost(candidate.costs, (ask - quote.bid) * 10_000 / ask, exposure);
    if (cost * 10_000 / exposure > settings.maxCostBps || freshBook.availableCash < amount + cost) return 'The best setup exceeded the refreshed cost or buying-power limit';
    if (candidate.evidence.status === 'Qualified' && candidate.evidence.lowerBps! <= 2 * (cost - candidate.entryCost) * 10_000 / exposure) {
      return 'The refreshed quote no longer clears the historical evidence check';
    }
    const order = candidate.execution;
    if (order.settlementType === 'cfd' && (order.stopLossRate >= quote.bid
        || (1 - order.stopLossRate / ask) * order.leverage * 100 > sizing.stopMarginPct! + 1e-8)) {
      return 'The CFD stop needs a fresh quote before an entry can proceed';
    }
    const reserved = await db.rpc('reserve_stock_portfolio_order', {
      account, mode: environment, config_version: config.updated_at, key_version: connectionVersion, session_day: day,
      scan_version: scanUntil, ticker: candidate.symbol, trade_rule: candidate.rule, payload: order, price: ask,
      signal_expiry: new Date(candidate.signal.validUntil).toISOString(),
      timed_exit: candidate.signal.exitAt == null ? null : new Date(candidate.signal.exitAt).toISOString(),
    });
    if (reserved.error) throw reserved.error;
    if (!reserved.data) return 'Entry reservation was blocked by a newer setting, order, or session limit';
    await submitStockOrder(db, broker, account, reserved.data, order, {
      decision: { bid: candidate.bid, ask: candidate.ask, at: candidate.quoteAt, observedAt: scan.scannedAt },
      submission: journalQuote(quote.bid, ask, quote.date), costs: candidate.costs,
    });
    return `${candidate.symbol} buy submitted to eToro ${environment}`;
  } finally {
    await db.from('stock_autopilot').update({ scan_until: null }).eq('user_id', account).eq('scan_until', scanUntil);
  }
}

async function manageStockOrder(db: Db, broker: EtoroClient, userId: string, row: AutoOrder, connectionVersion: string, previous: string, now: number,
  sharedBook?: ReturnType<EtoroClient['portfolio']>) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ ...patch, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', row.id);
  if (row.state !== 'filled') {
    try {
      const { message, ...summary } = await reconcileStockOrder(broker, row.id, row.request);
      const saved = await update(summary).eq('state', row.state);
      if (saved.error) throw new Error('Could not reconcile stock order');
      if (summary.protection_state === 'exit_required') return 'eToro did not confirm the stop. A protective exit is required.';
      return message ?? `eToro order ${summary.state}`;
    } catch (error) {
      if (error instanceof EtoroError && error.status === 404) return 'Waiting for eToro to confirm the submitted order';
      throw error;
    }
  }

  const book = await (sharedBook ?? broker.portfolio());
  const positions = book.positions.filter(position => row.position_ids.includes(position.id) && position.instrumentId === row.request.instrumentId && position.side === 'Long');
  const closeExecution = { ...row.close_execution };
  if (!positions.length) {
    if (connectionVersion !== row.connection_version) return 'The key changed and the tracked position is missing. Check the original eToro account.';
    // A newly filled order can reach order history before the portfolio feed.
    if (now - Date.parse(row.updated_at) < 10 * 60_000) return 'Waiting for the filled position to appear in the portfolio';
    await Promise.all(Object.entries(closeExecution).map(async ([id, closing]) => {
      closeExecution[id] = await readStockCloseExecution(broker, row.request.instrumentId, id, closing).catch(() => closing);
    }));
    const saved = await update({ closed_at: new Date(now).toISOString(), close_execution: closeExecution });
    if (saved.error) throw new Error('Could not finalize stock exits');
    return 'Managed position closed';
  }
  // An unconfirmed stop triggers the existing exit workflow before applying the strategy's exit rules.
  if (row.protection_state !== 'exit_required') {
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
      const receipt = await broker.closeStock(position.id, row.request.instrumentId, reference);
      const orderId = receipt.orderForClose?.orderID;
      if (orderId && Number.isSafeInteger(orderId)) {
        const observed = quote?.ask && quote.bid ? journalQuote(quote.bid, quote.ask, quote.date) : null;
        closeExecution[position.id] = { orderId, quote: observed };
        await db.from('etoro_stock_orders').update({ close_execution: closeExecution }).eq('user_id', userId).eq('id', row.id).eq('updated_at', version);
      }
    } catch (error) {
      // Preserve the durable request reference. A network error can happen after eToro accepted the order.
      if (!(error instanceof EtoroError) || error.status >= 500) return 'Exit submission unconfirmed. Check the position in eToro.';
      return `eToro declined the exit (HTTP ${error.status}). Check the position in eToro.`;
    }
  }
  return 'Exit sent or awaiting confirmation in eToro';
}
