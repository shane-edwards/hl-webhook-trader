import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings, marketDataClient } from '@/lib/hyperliquid/from-settings';
import { configFromSettings, runAutopilot, type Mode } from '@/lib/autopilot/run';
import { runUpkeep } from '@/lib/upkeep';
import { alertOnStalePeers, heartbeat } from '@/lib/health';
import { cronAuthorized } from '@/lib/cron-auth';
import { notify } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// The trading scan. Called every five minutes by a scheduler (see
// supabase/migrations/004_autopilot.sql). For each account it runs the
// Autopilot (if on), then looks after limit entries and managed exits, brings
// the trade log into line with the exchange, and sends the daily summary.
//
// Autopilot signals come from completed hourly candles, so scanning more often
// gains nothing there; stops rest on the exchange in between. A trailing or
// break-even stop, though, only moves when this runs.
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase.from('settings').select('*');
  if (error) {
    await notify(`HEALTH: the trading scan could not read the database (${error.message}). Check that the Supabase project is not paused.`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summary: Array<{ autopilot?: string; events?: number; upkeep?: { notes: number; errors: number }; error?: string }> = [];
  const failures: string[] = [];
  const { data: books, error: bookError } = await supabase.from('autopilot_positions').select('user_id, mode').eq('status', 'open');
  if (bookError) return NextResponse.json({ error: 'Cannot determine which Autopilot positions need management' }, { status: 500 });
  for (const settings of rows ?? []) {
    const entry: (typeof summary)[number] = {};
    const wallet = (() => { try { return hlClientFromSettings(settings); } catch { return null; } })();

    const cfg = configFromSettings(settings);
    const modes = new Set<Mode>();
    if (settings.autopilot_enabled) modes.add(cfg.mode);
    for (const book of books ?? []) {
      if (book.user_id === settings.user_id) modes.add(book.mode === 'live' ? 'live' : 'paper');
    }
    for (const mode of modes) {
      try {
        // Paper mode only reads public prices, so it needs no wallet.
        const hl = mode === 'paper' ? marketDataClient() : wallet;
        if (!hl) throw new Error('No wallet connected');
        const result = await runAutopilot(hl, supabase, settings.user_id, { ...cfg, mode }, Date.now(), async () => {
          const { data: current, error } = await supabase.from('settings').select('*').eq('user_id', settings.user_id).single();
          if (error || !current || current.updated_at !== settings.updated_at) throw new Error('Trading settings changed during scan. The next scan will use the new settings.');
          const manageOnly = current.autopilot_enabled !== true || mode !== cfg.mode;
          return { ...cfg, mode, manageOnly, symbols: manageOnly ? [] : cfg.symbols, checkEntries: async () => {
            const latest = await supabase.from('settings').select('updated_at, autopilot_enabled').eq('user_id', settings.user_id).single();
            return !latest.error && latest.data.autopilot_enabled === true && latest.data.updated_at === current.updated_at;
          } };
        });
        entry.autopilot = result.mode; entry.events = (entry.events ?? 0) + result.events.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[autopilot]', message);
        await supabase.from('autopilot_events').insert({ user_id: settings.user_id, mode, level: 'error', message: `Scan failed: ${message}` });
        await notify(`Autopilot scan FAILED: ${message}`, undefined, settings.user_id);
        entry.error = message; failures.push(message);
      }
    }

    if (wallet) {
      const upkeep = await runUpkeep(wallet, supabase, settings);
      entry.upkeep = { notes: upkeep.notes.length, errors: upkeep.errors.length };
      if (upkeep.errors.length) console.error('[upkeep]', upkeep.errors.join(' | '));
    }
    if (entry.autopilot || entry.upkeep || entry.error) summary.push(entry);
  }

  await heartbeat(supabase, 'scan', failures.length === 0, failures.join(' | ') || null);
  await alertOnStalePeers(supabase, 'scan');
  return NextResponse.json({ ran: summary.length, results: summary });
}
