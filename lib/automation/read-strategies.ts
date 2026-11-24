import type { createServiceClient } from '@/lib/supabase/server';
import { AUTOMATION_MARKETS, automationVersion, type AutomationMarket, type AutomationProfile, type Evidence } from '@/lib/automation/model';
import { paperVersionsInUse, readPaperResults } from '@/lib/automation/policy';
import type { NamedTrial } from '@/lib/automation/forward-trials';
import { catalogIdeas, liveVersions, namedRow, searchRows, type Workspace, type StrategyRow } from '@/lib/automation/strategy-workspace';
import { pairFromKey, RECOMMENDATION_FRESH_MS, SEARCH_REFRESH_MS, marketSearchPairs, searchKey, type SearchReport } from '@/lib/strategy-search/model';

type Db = ReturnType<typeof createServiceClient>;
type Result = { as_of: string; evidence: Evidence[] | null; trial: NamedTrial | null; search: SearchReport | null };

async function latestFocused(db: Db, user: string, market: AutomationMarket) {
  const wanted = new Set([...catalogIdeas(market).map(i => i.id), ...marketSearchPairs(market).map(searchKey)]);
  const ids: string[] = [];
  while (wanted.size) {
    const page = await db.from('automation_runs').select('id,idea_id').eq('user_id', user).eq('market', market)
      .eq('kind', 'focused').eq('status', 'completed').order('as_of', { ascending: false }).order('id').in('idea_id', [...wanted]).limit(500);
    if (page.error) throw page.error;
    for (const row of page.data) if (wanted.delete(row.idea_id)) ids.push(row.id);
    if (page.data.length < 500) break;
  }
  const chunks = [];
  for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));
  return (await Promise.all(chunks.map(async batch => {
    const result = await db.from('automation_runs').select('as_of,evidence:report->evidence,trial:report->data->trial,search:report->data->search')
      .eq('user_id', user).eq('market', market).in('id', batch);
    if (result.error) throw result.error;
    return result.data as unknown as Result[];
  }))).flat();
}

