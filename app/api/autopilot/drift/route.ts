import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { configFromSettings } from '@/lib/autopilot/run';
import { computeDrift } from '@/lib/autopilot/drift';
import { WARMUP_BARS, type Bar } from '@/lib/autopilot/strategies';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HOUR = 3_600_000;
const PAPER_START = 10_000;
/** The exchange returns at most 5,000 candles a call, which caps how far back the replay can start. */
const MAX_BARS = 4_900;

// Paper record against a replay of the backtest simulator over the same dates.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  if (!settings || settings.autopilot_enabled === undefined) return NextResponse.json({ available: false });

  const cfg = configFromSettings(settings);
  const { data: rows, error } = await service.from('autopilot_positions').select('strategy_id, status, entry_time, exit_time, pnl')
    .eq('user_id', user.id).eq('mode', 'paper').order('entry_time', { ascending: true }).limit(2000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows?.length) return NextResponse.json({ available: true, since: null, strategies: [] });

  const now = Date.now();
  const earliest = new Date(rows[0].entry_time).getTime();
  // Start at the first paper trade, or as far back as one candle request allows after the warm-up.
  const since = Math.max(earliest - HOUR, now - (MAX_BARS - WARMUP_BARS) * HOUR);
  try {
    const hl = marketDataClient();
    const bars = new Map<string, Bar[]>();
    await Promise.all(cfg.symbols.map(async s => { bars.set(s, await hl.getCandles(s, '1h', since - (WARMUP_BARS + 5) * HOUR, now)); }));
    const strategies = computeDrift({
      strategyIds: cfg.strategies, symbols: cfg.symbols, bars, allowShort: cfg.allowShort, risk: cfg.risk, equity: PAPER_START, since, now,
      paper: rows.filter(r => r.status === 'closed' && r.exit_time && new Date(r.exit_time).getTime() >= since)
        .map(r => ({ strategyId: r.strategy_id, exitTime: new Date(r.exit_time).getTime(), pnl: Number(r.pnl ?? 0) })),
    });
    return NextResponse.json({ available: true, since, truncated: since > earliest, strategies });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
