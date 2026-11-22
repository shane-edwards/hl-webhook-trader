// Limit-order entries: a post-only order resting at a chosen price (for
// example "buy at support"), paying the maker fee instead of the taker fee.
//
// Two rules hold whatever happens:
//   1. An entry that never fills never leaves a stop behind.
//   2. An entry that fills always gets its stop.
// The stop and target are sent as children of the entry, so the exchange
// itself activates them on a fill and cancels them with the entry. The scan
// then checks both rules again on every pass, in case the exchange did not.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { protectionPrices } from '@/lib/execution';
import { assertWithinPortfolioLimits, type PortfolioLimits } from '@/lib/risk/portfolio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const MAX_EXPIRY_HOURS = 24 * 7;

export interface LimitEntryParams {
  userId: string; symbol: string; side: 'long' | 'short';
  limitPx: number; sizeUsd: number; leverage: number;
  stopLossPct: number | null; takeProfitPct: number | null;
  expiryHours: number;
  journal?: object | null;
  limits: PortfolioLimits;
}

export async function placeLimitEntry(hl: HyperliquidClient, db: Db, p: LimitEntryParams) {
  const mark = await hl.getMarkPrice(p.symbol);
  // A post-only order must rest: a buy has to sit below the market, a sell above it.
  if (p.side === 'long' ? p.limitPx >= mark : p.limitPx <= mark) {
    throw new Error(`A limit ${p.side === 'long' ? 'buy must be below' : 'sell must be above'} the current price (${mark}). Use a market order to enter now.`);
  }
  await assertWithinPortfolioLimits(hl, db, p.userId, p.sizeUsd, p.limits);

  const prices = protectionPrices(p.side, p.limitPx, p.stopLossPct, p.takeProfitPct);
  const order = await hl.placeLimitEntry({
    coin: p.symbol, isBuy: p.side === 'long', size: p.sizeUsd / p.limitPx, price: p.limitPx, leverage: p.leverage, ...prices,
  });

  const { data, error } = await db.from('pending_orders').insert({
    user_id: p.userId, symbol: p.symbol, side: p.side, limit_px: order.price, size: order.size,
    size_usd: order.size * order.price, leverage: p.leverage, stop_loss_pct: p.stopLossPct, take_profit_pct: p.takeProfitPct,
    oid: order.oid, status: 'resting', journal: p.journal ?? null,
    expires_at: new Date(Date.now() + p.expiryHours * 3_600_000).toISOString(),
  }).select('*').single();
  if (error) {
    // Without a record the scan could not look after the order, so do not leave it resting.
    await hl.cancelOrders(p.symbol, [order.oid]).catch(() => {});
    throw new Error(`Limit order cancelled because it could not be recorded (${error.message}). Has migration 006 been run?`);
  }
  return data;
}

export interface PendingEvent { symbol: string; level: 'info' | 'trade' | 'error'; message: string }

interface PendingRow {
  id: string; symbol: string; side: 'long' | 'short'; limit_px: number; size: number; leverage: number;
  stop_loss_pct: number | null; take_profit_pct: number | null; oid: string; expires_at: string;
  journal: Record<string, unknown> | null; created_at: string;
}

/** Statuses the exchange uses for an order that is finished without (fully) filling. */
const isDead = (status: string) => /cancel|reject|expired/i.test(status);

/** One pass over a user's resting limit entries. Never throws; problems come back as events. */
export interface PendingOptions { /** Worst-price guard for a chase's market fallback, percent. */ slippagePercent?: number }