export async function readStrategies(db: Db, user: string): Promise<Workspace> {
  const [plans, links, settings] = await Promise.all([
    db.from('automation_profiles').select('market,enabled,mode,entries_paused,live_version,scan_for_opportunities,live_scan_versions,loss_budget_usd,max_order_usd').eq('user_id', user),
    db.from('etoro_connections').select('environment').eq('user_id', user),
    db.from('settings').select('hl_private_key_encrypted,is_testnet').eq('user_id', user).maybeSingle(),
  ]);
  if (plans.error || links.error || settings.error) throw new Error('Account status unavailable');
  const demo = links.data.some(c => c.environment === 'demo');
  const now = Date.now();
  const markets = await Promise.all(AUTOMATION_MARKETS.map(async market => {
    const profile = (plans.data.find(r => r.market === market) ?? null) as AutomationProfile | null;
    const [focused, daily, pending, failures, active] = await Promise.all([
      latestFocused(db, user, market),
      db.from('automation_runs').select('as_of,evidence:report->evidence').eq('user_id', user).eq('market', market)
        .eq('kind', 'daily').eq('status', 'completed').order('as_of', { ascending: false }).limit(1).maybeSingle(),
      db.from('automation_runs').select('idea_id,status').eq('user_id', user).eq('market', market)
        .eq('kind','focused').in('status',['queued','running']),
      db.from('automation_runs').select('idea_id,as_of').eq('user_id', user).eq('market',market)
        .eq('kind','focused').eq('status','failed').gte('as_of',new Date(now - SEARCH_REFRESH_MS).toISOString())
        .order('as_of',{ascending:false}).limit(250),
      paperVersionsInUse(db, user, market),
    ]);
    if (daily.error || pending.error || failures.error) throw new Error('Research unavailable');
    const trials = new Map(focused.flatMap(r => r.trial ? [[r.trial.version, r.trial] as const] : []));
    const evidence = new Map<string, { asOf: string; e: Evidence }>();
    for (const r of [...focused, ...(daily.data ? [daily.data as unknown as Result] : [])]) {
      for (const e of r.evidence ?? []) if (e.market === market && (!evidence.has(e.version) || r.as_of > evidence.get(e.version)!.asOf))
        evidence.set(e.version,{ asOf: r.as_of, e });
    }
    const live = liveVersions(profile);
    const rows = await Promise.all(catalogIdeas(market).map(async idea => {
      const version = automationVersion(market, idea.symbol, idea.rule);
      const item = evidence.get(version);
      const broker = item && idea.executable && (live.includes(version) || active.has(version) ||
        item.e.qualified && now - Date.parse(item.asOf) < RECOMMENDATION_FRESH_MS) ? await readPaperResults(db, user, item.e) : undefined;
      return namedRow(idea, item?.e, item?.asOf, trials.get(version), broker, profile, active.has(version), demo, now);
    }));
    for (const r of focused) if (r.search && r.search.pair.market === market) {
      const generated = searchRows(r.search, !!profile?.enabled);
      if (now - Date.parse(r.as_of) > SEARCH_REFRESH_MS * 1.5) for (const row of generated)
        if (row.stage === 'paper' && profile?.enabled) row.status = 'Awaiting fresh data';
      rows.push(...generated);
    }
    const latest = new Map(focused.flatMap(r => r.search ? [[searchKey(r.search.pair), r.as_of] as const] : []));
    for (const f of failures.data) {
      const row = rows.find(r => r.id === f.idea_id);
      const last = row?.version ? evidence.get(row.version)?.asOf : latest.get(f.idea_id);
      if (last && last >= f.as_of) continue;
      if (row?.stage === 'activity') row.status = 'Backtest failed';
      else if (!row) {
        const pair = pairFromKey(f.idea_id);
        if (pair) rows.push({id:f.idea_id,...pair,name:'Strategy search',stage:'activity',status:'Backtest failed',
          backtest:'Waiting for the next retry',live:'Awaiting results'});
      }
    }
    for (const p of pending.data) {
      const existing = rows.find(r => r.id === p.idea_id);
      const label = p.status === 'running' ? 'Backtesting' : 'Backtest queued';
      if (existing) { if (existing.stage === 'activity') existing.status = label; continue; }
      const pair = pairFromKey(p.idea_id);
      if (pair) rows.push({ id: p.idea_id, ...pair, name: 'Strategy search', stage:'activity', status:label, backtest:label, live:'Awaiting results' });
    }
    const connected = market === 'crypto' || links.data.length > 0;
    const account = market === 'stocks' ? links.data.some(c => c.environment === 'real') :
      !!(settings.data?.hl_private_key_encrypted || process.env.HL_PRIVATE_KEY) && !settings.data?.is_testnet && process.env.HL_TESTNET !== 'true';
    return { rows, controls: { market, connected, enabled: !!profile?.enabled, needsSetup: !profile && connected, account, demo,
      active: live, paused: !!profile?.entries_paused || !profile?.enabled, budget: profile?.loss_budget_usd ?? null, order: profile?.max_order_usd ?? null } };
  }));
  const rank = (row: StrategyRow) => row.paper ? row.paper.net / Math.max(1, row.paper.drawdown) * Math.sqrt(row.paper.count / (row.paper.count + 10)) : 0;
  const ranked = markets.flatMap(m => m.rows).sort((a: StrategyRow, b: StrategyRow) =>
    a.stage.localeCompare(b.stage) || (a.stage === 'ready' ? rank(b) - rank(a) : 0) ||
    (b.paper?.count ?? 0) - (a.paper?.count ?? 0) || (a.paper?.unit === b.paper?.unit ? (b.paper?.net ?? 0) - (a.paper?.net ?? 0) : 0) ||
    a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { rows: ranked, markets: markets.map(m => m.controls) };
}
