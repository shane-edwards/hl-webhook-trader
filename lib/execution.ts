import { accountResource, withTradingLock } from '@/lib/trading-lock';
// Order execution shared by the webhook, the manual trade ticket and the kill
// switch, so every entry point records trades and manages stops the same way.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closeOpenTrades } from '@/lib/trade-records';
import { buildExitLegs, isManaged, type ExitOptions } from '@/lib/exits';
import { assertWithinPortfolioLimits, DEFAULT_PORTFOLIO_LIMITS, type PortfolioLimits } from '@/lib/risk/portfolio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const MAX_LEVERAGE = 50;

/** A percentage distance for a stop or target, or null when not set / invalid. */
export function protectionPercent(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0.05 && n <= 50 ? n : null;
}

/** Stop-loss and take-profit trigger prices for a position entered at `entryPrice`. */
export function protectionPrices(side: 'long' | 'short', entryPrice: number, stopLossPct: number | null, takeProfitPct: number | null) {
  const dir = side === 'long' ? 1 : -1;
  return {
    stopLossPx: stopLossPct != null ? entryPrice * (1 - (dir * stopLossPct) / 100) : undefined,
    takeProfitPx: takeProfitPct != null ? entryPrice * (1 + (dir * takeProfitPct) / 100) : undefined,
  };
}

/**
 * The stop a manual entry goes out with. In order: the stop on the ticket; a trailing stop (market
 * entries only: a resting limit or chase entry cannot carry one); the default stop-loss from Settings.
 * With none of the three the entry is refused: `error` says why and nothing may be sent.
 */
export function manualStopLoss(o: {
  stopLossPct: number | null;
  trailPct: number | null;
  /** True for a limit or chase entry, which takes a fixed stop only. */
  resting: boolean;
  /** `default_stop_loss_percent` from the user's settings, as stored. */
  defaultStopLossPct: unknown;
}): { stopLossPct: number | null; fromDefault: boolean; error: string | null } {
  if (o.stopLossPct != null) return { stopLossPct: o.stopLossPct, fromDefault: false, error: null };
  // The trailing stop itself is the stop: it starts one trail-distance from entry.
  if (!o.resting && o.trailPct != null) return { stopLossPct: null, fromDefault: false, error: null };
  const fallback = protectionPercent(o.defaultStopLossPct);
  if (fallback != null) return { stopLossPct: fallback, fromDefault: true, error: null };
  return {
    stopLossPct: null, fromDefault: false,
    error: `A manual trade needs a stop-loss. Enter one${o.resting ? '' : ' (or a trailing stop)'}, or save a default stop-loss in Settings.`,
  };
}

export interface OpenParams {
  userId: string;
  symbol: string;
  side: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  slippagePercent: number;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  source: 'webhook' | 'manual' | 'autopilot';
  payload?: Record<string, unknown> | null;
  /** Split target, break-even and trailing options. Omit for a plain stop and target. */
  exit?: ExitOptions | null;
  /** Account-wide limits; the defaults apply when omitted, so no entry path skips them. */
  limits?: PortfolioLimits;
  /** Send the order as this many equal market orders a few seconds apart (1-5). Each must be at least $10. */
  slices?: number;
  /** Pause between slices in milliseconds (tests shorten it). */
  slicePauseMs?: number;
  /**
   * When a stop was asked for and cannot be placed or cannot be seen resting afterwards, close the position
   * at once rather than leave it open with no stop. On for manual and webhook entries.
   */
  closeIfUnprotected?: boolean;
}

export const MAX_SLICES = 5;
/** Pause between slices: long enough for the book to refill, short enough to finish inside one request. */
export const SLICE_PAUSE_MS = 2_000;

