import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { AUTOMATION_MARKETS, automationVersion, type AutomationMarket, type Evidence } from '@/lib/automation/model';
import { automationDecision, exactCandidate, latestCandidates, liveOpportunityCandidates, readAutomationProfile, readPaperResults } from '@/lib/automation/policy';
import { enqueueIdea, enqueueResearch } from '@/lib/automation/queue';
import { findIdea } from '@/lib/automation/ideas';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { STOCK_INSTRUMENTS, isStockTradeSymbol } from '@/lib/stocks/trade-rules';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { readHealth } from '@/lib/health';

import { liveVersions } from '@/lib/automation/strategy-workspace';

const market = z.enum(AUTOMATION_MARKETS);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('run'), market, kind: z.enum(['daily', 'weekly']).default('daily') }),
  z.object({ action: z.literal('test'), market, idea: z.string().max(100) }),
  z.object({ action: z.literal('paper'), market, idea: z.string().max(100) }),
  z.object({ action: z.literal('add-live'), market, version: z.string().max(140), confirmed: z.literal(true),
    existing: z.array(z.string().max(140)).max(8), budget: z.number().min(1).max(10000), maxOrder: z.number().min(10).max(10000) }),
  z.object({ action: z.literal('pause-live'), market, version: z.string().max(140) }),
  z.object({ action: z.literal('scan-paper'), market }),
  z.object({ action: z.literal('scan-live'), market, versions: z.array(z.string().max(140)).min(1).max(8), confirmed: z.literal(true),
    budget: z.number().min(1).max(10_000), maxOrder: z.number().min(10).max(10_000) }),
  z.object({ action: z.literal('mode'), market, mode: z.enum(['research', 'paper']) }),
  z.object({ action: z.literal('schedule'), market, enabled: z.boolean() }),
  z.object({ action: z.literal('entries'), market, paused: z.boolean() }),
  z.object({ action: z.literal('approve'), market, version: z.string().max(140), confirmed: z.literal(true),
    budget: z.number().min(1).max(10_000), maxOrder: z.number().min(10).max(10_000) }),
]);
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

async function context() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user ? { id: user.id, db: createServiceClient() } : null;
}

async function verifyLiveAccount(db: ReturnType<typeof createServiceClient>, user: string, market: AutomationMarket,
  candidates: Evidence[], limit: number) {
  if (market === 'crypto') {
    const settings = await db.from('settings').select('*').eq('user_id', user).maybeSingle();
    const wallet = settings.data ? hlClientFromSettings(settings.data) : null;
    if (settings.error || !wallet || settings.data?.is_testnet || process.env.HL_TESTNET === 'true') return fail('Connect a Live Hyperliquid wallet first.', 409);
    await wallet.getAccountSummary();
    return null;
  }
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', user)
    .eq('environment', 'real').maybeSingle();
  if (connection.error || !connection.data) return fail('Connect eToro Real first.', 409);
  const broker = etoroFromConnection(connection.data);
  for (const symbol of new Set(candidates.map(candidate => candidate.symbol))) {
    if (!isStockTradeSymbol(symbol)) return fail('Choose an available strategy version.', 400);
    const options = await broker.stockOrderOptions(STOCK_INSTRUMENTS[symbol]);
    const cash = options.find(option => option.leverage === 1);
    if (!cash || cash.minimum > limit) return fail(`The Live loss budget is below eToro’s minimum cash order for ${symbol}.`, 422);
  }
  return null;
}

