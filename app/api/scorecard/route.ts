import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { buildScorecard, type ScoredIdea } from '@/lib/scorecard';
import historical from '@/lib/suggestions-evidence.json';

export const dynamic = 'force-dynamic';

// How the trade ideas have done: the live record (ideas logged as they
// appeared, scored against what the price then did) and the historical replay
// (backtest/suggestions.ts).
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await createServiceClient().from('suggestion_log')
    .select('symbol, bias, strength, stop_kind, stop_pct, target_pct, outcome, ret_1d, ret_3d, ret_7d, created_at')
    .order('created_at', { ascending: false }).limit(2000);
  const n = (v: unknown) => (v == null ? null : Number(v));
  const ideas: ScoredIdea[] = (data ?? []).map(r => ({
    bias: r.bias, strength: r.strength, stopKind: r.stop_kind, stopPct: Number(r.stop_pct), targetPct: Number(r.target_pct),
    outcome: r.outcome, ret1d: n(r.ret_1d), ret3d: n(r.ret_3d), ret7d: n(r.ret_7d),
  }));
  return NextResponse.json({
    available: !error,
    live: { since: data?.length ? data[data.length - 1].created_at : null, rows: buildScorecard(ideas) },
    historical,
  });
}
