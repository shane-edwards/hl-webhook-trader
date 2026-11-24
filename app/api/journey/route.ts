import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { findIdea, ideaId } from '@/lib/automation/ideas';
import { AUTOMATION_MARKETS, automationVersion, type RunReport } from '@/lib/automation/model';
import { exactCandidate, liveOpportunityCandidates, readPaperResults } from '@/lib/automation/policy';

export async function GET(request: Request) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = createServiceClient();
  const params = new URL(request.url).searchParams;
  const selected = findIdea(params.get('idea'));
  try {
    const [schedules, focus, profiles, links, settings, live] = await Promise.all([
      Promise.all(AUTOMATION_MARKETS.map(market => db.from('automation_runs').select('market, as_of, report, completed_at').eq('user_id', user.id)
        .eq('market', market).eq('kind', 'daily').eq('status', 'completed').order('as_of', { ascending: false }).limit(1).maybeSingle())),
      db.from('automation_runs').select('idea_id, status, detail, report, as_of, completed_at').eq('user_id', user.id)
        .eq('kind', 'focused').not('idea_id', 'like', 'search:%').order('created_at', { ascending: false }).limit(150),
      db.from('automation_profiles').select('market, mode, enabled, entries_paused, paper_version, live_version, scan_for_opportunities, live_scan_versions').eq('user_id', user.id),
      db.from('etoro_connections').select('environment').eq('user_id', user.id),
      db.from('settings').select('hl_private_key_encrypted, is_testnet, autopilot_mode').eq('user_id', user.id).maybeSingle(),
      selected ? liveOpportunityCandidates(db, user.id, selected.market) : [],
    ]);
    if (schedules.some(row => row.error) || focus.error || profiles.error || links.error || settings.error) throw new Error('Could not read strategies.');
    const results: Record<string, { evidence: NonNullable<RunReport['evidence'][number]>; asOf: string }> = {};
    const work: Record<string, { status: string; detail: string | null; completedAt: string | null }> = {};
    const saveEvidence = (report: RunReport | null, asOf: string) => {
      for (const evidence of report?.evidence ?? []) {
        const key = ideaId(evidence.market, evidence.rule, evidence.symbol);
        if (!results[key] || Date.parse(results[key].asOf) <= Date.parse(asOf)) results[key] = { evidence, asOf };
      }
    };
    for (const row of schedules) if (row.data) saveEvidence(row.data.report, row.data.as_of);
    for (const row of focus.data) {
      const detail = row.report?.data?.missing?.[0]?.detail ?? row.detail;
      work[row.idea_id] ??= { status: row.status, detail, completedAt: row.completed_at };
      if (row.status === 'completed') saveEvidence(row.report, row.as_of);
    }
    let ready = null;
    let paper = null;
    if (selected?.executable) {
      const version = automationVersion(selected.market, selected.symbol, selected.rule);
      ready = await exactCandidate(db, user.id, selected.market, version);
      if (ready) paper = await readPaperResults(db, user.id, ready);
    }
    return NextResponse.json({ results, work, profiles: profiles.data, connections: links.data.map(row => row.environment), ready, paper, observedAt: Date.now(),
      live: live.map(row => ({ version: row.candidate.version, name: row.candidate.name, symbol: row.candidate.symbol })),
      cryptoMode: settings.data?.autopilot_mode === 'live' ? 'live' : 'paper',
      hasWallet: !!settings.data?.hl_private_key_encrypted || !!process.env.HL_PRIVATE_KEY,
      isTestnet: settings.data?.is_testnet === true || process.env.HL_TESTNET === 'true' });
  } catch {
    return NextResponse.json({ error: 'Could not load the strategy workspace.' }, { status: 503 });
  }
}
