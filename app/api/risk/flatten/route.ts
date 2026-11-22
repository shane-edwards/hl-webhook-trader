import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { closePositionFully } from '@/lib/execution';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Kill switch. Stops all automation first (so nothing re-opens a position),
// then closes every open position on the exchange.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const serviceClient = createServiceClient();
  const { data: settings } = await serviceClient.from('settings').select('*').eq('user_id', user.id).single();
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 });

  // Pause automation. strategy_enabled only exists after migration 002.
  const pause: Record<string, unknown> = { webhook_enabled: false, updated_at: new Date().toISOString() };
  if (settings.strategy_enabled !== undefined) pause.strategy_enabled = false;
  const { error: pauseError } = await serviceClient.from('settings').update(pause).eq('user_id', user.id);

  const results: Array<{ symbol: string; closed: boolean; fillPrice?: number; error?: string }> = [];
  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ error: 'Hyperliquid credentials not configured' }, { status: 400 });

    const positions = await hl.getPositions();
    for (const p of positions) {
      try {
        const closed = await closePositionFully(hl, supabase, user.id, p.symbol, Number(settings.slippage_percent), 'Closed by kill switch');
        results.push({ symbol: p.symbol, closed: true, fillPrice: closed.fillPrice });
      } catch (err) {
        results.push({ symbol: p.symbol, closed: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await notify(`KILL SWITCH FAILED: ${message}`);
    return NextResponse.json({ error: message, automationPaused: !pauseError }, { status: 500 });
  }

  const failed = results.filter(r => !r.closed);
  await notify(
    `Kill switch used. Automation paused. Closed ${results.length - failed.length} of ${results.length} positions.` +
      (failed.length ? ` STILL OPEN: ${failed.map(f => `${f.symbol} (${f.error})`).join(', ')}` : '')
  );
  return NextResponse.json({ automationPaused: !pauseError, results }, { status: failed.length ? 207 : 200 });
}
