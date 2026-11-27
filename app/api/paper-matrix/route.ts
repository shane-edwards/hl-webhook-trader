import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readPages } from '@/lib/supabase/pages';
import { buildPaperMatrix, type PaperRow } from '@/lib/automation/paper-matrix';

export const dynamic = 'force-dynamic';

// Crypto paper results by strategy and coin, with each pair's progress toward the Paper requirement.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = createServiceClient();
    const rows = await readPages<PaperRow>((from, to) => db.from('autopilot_positions').select('symbol,strategy_id,side,status,pnl,exit_time')
      .eq('user_id', user.id).eq('mode', 'paper').order('id').range(from, to));
    return NextResponse.json(buildPaperMatrix(rows));
  } catch {
    return NextResponse.json({ error: 'Could not load the paper results.' }, { status: 503 });
  }
}
