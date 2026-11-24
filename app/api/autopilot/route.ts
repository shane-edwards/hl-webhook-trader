import { withTradingLock } from '@/lib/trading-lock';
import { NextResponse } from 'next/server';
import { readAutomationProfile } from '@/lib/automation/policy';
import { findIdea } from '@/lib/automation/ideas';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { configFromSettings, runAutopilot } from '@/lib/autopilot/run';
import { BARS_NEEDED, entrySignal } from '@/lib/autopilot/signals';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { computeIndicators, STRATEGIES, WARMUP_BARS } from '@/lib/autopilot/strategies';
import evidence from '@/lib/autopilot/evidence.json';
import scalpSearch from '@/lib/autopilot/scalp-evidence.json';
import momentumEvidence from '@/lib/autopilot/momentum-evidence.json';
import { DAY_MS, MOMENTUM_HOLD_DAYS, MOMENTUM_ID, MOMENTUM_LOOKBACK_DAYS, MOMENTUM_STOP_PCT, MOMENTUM_UNIVERSE, momentumOrderPlan, momentumPlanKey, rankMomentum } from '@/lib/autopilot/momentum';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  return { supabase, service, user, settings };
}

// Everything the Autopilot page shows.
export async function GET(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabase, user, settings } = ctx;

  const strategies = STRATEGIES.map(s => ({
    id: s.id, name: s.name, style: s.style, description: s.description, horizon: s.horizon,
    evidence: evidence.strategies.filter(e => e.id === s.id),
  }));
  // The cross-coin basket is not a per-market rule, so it is described here rather than in STRATEGIES.
  strategies.push({
    id: MOMENTUM_ID, name: 'Cross-coin momentum (long/short basket)', style: 'Breakout' as const, horizon: `Rebalanced every ${MOMENTUM_HOLD_DAYS} days`,
    description: `Ranks up to ${MOMENTUM_UNIVERSE.length} coins by ${MOMENTUM_LOOKBACK_DAYS}-day return. Buys the strongest quarter and shorts the weakest quarter. It uses its own market list and needs space for at least four positions. Historical results do not include the protective stops now used in both modes.`,
    evidence: [false, true].map(allowShort => ({ id: MOMENTUM_ID, allowShort, liveEligible: false, early: momentumEvidence.early, late: momentumEvidence.late, recent: momentumEvidence.recent })) as never,
  });
  const base = {
    strategies, evidenceThrough: evidence.generatedThrough, evidenceCoins: evidence.coins,
    scalpSearch: { tested: scalpSearch.tested, confirmed: scalpSearch.confirmed.length, through: scalpSearch.generatedThrough },
  };

  // The autopilot columns and tables only exist after migration 004.
  if (!settings || settings.autopilot_enabled === undefined) return NextResponse.json({ ...base, available: false });

  const query = new URL(request.url).searchParams;
  const idea = findIdea(query.get('idea'));
  const ideaTrade = idea?.market === 'crypto' && idea.executable;
  if (query.has('idea') && !ideaTrade) return NextResponse.json({ error: 'Choose a crypto strategy.' }, { status: 400 });
  const mode = (ideaTrade ? query.get('mode') : settings.autopilot_mode) === 'live' ? 'live' : 'paper';
  const symbol = query.get('symbol');
  if (symbol) {
    const baseConfig = configFromSettings(settings);
    const cfg = ideaTrade ? { ...baseConfig, symbols: [idea.symbol], strategies: [idea.rule], allowShort: false } : baseConfig;
    const basket = symbol === 'BASKET' && cfg.strategies.includes(MOMENTUM_ID);
    if (query.get('mode') !== mode || (!basket && !cfg.symbols.includes(symbol))) return NextResponse.json({ error: 'Select a market in the current mode.' }, { status: 400 });
    try {
      const wallet = mode === 'live' ? hlClientFromSettings(settings) : null;
      const hl = wallet ?? marketDataClient();
      if (basket) {
        const now = Date.now();
        const positions = await supabase.from('autopilot_positions').select('strategy_id, symbol').eq('user_id', user.id).eq('mode', mode).eq('status', 'open');
        if (positions.error) throw positions.error;
        if (positions.data.some(p => p.strategy_id === MOMENTUM_ID)) return NextResponse.json({ signals: [], symbol, mode });
        const [ranking, exchange] = await Promise.all([rankMomentum(hl, now), wallet?.getPositions()]);
        const used = new Set((exchange ?? positions.data).map(p => p.symbol));
        const plan = momentumOrderPlan(ranking, 100_000, Infinity, cfg.risk.maxPositions - used.size);
        const signals = plan.length && !plan.some(leg => used.has(leg.symbol) || leg.symbol === cfg.reservedSymbol) ? [{
          id: MOMENTUM_ID, name: 'Momentum basket', side: 'long/short', barT: Math.floor(now / DAY_MS) * DAY_MS,
          stopPct: MOMENTUM_STOP_PCT / 100, reason: plan.map(leg => `${leg.side} ${leg.symbol}`).join(' · '), plan: momentumPlanKey(plan),
        }] : [];
        return NextResponse.json({ signals, symbol, mode });
      }
      const bars = await hl.getHourlyCandles(symbol, BARS_NEEDED);
      if (bars.length < WARMUP_BARS + 2) return NextResponse.json({ error: 'Insufficient hourly history for this market.' }, { status: 422 });
      const market = { bars, ind: computeIndicators(bars), last: bars.length - 1 };
      const now = Date.now();
      const signals = STRATEGIES.flatMap(strategy => {
        const signal = !cfg.strategies.includes(strategy.id) ? null : entrySignal(strategy.id, market, now, cfg.allowShort);
        return signal ? [{ ...signal, id: strategy.id, name: strategy.name }] : [];
      });
      return NextResponse.json({ signals, symbol, mode });
    } catch {
      return NextResponse.json({ error: 'Could not load current signals.' }, { status: 502 });
    }
  }
  const [state, positions, events] = await Promise.all([
    supabase.from('autopilot_state').select('*').eq('user_id', user.id).eq('mode', mode).maybeSingle(),
    supabase.from('autopilot_positions').select('*').eq('user_id', user.id).eq('mode', mode).order('entry_time', { ascending: false }).limit(60),
    supabase.from('autopilot_events').select('*').eq('user_id', user.id).eq('mode', mode).order('created_at', { ascending: false }).limit(40),
  ]);
  // Current prices for the open positions, so the page can show where each one stands right now.
  const openSymbols = new Set((positions.data ?? []).filter(p => p.status === 'open').map(p => p.symbol as string));
  const prices: Record<string, number> = {};
  if (openSymbols.size) {
    try {
      const mids = await marketDataClient().getAllMids();
      for (const sym of openSymbols) { const px = parseFloat(mids[sym] ?? ''); if (px > 0) prices[sym] = px; }
    } catch {
      // Prices are a convenience; the page says so when they are missing.
    }
  }
  return NextResponse.json({
    ...base,
    available: true,
    mode,
    prices, pricesAt: Date.now(),
    hasWallet: !!settings.hl_private_key_encrypted || !!process.env.HL_PRIVATE_KEY,
    isTestnet: process.env.HL_TESTNET === 'true' || settings.is_testnet === true,
    state: state.data ?? null,
    positions: positions.data ?? [],
    events: events.data ?? [],
  });
}

