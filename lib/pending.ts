// Resting entries: post-only orders that pay the maker fee (0.015%) instead of
// the taker fee (0.045%).
//
//   limit  rests at a price you choose (for example "buy at support") until it
//          fills or expires.
//   chase  rests at the best bid (to buy) or best ask (to sell), is moved when
//          the market moves away, and after a set time takes whatever is left
//          at market. It gets you in now-ish, usually at the maker fee.
//
// Two rules hold whatever happens:
//   1. An entry that never fills never leaves a stop behind.
//   2. An entry that fills always gets its stop.
// The stop and target are sent as children of the entry, so the exchange
// itself activates them on a fill and cancels them with the entry. The scan
// then checks both rules again on every pass, in case the exchange did not.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { MIN_ORDER_USD } from '@/lib/hyperliquid/client';
import { insertTrade, protectionPrices, slippageBps } from '@/lib/execution';
import { assertWithinPortfolioLimits, type PortfolioLimits } from '@/lib/risk/portfolio';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export const MAX_EXPIRY_HOURS = 24 * 7;
export const CHASE_SECONDS = [30, 60, 120, 300];

export interface LimitEntryParams {
  userId: string; symbol: string; side: 'long' | 'short';
  /** Price to rest at. Ignored for a chase, which starts at the best bid or ask. */
  limitPx: number | null; sizeUsd: number; leverage: number;
  stopLossPct: number | null; takeProfitPct: number | null;
  expiryHours: number;
  /** Set for a chase: seconds to keep resting before taking the remainder at market. */
  chaseSeconds?: number | null;
  journal?: object | null;
  limits: PortfolioLimits;
}

export async function placeLimitEntry(hl: HyperliquidClient, db: Db, p: LimitEntryParams) {
  const chase = p.chaseSeconds != null;
  const [mark, book] = await Promise.all([hl.getMarkPrice(p.symbol), chase ? hl.getBook(p.symbol) : null]);
  const best = book ? (p.side === 'long' ? book.bids[0]?.px : book.asks[0]?.px) : null;
  if (chase && !(best! > 0)) throw new Error(`No ${p.side === 'long' ? 'bid' : 'ask'} in the ${p.symbol} order book to rest at`);
  const price = chase ? best! : p.limitPx!;
  // A post-only order must rest: a buy has to sit below the market, a sell above it.
  if (!chase && (p.side === 'long' ? price >= mark : price <= mark)) {
    throw new Error(`A limit ${p.side === 'long' ? 'buy must be below' : 'sell must be above'} the current price (${mark}). Use a market or chase order to enter now.`);
  }
  await assertWithinPortfolioLimits(hl, db, p.userId, p.sizeUsd, p.limits);

  const prices = protectionPrices(p.side, price, p.stopLossPct, p.takeProfitPct);
  const order = await hl.placeLimitEntry({ coin: p.symbol, isBuy: p.side === 'long', size: p.sizeUsd / price, price, leverage: p.leverage, ...prices });

  const now = Date.now();
  const base: Record<string, unknown> = {
    user_id: p.userId, symbol: p.symbol, side: p.side, limit_px: order.price, size: order.size,
    size_usd: order.size * order.price, leverage: p.leverage, stop_loss_pct: p.stopLossPct, take_profit_pct: p.takeProfitPct,
    oid: order.oid, status: 'resting', journal: p.journal ?? null,
    expires_at: new Date(now + (chase ? p.chaseSeconds! * 1000 + 600_000 : p.expiryHours * 3_600_000)).toISOString(),
  };
  const { data, error } = await db.from('pending_orders').insert(chase
    ? { ...base, mode: 'chase', chase_until: new Date(now + p.chaseSeconds! * 1000).toISOString(), prior_filled_size: 0, prior_filled_notional: 0, decision_price: mark }
    : base).select('*').single();
  if (error) {
    // Without a record the scan could not look after the order, so do not leave it resting.
    await hl.cancelOrders(p.symbol, [order.oid]).catch(() => {});
    throw new Error(`Order cancelled because it could not be recorded (${error.message}). Has migration ${chase ? '007' : '006'} been run?`);
  }
  return data;
}

export interface PendingEvent { symbol: string; level: 'info' | 'trade' | 'error'; message: string }
export interface PendingOptions { /** Worst-price guard for a chase's market fallback, percent. */ slippagePercent?: number }

interface PendingRow {
  id: string; symbol: string; side: 'long' | 'short'; limit_px: number; size: number; leverage: number;
  stop_loss_pct: number | null; take_profit_pct: number | null; oid: string; expires_at: string;
  journal: Record<string, unknown> | null; created_at: string;
  mode: 'limit' | 'chase'; chase_until: string | null; prior_filled_size: number; prior_filled_notional: number; decision_price: number | null;
}

