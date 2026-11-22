import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { configFromSettings, runAutopilot } from '@/lib/autopilot/run';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { STRATEGIES } from '@/lib/autopilot/strategies';
import evidence from '@/lib/autopilot/evidence.json';
import scalpSearch from '@/lib/autopilot/scalp-evidence.json';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  return { supabase, service, user, settings };
}

// Everything the Autopilot page shows.
export async function GET() {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabase, user, settings } = ctx;

  const strategies = STRATEGIES.map(s => ({
    id: s.id, name: s.name, style: s.style, description: s.description, horizon: s.horizon,
    evidence: evidence.strategies.filter(e => e.id === s.id),
  }));
  const base = {
    strategies, evidenceThrough: evidence.generatedThrough, evidenceCoins: evidence.coins,
    scalpSearch: { tested: scalpSearch.tested, confirmed: scalpSearch.confirmed.length, through: scalpSearch.generatedThrough },
  };

  // The autopilot columns and tables only exist after migration 004.
  if (!settings || settings.autopilot_enabled === undefined) return NextResponse.json({ ...base, available: false });

  const mode = settings.autopilot_mode === 'live' ? 'live' : 'paper';
  const [state, positions, events] = await Promise.all([
    supabase.from('autopilot_state').select('*').eq('user_id', user.id).eq('mode', mode).maybeSingle(),
    supabase.from('autopilot_positions').select('*').eq('user_id', user.id).eq('mode', mode).order('entry_time', { ascending: false }).limit(60),
    supabase.from('autopilot_events').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(40),
  ]);
  return NextResponse.json({
    ...base,
    available: true,
    hasWallet: !!settings.hl_private_key_encrypted || !!process.env.HL_PRIVATE_KEY,
    isTestnet: settings.is_testnet === true,
    state: state.data ?? null,
    positions: positions.data ?? [],
    events: events.data ?? [],
  });
}

// { action: 'scan' }  run one scan now, in the configured mode (live mode can place real orders)
// { action: 'reset' } clear a drawdown pause and restart the peak from current equity
// { action: 'reset_paper' } wipe the paper account back to $10,000
export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { service, user, settings } = ctx;
  if (!settings || settings.autopilot_enabled === undefined) {
    return NextResponse.json({ error: 'Run supabase/migrations/004_autopilot.sql first' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  const cfg = configFromSettings(settings);

  try {
    if (body?.action === 'reset') {
      await service.from('autopilot_state').update({ halted_reason: null, peak_equity: null, day_key: null }).eq('user_id', user.id).eq('mode', cfg.mode);
      return NextResponse.json({ ok: true });
    }
    if (body?.action === 'reset_paper') {
      await service.from('autopilot_positions').delete().eq('user_id', user.id).eq('mode', 'paper');
      await service.from('autopilot_state').delete().eq('user_id', user.id).eq('mode', 'paper');
      return NextResponse.json({ ok: true });
    }
    if (body?.action === 'scan') {
      // Paper mode only reads public prices, so it needs no wallet.
      const hl = cfg.mode === 'paper' ? marketDataClient() : hlClientFromSettings(settings);
      if (!hl) return NextResponse.json({ error: 'Connect your wallet in Settings first' }, { status: 400 });
      const result = await runAutopilot(hl, service, user.id, cfg);
      return NextResponse.json({ result });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
