// Order execution shared by the webhook, the manual trade ticket and the kill
// switch, so every entry point records trades and manages stops the same way.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closeOpenTrades } from '@/lib/trade-records';

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
}

export async function openPosition(hl: HyperliquidClient, db: Db, p: OpenParams): Promise<OpenResult> {
  const fill = await hl.placeMarketOrder({
    coin: p.symbol,
    isBuy: p.side === 'long',
    sizeUsd: p.sizeUsd,
    leverage: p.leverage,
    reduceOnly: false,
    slippagePercent: p.slippagePercent,
  });

  const now = new Date().toISOString();
  const { data: trade, error } = await db
    .from('trades')
    .insert({
      user_id: p.userId,
      symbol: p.symbol,
      side: p.side,
      status: 'open',
      entry_price: fill.fillPrice,
      size: fill.sizeInContracts,
      size_usd: fill.sizeInContracts * fill.fillPrice,
      leverage: p.leverage,
      entry_time: now,
      signal_source: p.source,
      webhook_payload: p.payload ?? null,
      hyperliquid_order_id: fill.orderId,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();
  // The order is live on the exchange; make a missing record loud rather than silent.
  if (error) throw new Error(`Order ${fill.orderId} filled but could not be recorded: ${error.message}`);

  const result: OpenResult = {
    tradeId: trade.id, orderId: fill.orderId, fillPrice: fill.fillPrice, size: fill.sizeInContracts,
    stopLossPx: null, takeProfitPx: null, protectionError: null,
  };

  if (p.stopLossPct != null || p.takeProfitPct != null) {
    try {
      // Protect the whole position (it may include earlier entries), from its average entry.
      const position = await hl.getPosition(p.symbol);
      if (!position) throw new Error('position not found after fill');
      const prices = protectionPrices(p.side, position.entryPrice, p.stopLossPct, p.takeProfitPct);
      await hl.cancelOpenOrders(p.symbol); // replace any older stops rather than stacking them
      await hl.placeProtectiveOrders({ coin: p.symbol, side: p.side, size: position.size, ...prices });
      result.stopLossPx = prices.stopLossPx ?? null;
      result.takeProfitPx = prices.takeProfitPx ?? null;
    } catch (err) {
      result.protectionError = err instanceof Error ? err.message : 'Unknown error';
    }
  }
  return result;
}

export interface CloseResult { fillPrice: number; size: number; tradeIds: string[] }

/** Closes the whole position, settles its trade records and clears leftover stop orders. */
export async function closePositionFully(hl: HyperliquidClient, db: Db, userId: string, symbol: string, slippagePercent: number, notes?: string): Promise<CloseResult> {
  const closed = await hl.closePosition(symbol, slippagePercent);
  if (!closed.fullyClosed) {
    throw new Error(`Only ${closed.filledSize} ${symbol} closed; the rest is still open on the exchange`);
  }
  const tradeIds = await closeOpenTrades(db, userId, symbol, closed.fillPrice, notes);
  // Stops normally cancel themselves when the position closes; make sure none linger.
  await hl.cancelOpenOrders(symbol).catch(() => {});
  return { fillPrice: closed.fillPrice, size: closed.filledSize, tradeIds };
}