/** Statuses the exchange uses for an order that is finished without (fully) filling. */
const isDead = (status: string) => /cancel|reject|expired/i.test(status);

/** One pass over a user's resting entries. Never throws; problems come back as events. */
export async function managePending(hl: HyperliquidClient, db: Db, userId: string, now = Date.now(), opts: PendingOptions = {}): Promise<PendingEvent[]> {
  const events: PendingEvent[] = [];
  const { data: rows, error } = await db.from('pending_orders').select('*').eq('user_id', userId).eq('status', 'resting');
  if (error || !rows?.length) return events;

  for (const raw of rows) {
    const num = (v: unknown) => (v == null ? null : Number(v));
    const row: PendingRow = {
      ...raw, limit_px: +raw.limit_px, size: +raw.size, leverage: +raw.leverage, stop_loss_pct: num(raw.stop_loss_pct), take_profit_pct: num(raw.take_profit_pct),
      mode: raw.mode === 'chase' ? 'chase' : 'limit', chase_until: raw.chase_until ?? null,
      prior_filled_size: Number(raw.prior_filled_size ?? 0), prior_filled_notional: Number(raw.prior_filled_notional ?? 0), decision_price: num(raw.decision_price),
    };
    const stamp = new Date(now).toISOString();
    const what = row.mode === 'chase' ? 'Chase' : 'Limit';
    try {
      let st = await hl.getOrderStatus(row.oid);
      if (!st) { events.push({ symbol: row.symbol, level: 'error', message: `${what} order ${row.oid} on ${row.symbol} is unknown to the exchange` }); continue; }

      const expired = now >= new Date(row.expires_at).getTime();
      const chaseOver = row.mode === 'chase' && row.chase_until != null && now >= new Date(row.chase_until).getTime();
      const cancelNow = async () => {
        await hl.cancelOrders(row.symbol, [row.oid]);
        st = (await hl.getOrderStatus(row.oid)) ?? { ...st!, status: 'canceled' };
      };
      if (st.status === 'open' && (expired || chaseOver)) await cancelNow();

      // ---- a chase still inside its window: follow the market ----
      if (row.mode === 'chase' && st.status === 'open') {
        const book = await hl.getBook(row.symbol);
        const best = row.side === 'long' ? book.bids[0]?.px : book.asks[0]?.px;
        const behind = best != null && (row.side === 'long' ? best > row.limit_px : best < row.limit_px);
        if (behind) {
          await cancelNow(); // re-reads the status, so a fill that raced the cancel is counted
          const doneSize = row.prior_filled_size + st.filledSize;
          const left = row.size - doneSize;
          if (isDead(st.status) && left * best >= MIN_ORDER_USD) {
            const prices = protectionPrices(row.side, best, row.stop_loss_pct, row.take_profit_pct);
            const next = await hl.placeLimitEntry({ coin: row.symbol, isBuy: row.side === 'long', size: left, price: best, leverage: row.leverage, ...prices });
            row.prior_filled_notional += st.filledSize * row.limit_px; row.prior_filled_size = doneSize;
            await db.from('pending_orders').update({
              oid: next.oid, limit_px: next.price, prior_filled_size: row.prior_filled_size, prior_filled_notional: row.prior_filled_notional, updated_at: stamp,
            }).eq('id', row.id);
            row.oid = next.oid; row.limit_px = next.price;
            st = { status: 'open', filledSize: 0, originalSize: next.size, limitPx: next.price };
          }
        }
      }

      let filled = row.prior_filled_size + st.filledSize;
      let notional = row.prior_filled_notional + st.filledSize * row.limit_px;
      const finished = st.status === 'filled' || isDead(st.status);

      // ---- a chase out of time: take what is left at market ----
      let fallback: string | null = null;
      if (row.mode === 'chase' && finished && st.status !== 'filled' && chaseOver) {
        const mark = await hl.getMarkPrice(row.symbol);
        const leftUsd = (row.size - filled) * mark;
        if (leftUsd >= MIN_ORDER_USD) {
          const fill = await hl.placeMarketOrder({ coin: row.symbol, isBuy: row.side === 'long', sizeUsd: leftUsd, leverage: row.leverage, reduceOnly: false, slippagePercent: opts.slippagePercent ?? 2 });
          filled += fill.sizeInContracts; notional += fill.sizeInContracts * fill.fillPrice;
          fallback = `${fill.sizeInContracts} taken at market`;
        }
      }

      // Rule 2: whatever has filled must be protected, even while the rest is still resting.
      if (filled > 0 && (row.stop_loss_pct != null || row.take_profit_pct != null)) {
        const position = await hl.getPosition(row.symbol);
        if (position && position.side === row.side) {
          const orders = await hl.getOpenOrders(row.symbol);
          const stops = orders.filter(o => o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType));
          const targets = orders.filter(o => o.isTrigger && o.reduceOnly && /profit/i.test(o.orderType));
          // After a market fallback the children of the cancelled entry are gone or under-sized: place for the whole position.
          const short = (xs: typeof orders) => xs.reduce((a, o) => a + o.size, 0) < position.size * 0.999;
          const prices = protectionPrices(row.side, position.entryPrice, row.stop_loss_pct, row.take_profit_pct);
          const missing = {
            stopLossPx: row.stop_loss_pct != null && (!stops.length || (fallback && short(stops))) ? prices.stopLossPx : undefined,
            takeProfitPx: row.take_profit_pct != null && (!targets.length || (fallback && short(targets))) ? prices.takeProfitPx : undefined,
          };
          if (missing.stopLossPx != null || missing.takeProfitPx != null) {
            if (fallback) await hl.cancelProtectiveOrders(row.symbol);
            await hl.placeProtectiveOrders({ coin: row.symbol, side: row.side, size: position.size, ...(fallback ? prices : missing) });
            events.push({ symbol: row.symbol, level: 'info', message: `${row.symbol}: stop/target placed for the filled ${what.toLowerCase()} entry` });
          }
        }
      }
      if (!finished) continue;

      // Rule 1: nothing filled and the entry is gone, so no stop of its may remain.
      if (filled === 0) {
        if (!(await hl.getPosition(row.symbol))) await hl.cancelProtectiveOrders(row.symbol);
        const status = expired || chaseOver ? 'expired' : 'cancelled';
        await db.from('pending_orders').update({ status, updated_at: stamp, note: status === 'expired' ? 'Not filled before it expired' : `Ended on the exchange: ${st.status}` }).eq('id', row.id);
        events.push({ symbol: row.symbol, level: 'info', message: `${what} ${row.side} on ${row.symbol} at ${row.limit_px} ${status === 'expired' ? 'expired unfilled' : `was cancelled (${st.status})`}` });
        continue;
      }

      // Filled (fully, or partly before it ended): record the trade at its average price.
      const avgPx = notional / filled;
      let trade: { id: string };
      try {
        trade = await insertTrade(db, {
          user_id: userId, symbol: row.symbol, side: row.side, status: 'open',
          entry_price: avgPx, size: filled, size_usd: notional, leverage: row.leverage,
          entry_time: stamp, signal_source: 'manual', hyperliquid_order_id: row.oid,
          webhook_payload: { order_type: row.mode, ...(row.journal ? { journal: row.journal } : {}) },
          created_at: stamp, updated_at: stamp, order_type: row.mode,
          ...(row.decision_price ? { decision_price: row.decision_price, slippage_bps: slippageBps(row.side, row.decision_price, avgPx) } : {}),
        });
      } catch (err) {
        throw new Error(`filled but could not be recorded: ${err instanceof Error ? err.message : err}`);
      }
      const partial = filled < row.size * 0.999;
      await db.from('pending_orders').update({
        status: 'filled', filled_size: filled, trade_id: trade.id, updated_at: stamp,
        note: [fallback, partial ? `Partly filled (${filled} of ${row.size}) before it ended` : null].filter(Boolean).join('; ') || null,
      }).eq('id', row.id);
      const px = Number(avgPx.toPrecision(7));
      events.push({ symbol: row.symbol, level: 'trade', message: `${what} ${row.side} filled: ${filled} ${row.symbol} at ${px}${fallback ? ` (${fallback})` : ''}${partial ? ' (partial)' : ''}` });
    } catch (err) {
      events.push({ symbol: row.symbol, level: 'error', message: `${what} order on ${row.symbol}: ${err instanceof Error ? err.message : err}` });
    }
  }
  return events;
}

/** Cancels a resting entry at the user's request. Anything that already filled stays open (and protected). */
export async function cancelLimitEntry(hl: HyperliquidClient, db: Db, userId: string, id: string): Promise<PendingEvent[]> {
  const { data: row } = await db.from('pending_orders').select('*').eq('user_id', userId).eq('id', id).eq('status', 'resting').maybeSingle();
  if (!row) throw new Error('Order not found or no longer resting');
  await hl.cancelOrders(row.symbol, [row.oid]).catch(() => {}); // already gone is fine: the pass below settles it
  // A cancelled chase must not fall back to market: end its window first.
  if (row.mode === 'chase') await db.from('pending_orders').update({ mode: 'limit' }).eq('id', row.id);
  return managePending(hl, db, userId);
}
