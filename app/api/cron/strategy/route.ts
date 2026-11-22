import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { notify } from '@/lib/notify';
import { cronAuthorized } from '@/lib/cron-auth';
import { alertOnStalePeers } from '@/lib/health';
import { runStrategyOnce, runToRow, strategyConfigFromSettings, type StrategyRunResult } from '@/lib/strategy/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Called once a day shortly after the 00:00 UTC candle close by Supabase's scheduler
// (job hl-strategy, see supabase/migrations/007_execution.sql), with `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  // A once-a-day second look at the two scans and the database.
  await alertOnStalePeers(supabase, null).catch(() => {});

  const { data: rows, error } = await supabase.from('settings').select('*').eq('strategy_enabled', true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const summary: Array<{ status: string; message: string }> = [];
  for (const settings of rows ?? []) {
    let result: StrategyRunResult;
    const cfg = strategyConfigFromSettings(settings);
    try {
      const hl = hlClientFromSettings(settings);
      if (!hl) throw new Error('Hyperliquid credentials not configured');
      result = await runStrategyOnce(hl, cfg);
    } catch (err) {
      result = {
        symbol: cfg.symbol, status: 'error', signalDate: null, trendScore: null, realizedVol: null,
        targetExposure: null, currentExposure: null, equityUsd: null, tradedSize: null, fillPrice: null,
        message: err instanceof Error ? err.message : 'Unknown error',
      };
    }
    if (result.status === 'error') console.error('[strategy]', result.message);
    await supabase.from('strategy_runs').insert(runToRow(settings.user_id, result));
    // Quiet days ("held") are not worth a message; trades, dry-run signals and errors are.
    if (result.status !== 'held') {
      await notify(`Strategy ${cfg.symbol} ${result.status === 'error' ? 'ERROR' : result.status}: ${result.message}`);
    }
    summary.push({ status: result.status, message: result.message });
  }

  return NextResponse.json({ ran: summary.length, results: summary });
}