export async function managePending(hl: HyperliquidClient, db: Db, userId: string, now = Date.now(), opts: PendingOptions = {}): Promise<PendingEvent[]> {
  const events: PendingEvent[] = [];
  const { data: rows, error } = await db.from('pending_orders').select('*').eq('user_id', userId).eq('status', 'resting');
  if (error || !rows?.length) return events;

  for (const raw of rows) {
    const row: PendingRow = { ...raw, limit_px: +raw.limit_px, size: +raw.size, leverage: +raw.leverage,
      stop_loss_pct: raw.stop_loss_pct == null ? null : +raw.stop_loss_pct, take_profit_pct: raw.take_profit_pct == null ? null : +raw.take_profit_pct };
    const stamp = new Date(now).toISOString();
    try {
      let st = await hl.getOrderStatus(row.oid);
      if (!st) { events.push({ symbol: row.symbol, level: 'error', message: `Limit order ${row.oid} on ${row.symbol} is unknown to the exchange` }); continue; }

      const expired = now >= new Date(row.expires_at).getTime();
      if (st.status === 'open' && expired) {
        await hl.cancelOrders(row.symbol, [row.oid]);
        st = (await hl.getOrderStatus(row.oid)) ?? { ...st, status: 'canceled' };
      }

      const filled = st.filledSize;
      const finished = st.status === 'filled' || isDead(st.status);

      // Rule 2: whatever has filled must be protected, even while the rest is still resting.
      if (filled > 0 && (row.stop_loss_pct != null || row.take_profit_pct != null)) {
        const position = await hl.getPosition(row.symbol);
        if (position && position.side === row.side) {
          const orders = await hl.getOpenOrders(row.symbol);
          const hasStop = orders.some(o => o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType));
          const hasTarget = orders.some(o => o.isTrigger && o.reduceOnly && /profit/i.test(o.orderType));
          const prices = protectionPrices(row.side, row.limit_px, row.stop_loss_pct, row.take_profit_pct);
          const missing = {
            stopLossPx: row.stop_loss_pct != null && !hasStop ? prices.stopLossPx : undefined,
            takeProfitPx: row.take_profit_pct != null && !hasTarget ? prices.takeProfitPx : undefined,
          };
          if (missing.stopLossPx != null || missing.takeProfitPx != null) {
            await hl.placeProtectiveOrders({ coin: row.symbol, side: row.side, size: position.size, ...missing });
            events.push({ symbol: row.symbol, level: 'info', message: `${row.symbol}: stop/target placed for the filled limit entry` });
          }
        }
      }
      if (!finished) continue;

      // Rule 1: nothing filled and the entry is gone, so no stop of its may remain.
      if (filled === 0) {
        if (!(await hl.getPosition(row.symbol))) await hl.cancelProtectiveOrders(row.symbol);
        const status = expired ? 'expired' : 'cancelled';
        await db.from('pending_orders').update({ status, updated_at: stamp, note: expired ? 'Not filled before it expired' : `Ended on the exchange: ${st.status}` }).eq('id', row.id);
        events.push({ symbol: row.symbol, level: 'info', message: `Limit ${row.side} on ${row.symbol} at ${row.limit_px} ${expired ? 'expired unfilled' : `was cancelled (${st.status})`}` });
        continue;
      }

      // Filled (fully, or partly before it was cancelled): record the trade.
      const { data: trade, error: tradeError } = await db.from('trades').insert({
        user_id: userId, symbol: row.symbol, side: row.side, status: 'open',
        entry_price: row.limit_px, size: filled, size_usd: filled * row.limit_px, leverage: row.leverage,
        entry_time: stamp, signal_source: 'manual', hyperliquid_order_id: row.oid,
        webhook_payload: { order_type: 'limit', ...(row.journal ? { journal: row.journal } : {}) },
        created_at: stamp, updated_at: stamp,
      }).select('id').single();
      if (tradeError) throw new Error(`filled but could not be recorded: ${tradeError.message}`);
      const partial = filled < st.originalSize * 0.999;
      await db.from('pending_orders').update({
        status: 'filled', filled_size: filled, trade_id: trade.id, updated_at: stamp,
        note: partial ? `Partly filled (${filled} of ${st.originalSize}) before it ended` : null,
      }).eq('id', row.id);
      events.push({ symbol: row.symbol, level: 'trade', message: `Limit ${row.side} filled: ${filled} ${row.symbol} at ${row.limit_px}${partial ? ' (partial)' : ''}` });
    } catch (err) {
      events.push({ symbol: row.symbol, level: 'error', message: `Limit order on ${row.symbol}: ${err instanceof Error ? err.message : err}` });
    }
  }
  return events;
}

/** Cancels a resting entry at the user's request. Anything that already filled stays open (and protected). */
export async function cancelLimitEntry(hl: HyperliquidClient, db: Db, userId: string, id: string): Promise<PendingEvent[]> {
  const { data: row } = await db.from('pending_orders').select('*').eq('user_id', userId).eq('id', id).eq('status', 'resting').maybeSingle();
  if (!row) throw new Error('Order not found or no longer resting');
  await hl.cancelOrders(row.symbol, [row.oid]).catch(() => {}); // already gone is fine: the pass below settles it
  return managePending(hl, db, userId);
}