export async function GET() {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  try {
    const [markets, health, shadow, cryptoShadow, stockSettings, cryptoSettings] = await Promise.all([
      Promise.all(AUTOMATION_MARKETS.map(async market => {
        const [policy, evidence, history] = await Promise.all([
          automationDecision(ctx.db, ctx.id, market), latestCandidates(ctx.db, ctx.id, market),
          ctx.db.from('automation_runs').select('id, kind, source, status, cursor, plan, detail, report, created_at, completed_at, as_of')
            .eq('user_id', ctx.id).eq('market', market).neq('kind', 'focused').order('created_at', { ascending: false }).limit(8),
        ]);
        if (history.error) throw new Error('Could not read automation run history.');
        const candidate = policy.candidate ?? evidence[0] ?? null;
        const paper = policy.results ?? (candidate ? await readPaperResults(ctx.db, ctx.id, candidate) : null);
        return { market, policy, candidate, paper, runs: history.data };
      })),
      readHealth(ctx.db),
      ctx.db.from('stock_catalyst_sessions').select('session_day, completed_at, summary').eq('user_id', ctx.id).not('completed_at', 'is', null)
        .order('completed_at', { ascending: false }).limit(1).maybeSingle(),
      ctx.db.from('automation_crypto_shadow').select('symbol, strategy, signal_bar, decision, detail, outcome')
        .order('signal_bar', { ascending: false }).limit(12),
      ctx.db.from('stock_autopilot').select('active_environment, automation_version').eq('user_id', ctx.id).maybeSingle(),
      ctx.db.from('settings').select('autopilot_enabled, autopilot_mode').eq('user_id', ctx.id).maybeSingle(),
    ]);
    const legacy = { stocks: stockSettings.data?.automation_version ? null : stockSettings.data?.active_environment ?? null,
      crypto: cryptoSettings.data?.autopilot_enabled ? cryptoSettings.data?.autopilot_mode : null };
    return NextResponse.json({ markets, health: health.checks, shadow: shadow.data, cryptoShadow: cryptoShadow.data ?? [], legacy, asOf: new Date().toISOString() });
  } catch { return fail('Could not load the Automation Center.', 503); }
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Choose a valid automation action.', 400);
  const input = parsed.data;
  const idea = input.action === 'test' || input.action === 'paper' ? findIdea(input.idea) : null;
  if ((input.action === 'test' || input.action === 'paper') && idea?.market !== input.market) return fail('Choose an available strategy.', 400);
  const key = { user_id: ctx.id, market: input.market };
  try {
    const current = await readAutomationProfile(ctx.db, ctx.id, input.market);
    if (!current) {
      const seeded = await ctx.db.from('automation_profiles').upsert(key, { onConflict: 'user_id,market', ignoreDuplicates: true });
      if (seeded.error) throw new Error('Could not initialize automation.');
    }
    const now = new Date().toISOString();
    if (input.action === 'run') {
      const id = await enqueueResearch(ctx.db, ctx.id, input.market, input.kind, now);
      return NextResponse.json({ message: id ? 'Research queued. It runs in the background.' : 'A research run is already queued or running.' });
    }
    if (input.action === 'test' && idea) {
      const id = await enqueueIdea(ctx.db, ctx.id, idea, now);
      return NextResponse.json({ message: id ? 'Backtest queued.' : 'Backtest already queued.' });
    }
    let patch: object;
    if (input.action === 'pause-live') {
      const versions = liveVersions(current);
      if (!versions.includes(input.version)) return fail('This strategy is no longer live.', 409);
      const remaining = versions.filter(v => v !== input.version);
      patch = remaining.length ? { live_version: remaining[0], live_scan_versions: remaining, scan_for_opportunities: true }
        : { mode: 'research', entries_paused: true, live_version: null, live_scan_versions: [], scan_for_opportunities: false,
          loss_budget_usd: null, max_order_usd: null };
    } else if (input.action === 'add-live' || input.action === 'approve' || input.action === 'scan-live') {
      let candidates: Evidence[];
      if (input.action !== 'scan-live') {
        const candidate = await exactCandidate(ctx.db, ctx.id, input.market, input.version);
        candidates = candidate && (await readPaperResults(ctx.db, ctx.id, candidate)).passed ? [candidate] : [];
      } else {
        const versions = [...new Set(input.versions)];
        candidates = (await liveOpportunityCandidates(ctx.db, ctx.id, input.market, versions)).map(row => row.candidate);
        if (candidates.length !== versions.length) return fail('Every selected strategy version must pass research and Paper before Live.', 409);
      }
      if (!candidates.length) return fail('This exact strategy version must pass research and Paper before Live.', 409);
      const problem = await verifyLiveAccount(ctx.db, ctx.id, input.market, candidates, Math.min(input.budget, input.maxOrder));
      if (problem) return problem;
      let versions = candidates.map(candidate => candidate.version);
      if (input.action === 'add-live') {
        const active = liveVersions(current);
        if (active.length !== input.existing.length || active.some(v => !input.existing.includes(v)) ||
          active.includes(input.version) || active.length >= 8 || active.length && (current?.entries_paused || !current?.enabled ||
            Number(current.loss_budget_usd) !== input.budget || Number(current.max_order_usd) !== input.maxOrder))
          return fail('The live plan changed or reached its limit. Refresh to review it.', 409);
        versions = [...active, input.version];
      }
      patch = { mode: 'live', enabled: true, entries_paused: false, live_version: versions[0],
        loss_budget_usd: input.budget, max_order_usd: input.maxOrder, scan_for_opportunities: input.action === 'scan-live' || versions.length > 1,
        live_scan_versions: versions.length > 1 || input.action === 'scan-live' ? versions : [] };
    } else if (input.action === 'scan-paper' || input.action === 'paper' && idea) {
      const version = input.action === 'paper' && idea ? automationVersion(idea.market, idea.symbol, idea.rule) : null;
      if (version && (!idea?.executable || !await exactCandidate(ctx.db, ctx.id, input.market, version))) return fail('This setup must pass a recent backtest.', 409);
      if (input.market === 'stocks') {
        const demo = await ctx.db.from('etoro_connections').select('environment').eq('user_id', ctx.id).eq('environment', 'demo').maybeSingle();
        if (demo.error) throw new Error('Could not check the eToro Demo connection.');
        if (!demo.data) return fail('Connect eToro Demo to start Paper.', 409);
      }
      if (current?.mode === 'live' && !current.entries_paused) return fail('Pause current automated entries before switching to Paper.', 409);
      patch = { mode: 'paper', paper_version: version, live_version: null, enabled: true, entries_paused: false, loss_budget_usd: null, max_order_usd: null,
        scan_for_opportunities: input.action === 'scan-paper', live_scan_versions: [] };
    } else if (input.action === 'mode') {
      patch = { mode: input.mode, paper_version: null, live_version: null, loss_budget_usd: null, max_order_usd: null, scan_for_opportunities: false, live_scan_versions: [],
        ...(input.mode === 'research' ? { entries_paused: true } : {}) };
    } else if (input.action === 'schedule') {
      patch = { enabled: input.enabled };
    } else if (input.action === 'entries') {
      patch = { entries_paused: input.paused };
    } else {
      return fail('Choose a valid automation action.', 400);
    }
    const change = ctx.db.from('automation_profiles').update({ ...patch, updated_at: now }).match(key);
    const saved = await (current ? change.eq('updated_at', current.updated_at) : change).select('market').maybeSingle();
    if (saved.error) throw new Error('Could not save automation settings.');
    if (!saved.data) return fail('The settings changed. Refresh and try again.', 409);
    return NextResponse.json({ message: 'Automation settings saved.' });
  } catch { return fail('Could not update automation. Try again shortly.', 503); }
}