/** Entry cost against the price when the order was sent, in basis points. Positive = paid more than the mid. */
export function slippageBps(side: 'long' | 'short', decisionPrice: number, fillPrice: number): number {
  return ((side === 'long' ? fillPrice - decisionPrice : decisionPrice - fillPrice) / decisionPrice) * 1e4;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TradeInsert = Record<string, any>;

/**
 * Inserts a trade row. The execution columns arrive with migration 007; if they are not there yet the
 * row is written without them rather than lost.
 */
export async function insertTrade(db: Db, row: TradeInsert): Promise<{ id: string }> {
  if (row.hyperliquid_order_id) {
    const existing = await db.from('trades').select('id').eq('user_id', row.user_id).eq('hyperliquid_order_id', row.hyperliquid_order_id).limit(1).maybeSingle();
    if (existing.error) throw new Error(existing.error.message);
    if (existing.data) return existing.data;
    row = { ...row, execution_key: row.hyperliquid_order_id };
  }
  const first = await db.from('trades').insert(row).select('id').single();
  if (!first.error) return first.data;
  const rest: TradeInsert = { ...row };
  delete rest.decision_price; delete rest.slippage_bps; delete rest.order_type;
  if (Object.keys(rest).length === Object.keys(row).length) throw new Error(first.error.message);
  const second = await db.from('trades').insert(rest).select('id').single();
  if (second.error) throw new Error(second.error.message);
  return second.data;
}

export interface OpenResult {
  tradeId: string;
  orderId: string;
  fillPrice: number;
  size: number;
  stopLossPx: number | null;
  takeProfitPx: number | null;
  /** Set when the position opened but its stop/target could not be placed. The position is UNPROTECTED. */
  protectionError: string | null;
  /** Set when the orders were placed but something about the exit plan was reduced (e.g. too small to split). */
  exitWarning: string | null;
  /** Entry cost against the mid price when the order was sent, in basis points. */
  slippageBps: number;
  /** True when the stop could not be placed and the position was therefore closed again at once. */
  closedUnprotected: boolean;
}

/** True when a query failed only because its table has not been created yet (Postgres 42P01, PostgREST PGRST205). */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' || /Could not find the table|relation .* does not exist/i.test(error.message ?? ''));
}

/**
 * Writes down what a manual market entry is about to send, before the order goes out. A request can die
 * between the fill and the trade record (a timeout, a crash, a deploy); the row is what lets the scan find
 * that position, record it and put its stop on (lib/entry-recovery.ts). Returns null when the table is not
 * there yet (it arrives with migration 024): the entry then goes out as it always has. Any other failure
 * refuses the entry, with nothing sent.
 */
async function beginEntryIntent(hl: HyperliquidClient, db: Db, p: OpenParams): Promise<string | null> {
  const { data, error } = await db.from('entry_intents').insert({
    user_id: p.userId, account_resource: accountResource(hl, p.userId), symbol: p.symbol, side: p.side,
    size_usd: p.sizeUsd, leverage: p.leverage, stop_loss_pct: p.stopLossPct, take_profit_pct: p.takeProfitPct,
    exit: p.exit ?? null, payload: p.payload ?? null, slippage_percent: p.slippagePercent, status: 'sending',
  }).select('id').single();
  if (!error) return data.id;
  if (isMissingTable(error)) return null;
  throw new Error(`The order could not be written down before sending, so nothing was sent: ${error.message}`);
}

/** Closes an intent. Best effort: one left as 'sending' is only looked at again by the scan, which is safe. */
export async function finishEntryIntent(db: Db, id: string | null, status: 'done' | 'failed' | 'recovered', detail: string | null = null): Promise<void> {
  if (!id) return;
  try {
    await db.from('entry_intents').update({ status, detail: detail ? detail.slice(0, 1000) : null, updated_at: new Date().toISOString() }).eq('id', id).eq('status', 'sending');
  } catch { /* see above */ }
}

export async function openPosition(hl: HyperliquidClient, db: Db, p: OpenParams): Promise<OpenResult> {
  return withTradingLock(hl, db, p.userId, () => openPositionLocked(hl, db, p));
}

