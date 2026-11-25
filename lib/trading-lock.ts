import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from './hyperliquid/client';

// A lease spans the exchange read, risk decision and writes. Every exchange
// action checks the lease again, so an expired worker cannot keep trading.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
// Only the worker that reserved this particular entry may increase exposure while it is pending.
export const liveEntryReservation = new AsyncLocalStorage<string>();
export const tradingContext = new AsyncLocalStorage<{ userId: string; resource: string; owner: string }>();

export function accountResource(hl: HyperliquidClient, userId: string): string {
  return `${hl.isTestnet ? 'testnet' : 'mainnet'}:${(hl.address ?? userId).toLowerCase()}`;
}

export interface TradingLockOptions {
  /** Keep asking for the lease for up to this long when another worker holds it. Default 0: fail at once. */
  waitMs?: number;
  /** Pause between attempts while waiting. */
  pollMs?: number;
}

export async function withTradingLock<T>(hl: HyperliquidClient | null, db: Db, userId: string, work: () => Promise<T>, paper = false, options: TradingLockOptions = {}): Promise<T> {
  const resource = paper ? `paper:${userId}` : hl ? accountResource(hl, userId) : `wallet:${userId}`;
  const current = tradingContext.getStore();
  if (current?.resource === resource) {
    const restore = !paper && hl?.setActionContext ? hl.setActionContext(db, resource, current.owner, userId) : () => {};
    try { return await work(); } finally { restore(); }
  }
  const owner = randomUUID();
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs!) : 0;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(10, options.pollMs!) : 1_000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { data, error } = await db.rpc('acquire_trading_lock', { resource_key: resource, lease_owner: owner });
    if (error) throw new Error(`Trading coordination unavailable: ${error.message}. Apply migration 008.`);
    if (data) break;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('This account is already processing a trading operation. Retry shortly.');
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, left)));
  }
  return tradingContext.run({ userId, resource, owner }, async () => {
    const restore = !paper && hl?.setActionContext ? hl.setActionContext(db, resource, owner, userId) : () => {};
    try { return await work(); }
    finally {
      restore();
      await db.rpc('release_trading_lock', { resource_key: resource, lease_owner: owner });
    }
  });
}
