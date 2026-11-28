import type { createServiceClient } from '@/lib/supabase/server';
import type { AutopilotConfig } from '@/lib/autopilot/run';
import type { StockAutoConfig } from '@/lib/stocks/autopilot';
import { isStockTradeRule, isStockTradeSymbol, STOCK_INSTRUMENTS } from '@/lib/stocks/trade-rules';
import { currentStockEntry, stockEntryWindow } from '@/lib/stocks/trade-signals';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { BARS_NEEDED, entrySignal, isLiveEligible } from '@/lib/autopilot/signals';
import { computeIndicators, WARMUP_BARS, STRATEGIES } from '@/lib/autopilot/strategies';
import { MOMENTUM_ID } from '@/lib/autopilot/momentum';
import { SEARCH_ASSETS } from '@/lib/strategy-search/model';
import { automationDecision, type AutomationDecision } from './policy';
import { automationVersion, type Evidence } from './model';

type Db = ReturnType<typeof createServiceClient>;

async function stockOpportunity(db: Db, userId: string, candidates: Evidence[], mode: 'live' | 'paper') {
  const now = Date.now();
  const due = candidates.filter(row => isStockTradeRule(row.rule) && stockEntryWindow(row.rule, now, true)).slice(0, 8);
  if (!due.length) return null;
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', userId)
    .eq('environment', mode === 'live' ? 'real' : 'demo').maybeSingle();
  if (connection.error || !connection.data) return null;
  const broker = etoroFromConnection(connection.data);
  const picks = await Promise.allSettled(due.map(async row => {
    if (!isStockTradeSymbol(row.symbol) || !isStockTradeRule(row.rule)) return null;
    return await currentStockEntry(broker, row.symbol, STOCK_INSTRUMENTS[row.symbol], row.rule, now) ? row : null;
  }));
  return picks.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])[0] ?? null;
}

export async function cryptoOpportunity(db: Db, userId: string, candidates: Evidence[], mode: 'paper' | 'live') {
  const book = await db.from('autopilot_positions').select('symbol').eq('user_id', userId).eq('mode', mode).eq('status', 'open');
  if (book.error || book.data.length) return null;
  const now = Date.now();
  const hl = marketDataClient();
  const symbols = [...new Set(candidates.map(row => row.symbol))].slice(0, 5);
  const markets = new Map(await Promise.all(symbols.map(async symbol => {
    const bars = await hl.getHourlyCandles(symbol, BARS_NEEDED).catch(() => []);
    return [symbol, bars.length >= WARMUP_BARS + 2 ? { bars, ind: computeIndicators(bars), last: bars.length - 1 } : null] as const;
  })));
  return candidates.find(row => {
    const market = markets.get(row.symbol);
    return market && entrySignal(row.rule, market, now, false);
  }) ?? null;
}

export function controlledCryptoConfig(base: AutopilotConfig, policy: AutomationDecision, testnet: boolean) {
  const { candidate, profile } = policy;
  if (policy.decision === 'paper' && policy.allPaperSignals && profile?.mode === 'paper' && profile.enabled && !profile.entries_paused) {
    const symbols = [...new Set([...SEARCH_ASSETS.crypto,...base.symbols])];
    // Every rule takes part, long and short, so each one builds a forward record on the same coins with the same
    // stake. Paper never reaches Live on its own: Live still needs the rule's backtest (isLiveEligible below).
    const rules = STRATEGIES.map(s => s.id);
    const paperTests = symbols.flatMap(symbol => rules.map(rule => ({symbol,rule,version:automationVersion('crypto',symbol,rule)})));
    return { ...base, mode:'paper' as const, symbols, strategies:[...rules,MOMENTUM_ID],
      allowShort:true, maxOrderUsd:1_000, paperTests, allPaperSignals:true };
  }
  if (!candidate || !profile || (policy.decision !== 'paper' && policy.decision !== 'live') || (testnet && policy.decision === 'live')) return null;
  if (policy.decision === 'paper') {
    const paperTests = [candidate];
    return { ...base, mode: 'paper' as const, symbols: [...new Set(paperTests.map(row => row.symbol))],
      strategies: [...new Set(paperTests.map(row => row.rule))], allowShort:false, maxOrderUsd:1_000, paperTests };
  }
  // Live here is long-only, so the rule also needs its long-only record in the long-history evidence file.
  if (!isLiveEligible(candidate.rule, false)) return null;
  return { ...base, mode: policy.decision, symbols: [candidate.symbol], strategies: [candidate.rule], allowShort: false,
    risk: { ...base.risk, maxPositions: 1, maxLeveragePerPosition: 1 }, automationVersion: candidate.version,
    maxOrderUsd: Number(profile.max_order_usd), dollarLossBudget: Number(profile.loss_budget_usd) };
}

export async function controlledStockConfig(db: Db, userId: string, base?: StockAutoConfig) {
  const policy = await automationDecision(db, userId, 'stocks', (candidates, mode) => stockOpportunity(db, userId, candidates, mode));
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