async function openPositionLocked(hl: HyperliquidClient, db: Db, p: OpenParams): Promise<OpenResult> {
  // Every entry, whatever sent it, passes the account-wide limits first.
  await assertWithinPortfolioLimits(hl, db, p.userId, p.sizeUsd, p.limits ?? DEFAULT_PORTFOLIO_LIMITS);

  // Webhook and Autopilot entries have their own recovery (the job queue, the reserved position row).
  const intent = p.source === 'manual' ? await beginEntryIntent(hl, db, p) : null;
  const slices = Math.min(MAX_SLICES, Math.max(1, Math.floor(p.slices ?? 1)));
  let fill: Awaited<ReturnType<HyperliquidClient['placeMarketOrder']>>;
  try {
    fill = await hl.placeMarketOrder({
      coin: p.symbol, isBuy: p.side === 'long', sizeUsd: p.sizeUsd / slices, leverage: p.leverage, reduceOnly: false, slippagePercent: p.slippagePercent,
    });
  } catch (err) {
    // Nothing filled, or the outcome was unknown and the client has already closed any fill and halted the account.
    await finishEntryIntent(db, intent, 'failed', `The order did not go through: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
  // The whole order is measured against the price when the first slice was sent.
  const decisionPrice = fill.decisionPrice ?? fill.fillPrice;
  let sliceNote: string | null = null;
  for (let k = 1; k < slices; k++) {
    await new Promise(r => setTimeout(r, p.slicePauseMs ?? SLICE_PAUSE_MS));
    try {
      const next = await hl.placeMarketOrder({
        coin: p.symbol, isBuy: p.side === 'long', sizeUsd: p.sizeUsd / slices, leverage: p.leverage, reduceOnly: false, slippagePercent: p.slippagePercent,
      });
      const size = fill.sizeInContracts + next.sizeInContracts;
      fill = { ...fill, fillPrice: (fill.fillPrice * fill.sizeInContracts + next.fillPrice * next.sizeInContracts) / size, sizeInContracts: size };
    } catch (err) {
      // Keep what filled: the position is real and still gets its record and its stop.
      sliceNote = `Only ${k} of ${slices} slices filled (${err instanceof Error ? err.message : err})`;
      break;
    }
  }

  const now = new Date().toISOString();
  let trade: { id: string };
  try {
    trade = await insertTrade(db, {
      user_id: p.userId, symbol: p.symbol, side: p.side, status: 'open',
      entry_price: fill.fillPrice, size: fill.sizeInContracts, size_usd: fill.sizeInContracts * fill.fillPrice,
      leverage: p.leverage, entry_time: now, signal_source: p.source, webhook_payload: p.payload ?? null,
      hyperliquid_order_id: fill.orderId, created_at: now, updated_at: now,
      decision_price: decisionPrice, slippage_bps: slippageBps(p.side, decisionPrice, fill.fillPrice), order_type: slices > 1 ? 'sliced' : 'market',
    });
  } catch (err) {
    let recovery: string;
    try {
      const closed = await hl.closePosition(p.symbol, p.slippagePercent);
      if (!closed.fullyClosed || await hl.getPosition(p.symbol)) throw new Error('a position remains open');
      recovery = 'The position was closed immediately';
      await finishEntryIntent(db, intent, 'failed', `Filled but could not be recorded (${err instanceof Error ? err.message : err}). The position was closed immediately`);
    } catch (closeError) {
      // The position is still open and has no record. The intent is left as 'sending' on purpose: the scan
      // writes the missing record from the exchange fills and puts the entry's own stop on.
      // Try to protect the actual remaining size even when the journal is down.
      try {
        const remaining = await hl.getPosition(p.symbol);
        if (remaining) await hl.placeProtectiveOrders({ coin: p.symbol, side: remaining.side, size: remaining.size,
          ...protectionPrices(remaining.side, remaining.entryPrice, p.stopLossPct ?? 2, null) });
        recovery = 'Emergency protection was placed. Check the account before retrying';
      } catch {
        // Neither closed nor stopped: hand the account to the kill-switch recovery, which retries on every scan.
        const flagged = await requestAccountFlatten(hl, db, p.userId);
        recovery = `Emergency recovery failed (${closeError instanceof Error ? closeError.message : closeError}). ${flagged ? 'Trading is halted and the next scan will retry closing every position. ' : ''}Check the exchange immediately`;
      }
    }
    throw new Error(`Order ${fill.orderId} filled but could not be recorded: ${err instanceof Error ? err.message : err}. ${recovery}`);
  }

  const protection = await protectAfterFill(hl, db, p, sliceNote);
  // Recorded, and stopped or closed (or handed to the account flatten): nothing is left for the scan to finish.
  await finishEntryIntent(db, intent, 'done');
  return {
    tradeId: trade.id, orderId: fill.orderId, fillPrice: fill.fillPrice, size: fill.sizeInContracts,
    slippageBps: slippageBps(p.side, decisionPrice, fill.fillPrice), ...protection,
  };
}

/** What an entry asks for once it has filled: its stop, targets and managed exits. */
export type ProtectParams = Pick<OpenParams, 'userId' | 'symbol' | 'side' | 'slippagePercent' | 'stopLossPct' | 'takeProfitPct' | 'exit' | 'closeIfUnprotected'>;
export type Protection = Pick<OpenResult, 'stopLossPx' | 'takeProfitPx' | 'protectionError' | 'exitWarning' | 'closedUnprotected'>;

/**
 * Puts an entry's stop and targets on the whole position once it has filled, looks for the stop actually
 * resting, and closes the position when a stop that was asked for is not there. One path for a normal entry
 * and for the scan finishing an interrupted one (lib/entry-recovery.ts). Problems come back in the result.
 */
export async function protectAfterFill(hl: HyperliquidClient, db: Db, p: ProtectParams, sliceNote: string | null = null): Promise<Protection> {
  const result: Protection = { stopLossPx: null, takeProfitPx: null, protectionError: null, exitWarning: sliceNote, closedUnprotected: false };
  const now = new Date().toISOString();

  const managed = isManaged(p.exit, p.takeProfitPct != null);
  const wantsOrders = p.stopLossPct != null || p.takeProfitPct != null || managed;
  // Does this entry bring a stop of its own? (A trailing stop starts one trail-distance from entry.)
  const suppliesStop = p.stopLossPct != null || (managed && p.exit?.trailPct != null && p.exit.trailPct > 0);
  // An entry must never reduce existing protection. When it brings no stop and an earlier stop is
  // resting, that stop's trigger price is kept and re-placed for the whole (now larger) position.
  let keptStopPx: number | null = null;
  try {
    // Protect the whole position (it may include earlier entries), from its average entry.
    const position = await hl.getPosition(p.symbol);
    if (!position && wantsOrders) throw new Error('position not found after fill');
    const older = position ? (await hl.getOpenOrders(p.symbol)).filter(o => o.isTrigger && o.reduceOnly) : [];
    const isStop = (o: { orderType: string }) => /stop/i.test(o.orderType);
    if (position && !suppliesStop) {
      const dir = position.side === 'long' ? 1 : -1;
      // Only a stop that really protects this position: on the closing side and not yet reached by the price.
      const earlier = older.filter(o => isStop(o) && o.side === (dir === 1 ? 'sell' : 'buy') && o.triggerPx > 0 && dir * (position.markPrice - o.triggerPx) > 0).map(o => o.triggerPx);
      // With more than one, keep the tightest.
      if (earlier.length) keptStopPx = dir === 1 ? Math.max(...earlier) : Math.min(...earlier);
    }
    if (position && (wantsOrders || keptStopPx != null)) {
      let newStopOid: string | null = null;
      if (managed) {
        const { meta } = await hl.getAsset(p.symbol);
        const { legs, plan, warning } = buildExitLegs({
          side: p.side, entryPrice: position.entryPrice, size: position.size, szDecimals: meta.szDecimals,
          stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct, exit: p.exit!,
        });
        // The kept stop goes first, like any stop leg, and into the plan so the scan looks after it.
        if (keptStopPx != null) { legs.unshift({ kind: 'sl', triggerPx: keptStopPx, size: position.size }); plan.stop_px = keptStopPx; }
        const oids = await hl.placeTriggerOrders({ coin: p.symbol, side: p.side, legs, grouping: 'na' });
        result.stopLossPx = plan.stop_px;
        newStopOid = plan.stop_px != null ? oids[0] : null;
        result.takeProfitPx = plan.tp1_px;
        result.exitWarning = [sliceNote, warning].filter(Boolean).join('. ') || null;
        // The plan row is what lets the scan move the stop later. The orders above already rest on the exchange.
        await db.from('position_plans').update({ status: 'done', updated_at: now }).eq('user_id', p.userId).eq('symbol', p.symbol).eq('status', 'active');
        const { error: planError } = await db.from('position_plans').insert({
          user_id: p.userId, symbol: p.symbol, status: 'active', tp1_done: false, ...plan, stop_oid: plan.stop_px != null ? oids[0] : null,
        });
        if (planError && (plan.breakeven_after_tp1 || plan.trail_pct != null)) {
          result.exitWarning = `Stop and targets are placed, but the stop will NOT move automatically: the exit plan could not be saved (${planError.message}). Has migration 006 been run?`;
        }
      } else {
        const prices = protectionPrices(p.side, position.entryPrice, p.stopLossPct, p.takeProfitPct);
        const stopLossPx = prices.stopLossPx ?? keptStopPx ?? undefined;
        const protection = await hl.placeProtectiveOrders({ coin: p.symbol, side: p.side, size: position.size, stopLossPx, takeProfitPx: prices.takeProfitPx });
        newStopOid = protection.stopLossOid;
        result.stopLossPx = stopLossPx ?? null;
        result.takeProfitPx = prices.takeProfitPx ?? null;
      }
      // Do not take the exchange's word for it: look for the stop actually resting.
      if (result.stopLossPx != null) {
        const resting = await hl.getOpenOrders(p.symbol);
        if (!newStopOid || !resting.some(o => String(o.oid) === newStopOid && o.isTrigger && o.reduceOnly && isStop(o) && o.size >= position.size * 0.999)) throw new Error('the stop-loss was accepted but is not resting on the exchange at the required size');
      }
      // Only what was replaced is cancelled, and only now: older stops once the new stop is seen resting,
      // older targets once new targets exist. Anything else stays where it is.
      await hl.cancelOrders(p.symbol, older.filter(o => (isStop(o) ? result.stopLossPx != null : result.takeProfitPx != null)).map(o => o.oid));
      if (keptStopPx != null) {
        result.exitWarning = [result.exitWarning, `No new stop was given: the existing stop at ${keptStopPx} was kept and now covers the whole position`].filter(Boolean).join('. ');
      }
    }
  } catch (err) {
    result.protectionError = err instanceof Error ? err.message : 'Unknown error';
  }
  // A stop was asked for (or an earlier one had to be kept) and is not there: an open position with no stop
  // is the one state not allowed to persist.
  const wantedStop = p.stopLossPct != null || (managed && p.exit?.trailPct != null) || keptStopPx != null;
  if (result.protectionError && wantedStop && p.closeIfUnprotected) {
    try {
      await closePositionFully(hl, db, p.userId, p.symbol, p.slippagePercent, `Closed at once: the stop-loss could not be placed (${result.protectionError})`);
      result.closedUnprotected = true;
    } catch (err) {
      // Neither stopped nor closed: hand the account to the kill-switch recovery, which retries on every scan.
      const flagged = await requestAccountFlatten(hl, db, p.userId);
      result.protectionError += `. It could NOT be closed either (${err instanceof Error ? err.message : err}): close it by hand now. `
        + (flagged ? 'Trading is halted and the next scan will retry closing every position' : 'The account halt could NOT be saved either');
    }
  }
  return result;
}

/**
 * Asks for the kill-switch recovery, for a position that is open with no stop and could not be closed:
 * new entries are refused, and the next scan cancels entry orders and closes every position, retrying
 * until the account is verified flat. Returns false when the request itself could not be saved.
 */
export async function requestAccountFlatten(hl: HyperliquidClient, db: Db, userId: string): Promise<boolean> {
  try {
    const halted = await db.rpc('halt_trading_account', { resource_key: accountResource(hl, userId) });
    const flagged = await db.from('settings').update({ trading_halted: true, flatten_pending: true }).eq('user_id', userId);
    return !halted.error && !flagged.error;
  } catch {
    return false;
  }
}

export interface CloseResult { fillPrice: number; size: number; tradeIds: string[] }

/** Closes the whole position, settles its trade records and clears leftover stop orders. */
export async function closePositionFully(hl: HyperliquidClient, db: Db, userId: string, symbol: string, slippagePercent: number, notes?: string): Promise<CloseResult> {
  return withTradingLock(hl, db, userId, () => closePositionFullyLocked(hl, db, userId, symbol, slippagePercent, notes));
}

async function closePositionFullyLocked(hl: HyperliquidClient, db: Db, userId: string, symbol: string, slippagePercent: number, notes?: string): Promise<CloseResult> {
  const closed = await hl.closePosition(symbol, slippagePercent);
  if (!closed.fullyClosed || await hl.getPosition(symbol)) {
    throw new Error(`Only ${closed.filledSize} ${symbol} closed; the rest is still open on the exchange`);
  }
  const tradeIds = await closeOpenTrades(db, userId, symbol, closed.fillPrice, notes);
  // Stops normally cancel themselves when the position closes; make sure none linger.
  await hl.cancelProtectiveOrders(symbol).catch(() => {});
  await db.from('position_plans').update({ status: 'done', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('symbol', symbol).eq('status', 'active').then(() => {}, () => {});
  return { fillPrice: closed.fillPrice, size: closed.filledSize, tradeIds };
}