// { action: 'scan' }  run one scan now, in the configured mode (live mode can place real orders)
// { action: 'reset' } clear a drawdown pause and restart the peak from current equity
// { action: 'reset_paper' } wipe the paper account back to $10,000
export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { service, user, settings } = ctx;
  if (!settings || settings.autopilot_enabled === undefined) {
    return NextResponse.json({ error: 'Run supabase/migrations/004_autopilot.sql first' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const baseConfig = configFromSettings(settings);
  const idea = findIdea(body?.idea);
  if (body?.idea != null && (idea?.market !== 'crypto' || !idea.executable || body.action !== 'manual_entry')) {
    return NextResponse.json({ error: 'Choose a crypto strategy.' }, { status: 400 });
  }
  if (idea && body.mode === 'live' && body.confirmed !== true) return NextResponse.json({ error: 'Confirm the Live order.' }, { status: 400 });
  const cfg = idea ? { ...baseConfig, mode: body.mode === 'live' ? 'live' as const : 'paper' as const,
    symbols: [idea.symbol], strategies: [idea.rule], allowShort: false, risk: { ...baseConfig.risk, maxLeveragePerPosition: 1 } } : baseConfig;

  try {
    if (body?.action === 'reset') {
      const hl = cfg.mode === 'paper' ? marketDataClient() : hlClientFromSettings(settings);
      if (!hl) throw new Error('Wallet unavailable');
      await withTradingLock(hl, service, user.id, async () => {
        const reset = await service.from('autopilot_state').update({ halted_reason: null, peak_equity: null, day_key: null }).eq('user_id', user.id).eq('mode', cfg.mode);
        if (reset.error) throw new Error(reset.error.message);
      }, cfg.mode === 'paper');
      return NextResponse.json({ ok: true });
    }
    if (body?.action === 'reset_paper') {
      await withTradingLock(marketDataClient(), service, user.id, async () => {
        const positions = await service.from('autopilot_positions').delete().eq('user_id', user.id).eq('mode', 'paper');
        if (positions.error) throw new Error(positions.error.message);
        const state = await service.from('autopilot_state').delete().eq('user_id', user.id).eq('mode', 'paper');
        if (state.error) throw new Error(state.error.message);
      }, true);
      return NextResponse.json({ ok: true });
    }
    if (body?.action === 'scan' || body?.action === 'manual_entry') {
      if (body.action === 'scan') {
        const profile = await readAutomationProfile(service, user.id, 'crypto');
        if (profile?.entries_paused || (profile && profile.mode !== 'research')) {
          return NextResponse.json({ error: 'Automated entries are controlled in Automation Center.' }, { status: 409 });
        }
      }
      const manual = body.action === 'manual_entry' ? body.signal : null;
      if (body.mode !== cfg.mode || (cfg.mode === 'live' && body.isTestnet !== (process.env.HL_TESTNET === 'true' || settings.is_testnet === true))) {
        return NextResponse.json({ error: 'Trading mode changed. Refresh and review again.' }, { status: 409 });
      }
      const manualBasket = manual?.id === MOMENTUM_ID && manual.symbol === 'BASKET' && manual.barT === Math.floor(Date.now() / DAY_MS) * DAY_MS
        && typeof manual.plan === 'string' && manual.plan.length > 0 && manual.plan.length <= 400;
      const manualMarket = manual && cfg.symbols.includes(manual.symbol) && STRATEGIES.some(s => s.id === manual.id)
        && Number.isSafeInteger(manual.barT) && (manual.side === 'long' || (!idea && manual.side === 'short'));
      if (body.action === 'manual_entry' && (!manual || !cfg.strategies.includes(manual.id) || (!manualBasket && !manualMarket))) {
        return NextResponse.json({ error: 'Select a current signal.' }, { status: 400 });
      }
      // Paper mode only reads public prices, so it needs no wallet.
      const hl = cfg.mode === 'paper' ? marketDataClient() : hlClientFromSettings(settings);
      if (!hl) return NextResponse.json({ error: 'Connect your wallet in Settings first' }, { status: 400 });
      const result = await runAutopilot(hl, service, user.id, cfg, Date.now(), async () => {
        const { data, error } = await service.from('settings').select('*').eq('user_id', user.id).single();
        if (error || !data || data.updated_at !== settings.updated_at) throw new Error('Trading settings changed. Refresh and review again.');
        const manualEntry = manual ? { id: manual.id, symbol: manual.symbol, side: manual.side, barT: manual.barT, plan: manualBasket ? manual.plan : undefined } : undefined;
        return { ...cfg, symbols: manual && !manualBasket ? [manual.symbol] : cfg.symbols, manualEntry, manageOnly: !manual && !settings.autopilot_enabled, checkEntries: async () => {
          const latest = await service.from('settings').select('updated_at, autopilot_enabled').eq('user_id', user.id).single();
          return !latest.error && latest.data.updated_at === settings.updated_at && (!!manual || latest.data.autopilot_enabled === true);
        } };
      });
      if (manual && !result.manualOpened) return NextResponse.json({ error: result.events.find(e => e.level === 'error')?.message ?? result.haltReason ?? 'Signal expired, was already traded, or could not pass the risk checks.' }, { status: 409 });
      return NextResponse.json({ result });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
