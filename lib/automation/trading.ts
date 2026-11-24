import type { createServiceClient } from '@/lib/supabase/server';
import type { AutopilotConfig } from '@/lib/autopilot/run';
import type { StockAutoConfig } from '@/lib/stocks/autopilot';
import { isStockTradeRule, isStockTradeSymbol } from '@/lib/stocks/trade-rules';
import { automationDecision, type AutomationDecision } from './policy';

type Db = ReturnType<typeof createServiceClient>;

export function controlledCryptoConfig(base: AutopilotConfig, policy: AutomationDecision, testnet: boolean) {
  const { candidate, profile } = policy;
  if (!candidate || !profile || (policy.decision !== 'paper' && policy.decision !== 'live') || (testnet && policy.decision === 'live')) return null;
  return { ...base, mode: policy.decision, symbols: [candidate.symbol], strategies: [candidate.rule], allowShort: false, liveRulesConfirmed: true,
    risk: { ...base.risk, maxPositions: 1, maxLeveragePerPosition: 1 }, automationVersion: candidate.version,
    maxOrderUsd: policy.decision === 'live' ? Number(profile.max_order_usd) : 1_000,
    dollarLossBudget: policy.decision === 'live' ? Number(profile.loss_budget_usd) : undefined };
}

export async function controlledStockConfig(db: Db, userId: string, base?: StockAutoConfig) {
  const policy = await automationDecision(db, userId, 'stocks');
  const selected = policy.candidate;
  if (policy.decision === 'legacy' && !base?.automation_version) return { config: base, policy };
  if (policy.decision === 'legacy' || !policy.profile || !selected || (policy.decision !== 'paper' && policy.decision !== 'live') ||
      !isStockTradeRule(selected.rule) || !isStockTradeSymbol(selected.symbol)) {
    if (base?.automation_version && base.active_environment) {
      await db.from('stock_autopilot').update({ active_environment: null, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('updated_at', base.updated_at);
    }
    return { config: base ? { ...base, active_environment: null } : undefined, policy };
  }
  const environment = policy.decision === 'live' ? 'real' : 'demo';
  const amount = environment === 'real' ? Math.min(Number(policy.profile.loss_budget_usd), Number(policy.profile.max_order_usd)) : 1_000;
  if (base && base.active_environment === environment && base.symbol === selected.symbol && base.strategy === selected.rule &&
      base.automation_version === selected.version && base.leverage === 1 && Number(base.amount) === amount) return { config: base, policy };
  const config = { user_id: userId, symbol: selected.symbol, strategy: selected.rule, leverage: 1, amount, stop_margin_pct: null,
    portfolio: null, active_environment: environment, automation_version: selected.version, updated_at: new Date().toISOString() };
  const saved = base ? await db.from('stock_autopilot').update(config).eq('user_id', userId).eq('updated_at', base.updated_at)
    .select('*').maybeSingle() : await db.from('stock_autopilot').insert(config).select('*').maybeSingle();
  if (saved.error && saved.error.code !== '23505') throw new Error('Could not set the versioned stock plan.');
  return { config: saved.data ? saved.data as StockAutoConfig : base ? { ...base, active_environment: null } : undefined, policy };
}
