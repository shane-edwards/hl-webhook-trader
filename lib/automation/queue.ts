import type { createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/notify';
import { EtoroError } from '@/lib/stocks/etoro';
import { automationSchedule, type AutomationKind, type AutomationMarket, type RunReport } from './model';
import { finishResearch, permanentResearchProblem, researchPlan, runIdeaResearch, runResearchStep, type ResearchStep } from './research';
import { findIdea, versionedIdea, type StrategyIdea } from './ideas';
import { pairFromKey } from '@/lib/strategy-search/model';
import { runSearch } from '@/lib/strategy-search/data';

type Db = ReturnType<typeof createServiceClient>;
const stockStudyDays: Record<number, string> = {
  1: 'stocks:close-volume:SPY',
  2: 'stocks:orb-rvol:NVDA',
  3: 'stocks:close:SPY',
  4: 'stocks:vwap:AAPL',
};
export type AutomationRun = { id: string; user_id: string; market: AutomationMarket; kind: AutomationKind | 'focused'; idea_id: string | null; as_of: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; cursor: number; attempts: number; plan: string[];
  work: ResearchStep[]; report: RunReport | null; lease_token: string | null; detail: string | null; created_at: string; completed_at: string | null };

export async function enqueueResearch(db: Db, userId: string, market: AutomationMarket, kind: AutomationKind, asOf: string, key?: string) {
  const result = await db.from('automation_runs').insert({ user_id: userId, market, kind, schedule_key: key ?? null,
    source: key ? 'schedule' : 'manual', as_of: asOf, plan: researchPlan(market, kind) }).select('id').maybeSingle();
  if (result.error?.code === '23505') return null;
  if (result.error) throw new Error('Could not queue the research run.');
  return result.data?.id ?? null;
}

export async function enqueueIdea(db: Db, userId: string, idea: Pick<StrategyIdea, 'id' | 'market' | 'symbol'>, asOf: string, key?: string) {
  const result = await db.from('automation_runs').insert({ user_id: userId, market: idea.market, kind: 'focused',
    idea_id: idea.id, source: key ? 'schedule' : 'manual', schedule_key: key ?? null, as_of: asOf, plan: [idea.symbol] }).select('id').maybeSingle();
  if (result.error?.code === '23505') return null;
  if (result.error) throw new Error('Could not queue the backtest.');
  return result.data?.id ?? null;
}

export async function queueScheduledResearch(db: Db, now: number) {
  const profiles = await db.from('automation_profiles').select('user_id, market, mode, paper_version, live_version, live_scan_versions, scan_for_opportunities').eq('enabled', true);
  if (profiles.error) throw new Error('Could not read research schedules.');
  const scheduled = await Promise.all((profiles.data ?? []).flatMap(profile => {
    const market = profile.market as AutomationMarket;
    const jobs = automationSchedule(market, now);
    const daily = jobs.find(job => job.kind === 'daily');
    const weekday = daily && new Date(`${daily.key}T12:00:00Z`).getUTCDay();
    const study = market === 'stocks' && weekday ? findIdea(stockStudyDays[weekday]) : null;
    const versions: (string | null)[] = profile.mode === 'live' && profile.scan_for_opportunities ? profile.live_scan_versions :
      [profile.mode === 'paper' ? profile.paper_version : profile.mode === 'live' ? profile.live_version : null];
    const ideas: (Pick<StrategyIdea, 'id' | 'market' | 'symbol'> | null)[] = [study, ...versions.map(version => {
      const idea = versionedIdea(market, version);
      return idea?.executable ? idea : null;
    })];
    const focus = daily ? ideas.flatMap(item => item ? [{ ...daily, kind: 'focused' as const, idea: item, key: `${daily.key}:${item.id}` }] : []) : [];
    return [...jobs, ...focus].map(async job => {
      const match = await db.from('automation_runs').select('id').eq('user_id', profile.user_id).eq('market', market)
        .eq('kind', job.kind).eq('schedule_key', job.key).maybeSingle();
      if (match.error) throw new Error('Could not check the last scheduled research run.');
      if (match.data) return null;
      return job.kind === 'focused' ? enqueueIdea(db, profile.user_id, job.idea, job.asOf, job.key) :
        enqueueResearch(db, profile.user_id, market, job.kind, job.asOf, job.key);
    });
  }));
  return scheduled.filter(Boolean).length;
}

function problemFor(error: unknown) {
  if (permanentResearchProblem(error) && error instanceof Error) return error.message;
  if (error instanceof EtoroError && error.status === 429) return 'eToro asked Tideframe to wait before requesting more data.';
  if (error instanceof EtoroError && [401, 403].includes(error.status)) return 'eToro denied market-data access. Check the connection.';
  if (error instanceof Error && /history|quotes|unavailable|funding/i.test(error.message) && error.message.length < 130) return error.message;
  return 'Market data or the research worker was temporarily unavailable.';
}

export async function processResearchStep(db: Db) {
  const claimed = await db.rpc('claim_automation_run');
  if (claimed.error) throw new Error('Could not claim the next research step.');
  const run = claimed.data?.[0] as AutomationRun | undefined;
  if (!run) return 'idle';
  const release = { lease_until: null, lease_token: null };
  const save = async (patch: object) => {
    const saved = await db.from('automation_runs').update({ ...patch, ...release }).eq('id', run.id).eq('lease_token', run.lease_token!)
      .eq('status', 'running').select('id').maybeSingle();
    if (saved.error) throw new Error('Could not checkpoint the research step.');
    return !!saved.data;
  };
  const complete = async (work: ResearchStep[]) => {
    const report: RunReport = run.kind === 'focused'
      ? { evidence: work.flatMap(item => item.evidence ?? []), summary: 'Backtest finished',
        data: { search: work.find(item => item.search)?.search, missing: work.filter(item => item.problem).map(item => ({ symbol: item.symbol, detail: item.problem })) } }
      : finishResearch(run.market, run.kind, run.as_of, work);
    const noData = work.every(item => item.problem);
    const finished = await save({ status: noData ? 'failed' : 'completed', cursor: run.plan.length, work: [], report,
      detail: noData ? 'Research did not receive usable market data.' : report.summary, completed_at: new Date().toISOString() });
    if (finished && (noData || work.some(item => item.problem))) {
      await notify(`${noData ? 'FAILED' : 'WARNING'}: ${run.market === 'stocks' ? 'Stocks' : 'Crypto'} research has missing market data. Review the Automation Center.`, undefined, run.user_id);
    }
    return noData ? 'failed' : 'completed';
  };
  const symbol = run.plan[run.cursor];
  if (!symbol) return complete(run.work);
  let step: ResearchStep;
  try {
    if (run.kind === 'focused') {
      const idea = findIdea(run.idea_id);
      const pair = pairFromKey(run.idea_id);
      if (!idea && !pair) {
        await save({ status: 'failed', detail: 'This idea is no longer available.', completed_at: new Date().toISOString() });
        return 'failed';
      }
      step = pair ? { symbol, search: await runSearch(db, run.user_id, pair, run.as_of) } :
        await runIdeaResearch(db, run.user_id, idea!, run.as_of);
    } else {
      step = await runResearchStep(db, run.user_id, run.market, run.kind, symbol, run.as_of);
    }
  } catch (error) {
    const problem = problemFor(error);
    if (permanentResearchProblem(error) || error instanceof EtoroError && [401, 403].includes(error.status)) {
      const saved = await save({ status: 'failed', detail: problem, completed_at: new Date().toISOString() });
      if (saved) await notify(`FAILED: ${problem}`, undefined, run.user_id);
      return 'failed';
    }
    if (run.attempts < 3) {
      await save({ status: 'queued', detail: `${symbol} · ${problem} Retrying automatically.`,
        available_at: new Date(Date.now() + 60_000 * 2 ** (run.attempts - 1)).toISOString() });
      return 'retry';
    }
    step = { symbol, problem };
  }
  const work = [...run.work, step];
  if (run.cursor + 1 >= run.plan.length) return complete(work);
  await save({ status: 'queued', cursor: run.cursor + 1, attempts: 0, work, detail: null, available_at: new Date().toISOString() });
  return 'progress';
}
