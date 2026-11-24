import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { HEDGE_MARKETS, HEDGE_REVISION, SIMULATED_CAPITAL, type HedgeMarket, type HedgeObservation } from '@/lib/hedge-research/model';

export async function GET(request: Request) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const symbol = new URL(request.url).searchParams.get('symbol');
  if (!symbol || !Object.hasOwn(HEDGE_MARKETS, symbol)) return NextResponse.json({ error: 'Hedge research is available for BTC and ETH.' }, { status: 400 });
  const result = await createServiceClient().from('funding_hedge_observations').select('observed_at,reading').eq('revision', HEDGE_REVISION)
    .eq('symbol', symbol as HedgeMarket).order('hour', { ascending: false }).limit(1).maybeSingle();
  if (result.error) return NextResponse.json({ error: 'Could not read the funding hedge.' }, { status: 503 });
  const latest = result.data?.reading as HedgeObservation | undefined;
  return NextResponse.json({ symbol, sampleCapital: SIMULATED_CAPITAL, observedAt: result.data?.observed_at ?? null,
    snapshot: latest ? { status: latest.status, detail: latest.detail, rate14d: latest.rate14d, simulatedNet: latest.simulatedNet,
      spreadCostBps: latest.spreadCostBps, closed: latest.state.completed, realized: latest.state.realized, missingHours: latest.state.gaps } : null });
}
