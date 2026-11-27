import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { buildCalibration, buildScorecard, loggedIdea, type ScoredIdea } from '@/lib/scorecard';
import historical from '@/lib/suggestions-evidence.json';

export const dynamic = 'force-dynamic';

// How the trade ideas have done: the live record (ideas logged as they
// appeared, scored against what the price then did) and the historical replay
// (backtest/suggestions.ts).
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const COLUMNS = 'symbol, bias, strength, stop_kind, stop_pct, target_pct, outcome, outcome_at, resolved, ret_1d, ret_3d, ret_7d, created_at';
  const db = createServiceClient();
  const read = (columns: string) => db.from('suggestion_log').select(columns).order('created_at', { ascending: false }).limit(2000);
  // The stored prediction arrives with migration 027; before it, predictions are rebuilt from the earlier record.
  let { data, error } = await read(`${COLUMNS}, predicted_prob`);
  if (error) ({ data, error } = await read(COLUMNS));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[];
  const n = (v: unknown) => (v == null ? null : Number(v));
  const ideas: ScoredIdea[] = rows.map(r => ({
    bias: r.bias, strength: r.strength, stopKind: r.stop_kind, stopPct: Number(r.stop_pct), targetPct: Number(r.target_pct),
    outcome: r.outcome, ret1d: n(r.ret_1d), ret3d: n(r.ret_3d), ret7d: n(r.ret_7d),
  }));
  return NextResponse.json({
    available: !error,
    live: { since: rows.length ? rows[rows.length - 1].created_at : null, rows: buildScorecard(ideas), calibration: buildCalibration(rows.map(loggedIdea)) },
    historical,
  });
}
