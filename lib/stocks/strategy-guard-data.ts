import type { createServiceClient } from '@/lib/supabase/server';
import { DEFAULT_STOCK_GUARD, SCORE_ORDER_FIELDS, stockStrategyScore, type StockGuardSettings, type StockGuardState, type StockScoreOrder } from './strategy-guard';
import type { StockTradeRule } from './trade-rules';

type Db = ReturnType<typeof createServiceClient>;
type Mode = 'demo' | 'real';

export async function readStockGuard(db: Db, userId: string, mode: Mode, enabledOnly = false) {
  const key = { user_id: userId, environment: mode };
  const config = await db.from('stock_guard_settings').select('enabled, minimum_trades, max_slippage_bps, max_net_loss_usd').match(key).maybeSingle();
  if (config.error) throw new Error('Could not read the strategy guard settings');
  const settings = (config.data ?? DEFAULT_STOCK_GUARD) as StockGuardSettings;
  if (enabledOnly && !settings.enabled) return { settings, scores: [] };
  const [states, orders] = await Promise.all([
    db.from('stock_guard_state').select('strategy, reset_at, halted_at, reason').match(key),
    db.from('etoro_stock_orders').select(SCORE_ORDER_FIELDS).match(key).eq('state', 'filled').not('strategy', 'is', null)
      .order('created_at', { ascending: false }).limit(500),
  ]);
  if (states.error || orders.error) throw new Error('Could not read strategy execution data');
  return { settings, scores: stockStrategyScore(orders.data as StockScoreOrder[], states.data as StockGuardState[], settings) };
}

export async function blockedStockStrategies(db: Db, userId: string, mode: Mode, strategies: readonly StockTradeRule[]) {
  const { settings, scores } = await readStockGuard(db, userId, mode, true);
  const blocked = new Map<StockTradeRule, string>();
  if (!settings.enabled) return blocked;
  for (const score of scores) {
    if (!strategies.includes(score.rule)) continue;
    if (score.state?.halted_at && score.state.reason) { blocked.set(score.rule, score.state.reason); continue; }
    if (!score.reason) continue;
    const key = { user_id: userId, environment: mode, strategy: score.rule };
    const now = new Date().toISOString();
    const saved = score.state
      ? await db.from('stock_guard_state').update({ halted_at: now, reason: score.reason }).match(key)
        .eq('reset_at', score.state.reset_at).is('halted_at', null).select('strategy').maybeSingle()
      : await db.from('stock_guard_state').upsert({ ...key, halted_at: now, reason: score.reason },
        { onConflict: 'user_id,environment,strategy', ignoreDuplicates: true }).select('strategy').maybeSingle();
    if (saved.error) throw new Error('Could not save the strategy pause');
    if (saved.data) blocked.set(score.rule, score.reason);
    else blocked.set(score.rule, 'The strategy guard changed during this scan. Waiting for the next check.');
  }
  return blocked;
}
