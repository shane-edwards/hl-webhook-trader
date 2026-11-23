import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { accountResource, withTradingLock } from '@/lib/trading-lock';
import { closePositionFully } from '@/lib/execution';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function haltAndFlatten(hl: HyperliquidClient, db: SupabaseClient<any, any, any>, userId: string, slippagePercent: number) {
  const resource = accountResource(hl, userId);
  // Halt before waiting for an in-flight worker. Its next entry is refused.
  const halted = await db.rpc('halt_trading_account', { resource_key: resource });
  if (halted.error) throw new Error(`Could not persist the account halt: ${halted.error.message}`);
  const paused = await db.from('settings').update({ trading_halted: true, flatten_pending: true, webhook_enabled: false, strategy_enabled: false, autopilot_enabled: false }).eq('user_id', userId);
  if (paused.error) throw new Error(`Account halted, automation settings could not be saved: ${paused.error.message}`);
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      const results = await withTradingLock(hl, db, userId, async () => {
        const entries = (await hl.getOpenOrders()).filter(o => !o.reduceOnly);
        for (const coin of new Set(entries.map(o => o.coin))) {
          await hl.cancelOrders(coin, entries.filter(o => o.coin === coin).map(o => o.oid));
        }
        if ((await hl.getOpenOrders()).some(o => !o.reduceOnly)) throw new Error('Entry orders remain on the exchange');
        const cancelled = await db.from('pending_orders').update({ status: 'cancelled', mode: 'limit', note: 'Cancelled by kill switch' }).eq('user_id', userId).eq('status', 'resting');
        if (cancelled.error) throw new Error(cancelled.error.message);
        await db.from('webhook_jobs').update({ status: 'error', result: { error: 'Account halted' } }).eq('user_id', userId).eq('status', 'queued');
        const closed = [];
        for (const p of await hl.getPositions()) {
          const result = await closePositionFully(hl, db, userId, p.symbol, slippagePercent, 'Closed by kill switch');
          closed.push({ symbol: p.symbol, closed: true, fillPrice: result.fillPrice });
        }
        if ((await hl.getPositions()).length || (await hl.getOpenOrders()).some(o => !o.reduceOnly)) throw new Error('Account still has positions or entry orders');
        return closed;
      });
      const recovered = await db.from('settings').update({ flatten_pending: false }).eq('user_id', userId);
      if (recovered.error) throw new Error(recovered.error.message);
      return results;
    } catch (err) {
      if (!/already processing/.test(String(err)) || Date.now() >= deadline) throw err;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}
