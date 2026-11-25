import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { etoroFromConnection } from './connection';
import { EtoroError, type EtoroClient, type StockOrder } from './etoro';
import { freshStockAsk, previousStockSession, stockMarketClock } from './session';
import { currentStockEntry, dailyTradeSignal, stockEntryWindow, stockTradeDailyBars } from './trade-signals';
import { STOCK_INSTRUMENTS, type StockTradeRule, type StockTradeSymbol } from './trade-rules';
import { prepareStockOrder, stockOrderFees, StockSizingError, type StockLeverage } from './leverage';
import { stockGroupExposure, stockPortfolioEntry, stockPortfolioRisk, stockPortfolioSchema, type StockPortfolio } from './portfolio';
import { estimatedStockEntryCost, scanStockSetups } from './setups';
import { journalQuote, readStockCloseExecution, stockCalibrations, stockJournalFill, type StockJournalClose, type StockJournalCost, type StockJournalOrder, type StockJournalQuote } from './execution-journal';
import { blockedStockStrategies } from './strategy-guard-data';
import type { AutomationDecision } from '@/lib/automation/policy';
import { formatCurrency } from '@/lib/utils';

export type StockEnvironment = 'demo' | 'real';
export type StockAutoConfig = {
  user_id: string; symbol: StockTradeSymbol; strategy: StockTradeRule; amount: number; active_environment: StockEnvironment | null; updated_at: string;
  leverage: StockLeverage; stop_margin_pct: number | null; portfolio?: StockPortfolio | null; automation_version?: string | null;
};
// 'external' marks a position that left the portfolio without a close eToro can attribute to the app's request.
// 'unconfirmed' marks an exit eToro never confirmed before the row was closed at the flat-portfolio ceiling.
// sentAt is when the close request was sent. Rows saved before it existed use the row's updated_at instead.
// flatAt is the first scan that found the portfolio flat while this exit was still unconfirmed.
type CloseAttempt = { state: 'uncertain' | 'submitted' | 'rejected' | 'filled' | 'external' | 'unconfirmed'; count: number; retryAt?: number; sentAt?: number; flatAt?: number; detail?: string };
type AutoOrder = { id: string; environment: StockEnvironment; connection_version: string; state: string; position_ids: number[]; request: StockOrder; strategy: StockTradeRule; signal_day: string | null; strategy_exit_at: string | null; updated_at: string; close_requests: Record<string, string>; close_attempts?: Record<string, CloseAttempt>; protection_state: string | null; close_execution?: Record<string, StockJournalClose>;
  symbol?: string; created_at?: string; broker_message?: string | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
// A close eToro has no record of is resent only after this long, and only while the position is still open.
const CLOSE_NOT_RECEIVED_MS = 3 * 60_000;
// A reference eToro has no record of stops blocking the row after this long.
const UNRESOLVED_REFERENCE_MS = 15 * 60_000;
const UNMATCHED_ORDER_NOTE = 'eToro has no record of this order, but the account holds a position or pending order it could have opened.';
// A flat portfolio with an exit eToro has not confirmed blocks every new portfolio entry, so the wait has a ceiling.
// Exit details normally arrive within minutes. 24 hours from the first flat scan spans the rest of that session and
// most of the next one, and scans only run in market hours, so the row is closed only after a fresh check also fails.
const FLAT_UNCONFIRMED_MS = 24 * 3_600_000;
const DAILY_LOSS_NOTE = 'Daily loss limit reached. New entries paused for this US session.';
type Book = Awaited<ReturnType<EtoroClient['portfolio']>>;

// Assumes eToro answers HTTP 404 for a reference it never received. Timeouts, network errors, 5xx and replies without an order ID stay unknown.
async function lookupReference(broker: EtoroClient, reference: string) {
  try {
    return { orderId: (await broker.stockOrderStatus(reference))?.orderId || undefined, missing: false };
  } catch (error) {
    return { orderId: undefined, missing: error instanceof EtoroError && error.status === 404 };
  }
}

// Assumes eToro reports openDateTime in UTC, as it does for quotes, sometimes without the suffix.
function brokerTime(value: unknown) {
  return typeof value === 'string' ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`) : NaN;
}

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

type AutoExecution = { decision: StockJournalQuote; submission: StockJournalQuote; costs: StockJournalCost[]; slipBps?: number; plannedNetBps?: number };
export async function submitStockOrder(db: Db, broker: EtoroClient, userId: string, id: ReturnType<typeof randomUUID>, request: StockOrder, execution?: AutoExecution) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ updated_at: new Date().toISOString(), ...patch }).eq('user_id', userId).eq('id', id).eq('state', 'sending');
  if (execution) {
    const saved = await update({ decision_quote: execution.decision, submission_quote: execution.submission,
      estimated_costs: execution.costs, planned_slippage_bps: execution.slipBps ?? 3, planned_net_bps: execution.plannedNetBps ?? null }).select('id').maybeSingle();
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

export async function scanStockAutopilot(db: Db, userId: string, config?: StockAutoConfig, now = Date.now(), policy?: AutomationDecision) {
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
    const paused = (await blockedStockStrategies(db, userId, environment, [config.strategy])).get(config.strategy);
    if (paused) { messages.push(`Strategy guard paused new entries · ${paused}`); continue; }
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
    const automation = config.automation_version ? policy?.profile : null;
    if (config.automation_version && (!automation || policy?.candidate?.version !== config.automation_version ||
        (environment === 'real' ? policy.decision !== 'live' : policy.decision !== 'paper'))) continue;
    const budget = automation && environment === 'real' ? Number(automation.loss_budget_usd) : Infinity;
    const risk = automation ? stockPortfolioRisk(portfolio) : null;
    if (automation && (!risk || risk.positions.has(instrumentId))) { messages.push('Skipped while exposure is unresolved or the ticker is already held'); continue; }
    const room = risk && automation && environment === 'real' ? Number(automation.max_order_usd) - stockGroupExposure(risk.group, instrumentId) : Infinity;
    let amount = Math.floor(Math.min(Number(config.amount), budget, room, automation ? portfolio.availableCash : Infinity) * 100) / 100;
    if (!ask || !quote?.bid || (ask - quote.bid) / ask > signal.maxSpread) { messages.push('No fresh quote within the spread limit'); continue; }
    if (amount <= 0) { messages.push('No buying power or group exposure available for this version'); continue; }
    let request: StockOrder;
    const quotePrices = { ask, bid: quote.bid };
    const size = (amount: number) => prepareStockOrder(instrumentId, quotePrices, options, { amount, leverage: config.leverage, stopMarginPct: config.stop_margin_pct });
    try {
      request = size(amount);
    } catch (error) {
      if (!(error instanceof StockSizingError)) throw error;
      messages.push(error.message);
      continue;
    }
    const estimate = await broker.stockOrderCosts(request);
    if (automation) {
      const roundTripFees = 2 * Math.max(1, stockOrderFees(estimate) + estimate.filter(cost => cost.costType === 'markup' && cost.currency.toUpperCase() === 'USD')
        .reduce((total, cost) => total + Math.max(0, cost.value), 0));
      amount = Math.floor(Math.min(amount, budget - roundTripFees, portfolio.availableCash - roundTripFees) * 100) / 100;
      try { request = size(amount); }
      catch (error) {
        if (!(error instanceof StockSizingError)) throw error;
        messages.push('The loss budget or buying power is below eToro’s minimum after fees'); continue;
      }
    } else if (portfolio.availableCash < amount + stockOrderFees(estimate)) { messages.push('Buying power is below the order and estimated fees'); continue; }
    const checked = Date.now();
    if (!freshStockAsk(quote, checked) || checked >= signal.validUntil || !stockEntryWindow(config.strategy, checked, true)) { messages.push('Entry window or quote expired'); continue; }
    const reservation = {
      account: userId, mode: environment, config_version: config.updated_at, key_version: connection.updated_at, session_day: session.day,
      instrument: instrumentId, price: ask, signal_expiry: new Date(signal.validUntil).toISOString(),
      timed_exit: signal.exitAt == null ? null : new Date(signal.exitAt).toISOString(),
    };
    const reserved = automation ? await db.rpc('reserve_automated_stock_entry', { ...reservation,
      order_amount: amount, approved_version: config.automation_version, approval_updated_at: automation.updated_at })
      : await db.rpc('reserve_stock_autopilot_order', { ...reservation, stop_rate: request.settlementType === 'cfd' ? request.stopLossRate : null });
    if (reserved.error) throw new Error('Could not reserve the strategy order');
    if (reserved.data) {
      const baseline = journalQuote(quote.bid, ask, quote.date);
      await submitStockOrder(db, broker, userId, reserved.data, request, { decision: baseline, submission: baseline, costs: estimate });
      messages.push(`${config.symbol} buy submitted to eToro ${environment}`);
    }
  }
  return messages.join(' · ') || 'Waiting for the next market opening';
}

/** The daily-loss state of one account, environment and US session. The portfolio scan and manual orders share the row and the rule. */
export async function stockDailyLoss(db: Db, userId: string, environment: StockEnvironment, day: string, dailyLoss: number) {
  const sessionKey = { user_id: userId, environment, session_day: day };
  const sessionQuery = () => db.from('stock_portfolio_sessions').select('opening_equity, loss_locked').match(sessionKey);
  const read = await sessionQuery().maybeSingle();
  if (read.error) throw read.error;
  let baseline = read.data;
  return {
    locked: !!baseline?.loss_locked,
    /** Saves the first usable equity as the opening baseline, then locks the session once the loss reaches the limit.
     *  'unknown' means there is no opening equity to measure from. */
    async check(equity: number): Promise<'locked' | 'unknown' | null> {
      if (!baseline && equity > 0) {
        const saved = await db.from('stock_portfolio_sessions').upsert({ ...sessionKey, opening_equity: equity },
          { onConflict: 'user_id,environment,session_day', ignoreDuplicates: true });
        if (saved.error) throw saved.error;
        const reread = await sessionQuery().single();
        if (reread.error) throw reread.error;
        baseline = reread.data;
      }
      if (!baseline) return 'unknown';
      if (!baseline.loss_locked && Number(baseline.opening_equity) - equity < dailyLoss) return null;
      const saved = await db.from('stock_portfolio_sessions').update({ loss_locked: true }).match(sessionKey);
      if (saved.error) throw saved.error;
      baseline = { ...baseline, loss_locked: true };
      return 'locked';
    },
  };
}

/** Why the saved portfolio limits refuse a manual buy, or null when it may go ahead. The limits apply in the order's
 *  environment whether or not Autopilot is running. An account without valid saved portfolio settings is not limited. */
export async function manualStockLimit(db: Db, userId: string, environment: StockEnvironment, readBook: () => Promise<Book>,
  instrumentId: number, exposure: number, now: number): Promise<{ error: string; status: 409 | 422 | 503 } | null> {
  const refuse = (error: string, status: 409 | 422 | 503) => ({ error, status });
  const unavailable = 'Could not check your portfolio limits. Try again shortly.';
  const lossReached = 'Your daily equity loss limit has been reached. New buys are paused for the rest of this US session.';
  const config = await db.from('stock_autopilot').select('portfolio').eq('user_id', userId).maybeSingle();
  if (config.error) return refuse(unavailable, 503);
  const { data: settings, success } = stockPortfolioSchema.safeParse(config.data?.portfolio);
  if (!success) return null;
  const loss = await stockDailyLoss(db, userId, environment, stockMarketClock(now).day, settings.dailyLoss).catch(() => null);
  if (!loss) return refuse(unavailable, 503);
  if (loss.locked) return refuse(lossReached, 409);
  const risk = stockPortfolioRisk(await readBook());
  if (!risk) return refuse('Tideframe cannot measure your eToro exposure while the account has copy portfolios, pending orders or a position without a readable value, so it cannot check your portfolio limits. The order was not placed.', 409);
  const lossState = await loss.check(risk.equity).catch(() => 'failed' as const);
  if (lossState === 'failed') return refuse(unavailable, 503);
  if (lossState === 'unknown') return refuse('Account equity is unavailable, so your daily equity loss limit cannot be checked. The order was not placed.', 409);
  if (lossState) return refuse(lossReached, 409);
  // A manual buy could always add to a held ticker, so that alone does not refuse it.
  const block = stockPortfolioEntry(settings, risk, instrumentId, exposure, true);
  if (!block) return null;
  return refuse(block === 'Position limit reached' ? `Your portfolio limit of ${settings.maxPositions} open ${settings.maxPositions === 1 ? 'instrument' : 'instruments'} has been reached.`
    : block === 'Gross exposure limit' ? `This order would take gross exposure above your ${formatCurrency(settings.maxExposure)} portfolio limit.`
    : `This order would take exposure in one group of stocks above your ${formatCurrency(settings.maxGroup)} per-group limit.`, 422);
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
    const loss = await stockDailyLoss(db, account, environment, day, settings.dailyLoss);
    if (loss.locked) return DAILY_LOSS_NOTE;
    const riskCheck = (book: Book) => {
      const risk = stockPortfolioRisk(book);
      if (!risk || open.some(row => row.state !== 'filled' || !row.position_ids.length
          || row.protection_state === 'exit_required' || row.protection_state === 'unverified'
          || !row.position_ids.some(id => book.positions.some(position => position.id === id)))) return null;
      return risk;
    };
    const book = await broker.portfolio();
    const risk = riskCheck(book);
    if (!risk) return 'Skipped entries while exposure or eToro orders are unresolved';
    const lossState = await loss.check(risk.equity);
    if (lossState === 'unknown') return 'Skipped entries because opening account equity is unavailable';
    if (lossState) return DAILY_LOSS_NOTE;
    const inWindow = settings.strategies.filter(rule => stockEntryWindow(rule, now, true));
    if (!inWindow.length) return 'Waiting for the next scheduled strategy entry window';
    const paused = await blockedStockStrategies(db, account, environment, inWindow);
    const strategies = inWindow.filter(rule => !paused.has(rule));
    if (!strategies.length) return `Strategy guard paused new entries · ${[...paused.values()].join(' · ')}`;
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
    const scan = await scanStockSetups(broker, sizing, { symbols, rules: strategies, automatic: true, slippageBySymbol }, now);
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
    if (await loss.check(updatedRisk.equity)) return DAILY_LOSS_NOTE;
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
      submission: journalQuote(quote.bid, ask, quote.date), costs: candidate.costs, slipBps: candidate.slipBps,
      plannedNetBps: candidate.evidence.status === 'Qualified' ? candidate.evidence.netBps ?? undefined : undefined,
    });
    return `${candidate.symbol} buy submitted to eToro ${environment}`;
  } finally {
    await db.from('stock_autopilot').update({ scan_until: null }).eq('user_id', account).eq('scan_until', scanUntil);
  }
}

type UnknownEntry = Pick<AutoOrder, 'id' | 'environment' | 'connection_version' | 'state' | 'request' | 'updated_at' | 'symbol' | 'created_at' | 'broker_message'>;

/** An entry whose outcome is still unknown 15 minutes after it was sent. Only these can be released or marked as not placed. */
export function stockEntryUnresolved(row: Pick<AutoOrder, 'state' | 'updated_at'>, now: number) {
  // A 'submitted' row holds a broker order ID, so eToro received it. Only an unknown outcome can be released.
  return ['sending', 'review'].includes(row.state) && now - Date.parse(row.updated_at) >= UNRESOLVED_REFERENCE_MS;
}

/** The rule for an entry whose reference eToro answers 404 for. The scan and the manual status refresh both apply it. */
export async function settleUnreceivedStockOrder(db: Db, broker: EtoroClient, userId: string, row: UnknownEntry, connectionVersion: string, now: number,
  sharedBook?: ReturnType<EtoroClient['portfolio']>): Promise<{ outcome: 'waiting' | 'key_changed' | 'unmatched' | 'released'; message: string }> {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ updated_at: new Date().toISOString(), ...patch }).eq('user_id', userId).eq('id', row.id);
  const waiting = 'Waiting for eToro to confirm the submitted order';
  if (!stockEntryUnresolved(row, now)) return { outcome: 'waiting', message: waiting };
  if (connectionVersion !== row.connection_version) return { outcome: 'key_changed', message: 'The key changed before eToro confirmed the submitted order. Check the original eToro account.' };
  const book = await (sharedBook ?? broker.portfolio());
  const created = Date.parse(row.created_at ?? '');
  // A day of margin covers any time-zone doubt in openDateTime.
  let matches = book.positions.filter(position => position.instrumentId === row.request.instrumentId
    && position.side === 'Long' && !(brokerTime(position.opened) < created - 86_400_000));
  if (matches.length) {
    // A position another of this account's orders already tracks was opened by that order, so it cannot be this one's fill.
    const tracked = await db.from('etoro_stock_orders').select('id, position_ids').eq('user_id', userId).eq('environment', row.environment)
      .overlaps('position_ids', matches.map(position => position.id));
    if (tracked.error) throw new Error('Could not read the tracked stock positions');
    const taken = new Set(tracked.data.filter(other => other.id !== row.id).flatMap(other => (other.position_ids as number[]).map(Number)));
    matches = matches.filter(position => !taken.has(position.id));
  }
  // Pending orders carry no instrument here, so any one counts.
  const possible = book.pending > 0 || matches.length > 0;
  const name = row.symbol ? `${row.symbol} order` : 'order';
  if (possible) {
    const wayOut = 'If eToro shows it was not placed, mark it as not placed in Recent orders.';
    // The saved note makes the alert fire once. updated_at is kept so the send time stays known.
    if (row.broker_message === UNMATCHED_ORDER_NOTE) return { outcome: 'unmatched', message: `${waiting}. A position or pending order it could have opened is on the account, so it stays reserved. Check eToro. ${wayOut}` };
    const noted = await update({ broker_message: UNMATCHED_ORDER_NOTE, updated_at: row.updated_at }).eq('state', row.state).eq('updated_at', row.updated_at);
    if (noted.error) throw new Error('Could not record the unresolved stock order');
    return { outcome: 'unmatched', message: `eToro has no record of the ${name}, but the account holds a position or pending order it could have opened. The order stays reserved and needs a manual check in eToro. ${wayOut}` };
  }
  // 'rejected' is the terminal state that the reservation checks, the pending-order index and the scan all ignore.
  const released = await update({ state: 'rejected', broker_message: 'Not received by eToro. No record of the order reference 15 minutes after it was sent, and no matching position or pending order.' })
    .eq('state', row.state).eq('updated_at', row.updated_at).select('id').maybeSingle();
  if (released.error) throw new Error('Could not release the unconfirmed stock order');
  if (!released.data) return { outcome: 'waiting', message: waiting };
  return { outcome: 'released', message: `eToro has no record of the ${name} 15 minutes after it was sent, and the account holds no matching position or pending order. Marked as not received. Its reservation is released.` };
}

/** The owner's way out for an entry the rule above keeps reserved: they checked eToro and the order is not there.
 *  Assumes the owner checked the account this key belongs to. A position the order did open is no longer tracked or managed. */
export async function markStockOrderNotPlaced(db: Db, broker: EtoroClient, userId: string, row: UnknownEntry, connectionVersion: string, now: number):
  Promise<{ error: string; status: 409 | 503 } | { message: string }> {
  if (!['sending', 'review'].includes(row.state)) return { error: 'Only an order with an unknown outcome can be marked as not placed.', status: 409 };
  if (!stockEntryUnresolved(row, now)) return { error: 'Wait 15 minutes after the order was sent before marking it as not placed.', status: 409 };
  if (connectionVersion !== row.connection_version) return { error: 'The eToro key changed after this order was sent. Reconnect the original account to resolve it.', status: 409 };
  const lookup = await lookupReference(broker, row.id);
  if (lookup.orderId) return { error: 'eToro has a record of this order. Refresh its status instead.', status: 409 };
  if (!lookup.missing) return { error: 'Could not confirm that eToro has no record of this order. Try again shortly.', status: 503 };
  const saved = await db.from('etoro_stock_orders').update({ state: 'rejected', updated_at: new Date().toISOString(),
    broker_message: 'The account owner confirmed in eToro that this order was not placed. eToro had no record of the order reference.' })
    .eq('user_id', userId).eq('id', row.id).eq('state', row.state).eq('updated_at', row.updated_at).select('id').maybeSingle();
  if (saved.error) return { error: 'Could not save the change. Try again shortly.', status: 503 };
  if (!saved.data) return { error: 'This order changed while you were checking. Refresh and try again.', status: 409 };
  return { message: `${row.symbol ? `${row.symbol} order` : 'Order'} marked as not placed. The stock is free for new orders.` };
}

export async function manageStockOrder(db: Db, broker: EtoroClient, userId: string, row: AutoOrder, connectionVersion: string, previous: string, now: number,
  sharedBook?: ReturnType<EtoroClient['portfolio']>) {
  const update = (patch: object) => db.from('etoro_stock_orders').update({ updated_at: new Date().toISOString(), ...patch }).eq('user_id', userId).eq('id', row.id);
  if (row.state !== 'filled') {
    try {
      const { message, ...summary } = await reconcileStockOrder(broker, row.id, row.request);
      const saved = await update(summary).eq('state', row.state);
      if (saved.error) throw new Error('Could not reconcile stock order');
      if (summary.protection_state === 'exit_required') return 'eToro did not confirm the stop. A protective exit is required.';
      return message ?? `eToro order ${summary.state}`;
    } catch (error) {
      if (!(error instanceof EtoroError && error.status === 404)) throw error;
      return (await settleUnreceivedStockOrder(db, broker, userId, row, connectionVersion, now, sharedBook)).message;
    }
  }

  const book = await (sharedBook ?? broker.portfolio());
  const positions = book.positions.filter(position => row.position_ids.includes(position.id) && position.instrumentId === row.request.instrumentId && position.side === 'Long');
  const closeExecution = { ...row.close_execution };
  if (!positions.length) {
    if (connectionVersion !== row.connection_version) return 'The key changed and the tracked position is missing. Check the original eToro account.';
    // A newly filled order can reach order history before the portfolio feed.
    if (now - Date.parse(row.updated_at) < 10 * 60_000) return 'Waiting for the filled position to appear in the portfolio';
    const attempts = { ...row.close_attempts };
    let external = false, unconfirmed = false;
    // The first scan to find the portfolio flat starts the ceiling's clock for every exit still to confirm.
    // updated_at is kept because rows saved before sentAt existed read their send time from it.
    const wait = async (message: string) => {
      const marks = { ...row.close_attempts };
      const fresh = Object.keys(row.close_requests).filter(id => marks[id]?.state !== 'rejected' && marks[id]?.flatAt == null);
      for (const id of fresh) marks[id] = { ...(marks[id] ?? { state: 'uncertain', count: 1 }), flatAt: now };
      if (fresh.length) {
        const marked = await update({ close_attempts: marks, updated_at: row.updated_at }).eq('updated_at', row.updated_at);
        if (marked.error) throw new Error('Could not record the unconfirmed stock exit');
      }
      return message;
    };
    for (const [id, reference] of Object.entries(row.close_requests)) {
      if (attempts[id]?.state === 'rejected') continue;
      const overdue = now - (attempts[id]?.flatAt ?? now) >= FLAT_UNCONFIRMED_MS;
      const giveUp = () => {
        attempts[id] = { ...attempts[id], state: 'unconfirmed', count: attempts[id]?.count ?? 1, detail: 'eToro did not confirm this exit. Exit details may be incomplete.' };
        unconfirmed = true;
      };
      let orderId: number | undefined = closeExecution[id]?.orderId;
      if (!orderId) {
        const lookup = await lookupReference(broker, reference);
        orderId = lookup.orderId;
        if (!orderId) {
          const sent = attempts[id]?.sentAt ?? Date.parse(row.updated_at);
          if (lookup.missing && now - sent >= UNRESOLVED_REFERENCE_MS) {
            // eToro never received this request, so the position left the portfolio another way, such as a manual close.
            attempts[id] = { ...attempts[id], state: 'external', count: attempts[id]?.count ?? 1, detail: 'Closed outside Tideframe. Exit details unavailable.' };
            external = true;
          } else if (overdue) giveUp();
          else return wait('Portfolio is flat. Waiting for eToro to resolve the exit reference.');
          continue;
        }
      }
      const receipt = closeExecution[id] ?? { orderId, quote: null };
      // Past the ceiling a failing status read no longer holds the row open. The receipt keeps the order ID for the journal.
      closeExecution[id] = await readStockCloseExecution(broker, row.request.instrumentId, id, receipt).catch(async error => {
        if (overdue) return receipt;
        await wait('');
        throw error;
      });
      if (closeExecution[id].complete) attempts[id] = { state: 'filled', count: attempts[id]?.count ?? 1 };
      else if (overdue) giveUp();
      else return wait('Portfolio is flat. Waiting for eToro exit execution details.');
    }
    const note = unconfirmed ? 'The position left the portfolio and eToro did not confirm the exit within 24 hours. Closed in Tideframe with the exit details known so far.'
      : external ? 'Closed outside Tideframe. eToro has no record of the exit request, so exit details are unavailable.' : null;
    const saved = await update({ closed_at: new Date(now).toISOString(), close_execution: closeExecution, close_attempts: attempts,
      ...(note ? { broker_message: note } : {}) })
      .eq('updated_at', row.updated_at).select('id').maybeSingle();
    if (saved.error || !saved.data) throw new Error('Could not finalize stock exits');
    // The row is closed by this scan only, so each of these alerts once.
    return unconfirmed ? `Managed ${row.symbol ? `${row.symbol} ` : ''}position left the portfolio and eToro did not confirm the exit within 24 hours. Closed in Tideframe with the exit details known so far. Check the result in eToro.`
      : external ? 'Managed position closed outside Tideframe. eToro has no record of the exit request, so exit details are unavailable.' : 'Managed position closed';
  }
  // An unconfirmed stop triggers the existing exit workflow before applying the strategy's exit rules.
  if (row.protection_state !== 'exit_required' && !Object.keys(row.close_requests).length) {
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
  let quotes: ReturnType<EtoroClient['quotes']> | undefined;
  const pending = { ...row.close_requests };
  const attempts = { ...row.close_attempts };
  const messages: string[] = [];
  let version = row.updated_at;
  async function save() {
    const next = new Date(Math.max(Date.now(), Date.parse(version) + 1)).toISOString();
    const saved = await update({ close_requests: pending, close_attempts: attempts, close_execution: closeExecution,
      updated_at: next }).eq('updated_at', version).select('updated_at').maybeSingle();
    if (saved.error || !saved.data) throw new Error('Another scan is handling the exit or the exit journal is unavailable');
    version = saved.data.updated_at;
  }
  function reject(id: number, detail: string, count: number, message = `eToro declined the exit for position ${id}. ${detail}. Retry scheduled.`) {
    attempts[id] = { state: 'rejected', count, detail, retryAt: now + Math.min(30, 2 ** Math.min(count, 5)) * 60_000 };
    messages.push(message);
  }
  // A position that is back in the portfolio was not flat after all, so its ceiling clock starts again from nothing.
  const reappeared = positions.filter(position => attempts[position.id]?.flatAt != null);
  for (const { id } of reappeared) {
    attempts[id] = { ...attempts[id] };
    delete attempts[id].flatAt;
  }
  if (reappeared.length) await save();
  for (const position of positions) {
    const id = position.id;
    const previous = attempts[id];
    if (pending[id] && previous?.state !== 'rejected') {
      // An interrupted request (including a reference saved by older versions)
      // is reconciled before another close can be submitted for this position.
      let orderId: number | undefined = closeExecution[id]?.orderId;
      if (!orderId) {
        const lookup = await lookupReference(broker, pending[id]);
        orderId = lookup.orderId;
        if (!orderId && lookup.missing) {
          const sent = previous?.sentAt ?? Date.parse(row.updated_at);
          if (now - sent >= CLOSE_NOT_RECEIVED_MS) {
            // The position is still open and eToro has no record of the request, so it is retried through the usual backoff.
            // Assumes a close for a position ID that is already closing cannot open or close anything else.
            reject(id, 'No eToro record of the exit request', previous?.count ?? 1,
              `eToro has no record of the exit for position ${id} ${Math.floor((now - sent) / 60_000)} minutes after it was sent, and the position is still open. Treated as not received. A fresh exit is scheduled.`);
            await save();
          } else {
            messages.push(`Exit submission unconfirmed for position ${id}. eToro has no record of it yet. A fresh exit is scheduled if that still holds 3 minutes after it was sent.`);
          }
          continue;
        }
      }
      // The lookup itself failed, so the outcome is unknown and no second close is sent.
      if (!orderId) { messages.push(`Exit submission unconfirmed for position ${id}. Check eToro; reconciliation continues.`); continue; }
      const status = await broker.stockCloseStatus(orderId).catch(() => null);
      if (!status || status.orderID !== orderId || status.instrumentID !== row.request.instrumentId ||
          (status.positions?.length && !status.positions.some(item => item.positionID === id))) {
        messages.push(`Exit submission unconfirmed for position ${id}. Waiting for broker status.`); continue;
      }
      closeExecution[id] ??= { orderId, quote: null };
      if ([9, 10].includes(status.statusID)) {
        // Preserve partial fills separately, since a retry receives a different broker order ID.
        const partial = await readStockCloseExecution(broker, row.request.instrumentId, String(id), closeExecution[id]);
        if (!partial.complete) { messages.push('Waiting for partial exit execution details.'); continue; }
        closeExecution[`${id}:${orderId}`] = partial;
        delete closeExecution[id];
      }
      if ([4, 7, 8, 9, 10].includes(status.statusID)) {
        reject(id, `Broker status ${status.statusID}`, previous?.count ?? 1);
      } else {
        const filled = status.statusID === 3;
        attempts[id] = { state: filled ? 'filled' : 'submitted', count: previous?.count ?? 1 };
        messages.push(filled ? 'Exit filled. Waiting for portfolio confirmation.' : 'Exit submitted. Waiting for eToro execution.');
      }
      if (!previous || previous.state !== attempts[id].state || !row.close_execution?.[id]) await save();
      continue;
    }
    if (previous?.retryAt && previous.retryAt > now) {
      messages.push(`Exit retry scheduled for ${new Date(previous.retryAt).toISOString()}.`); continue;
    }
    quotes ??= broker.quotes([row.request.instrumentId]);
    const quote = (await quotes).find(item => item.instrumentId === row.request.instrumentId);
    if (!freshStockAsk(quote, Date.now())) { messages.push('Waiting for a real-time quote to send the exit'); continue; }
    const reference = randomUUID();
    const count = (previous?.count ?? 0) + 1;
    const sentAt = Date.now();
    pending[id] = reference;
    attempts[id] = { state: 'uncertain', count, sentAt };
    delete closeExecution[id];
    await save();
    try {
      const receipt = await broker.closeStock(id, row.request.instrumentId, reference);
      const orderId = receipt.orderForClose?.orderID;
      if (orderId && Number.isSafeInteger(orderId)) {
        closeExecution[id] = { orderId, quote: journalQuote(quote!.bid!, quote!.ask!, quote!.date) };
        attempts[id] = { state: 'submitted', count, sentAt };
        messages.push('Exit submitted. Waiting for eToro execution.');
      } else messages.push('Exit submission unconfirmed. Checking eToro.');
    } catch (error) {
      if (error instanceof EtoroError && [400, 401, 403, 404, 422, 429].includes(error.status))
        reject(id, `HTTP ${error.status}`, count);
      else messages.push('Exit submission unconfirmed. Checking eToro before retrying.');
    }
    await save();
  }
  return [...new Set(messages)].join(' · ');
}
