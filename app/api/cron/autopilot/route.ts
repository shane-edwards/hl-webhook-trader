import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings, marketDataClient } from '@/lib/hyperliquid/from-settings';
import { configFromSettings, runAutopilot, type Mode } from '@/lib/autopilot/run';
import { runUpkeep } from '@/lib/upkeep';
import { alertOnStalePeers, heartbeat } from '@/lib/health';
import { cronAuthorized } from '@/lib/cron-auth';
import { notify } from '@/lib/notify';
import { automationDecision, sameAutomationProfile, type AutomationDecision } from '@/lib/automation/policy';
import { controlledCryptoConfig, cryptoOpportunity } from '@/lib/automation/trading';
import { runStrategyForAccount, strategyCatchUpDue } from '@/lib/strategy/run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Daily-strategy catch-up: started only while this much of the scan's 60
// seconds is unused, and it waits this long for the account's trading lease.
const CATCH_UP_START_BY_MS = 35_000;
const CATCH_UP_LOCK_WAIT_MS = 10_000;

// The trading scan. Called every five minutes by a scheduler (see
// supabase/migrations/004_autopilot.sql). For each account it runs the
// Autopilot (if on), then looks after limit entries and managed exits, brings
// the trade log into line with the exchange, and sends the daily summary.
//
// Autopilot signals come from completed hourly candles, so scanning more often
// gains nothing there; stops rest on the exchange in between. A trailing or
// break-even stop, though, only moves when this runs.
//
// It also catches up the daily trend strategy: if today's run (job hl-strategy,
// 00:10 UTC) is missing or failed, the strategy is run from here, a few times
// a day at most.
export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const started = Date.now();

  const supabase = createServiceClient();
  const { data: rows, error } = await supabase.from('settings').select('*');
  if (error) {
    await notify(`HEALTH: the trading scan could not read the database (${error.message}). Check that the Supabase project is not paused.`);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summary: Array<{ autopilot?: string; events?: number; upkeep?: { notes: number; errors: number }; error?: string; strategy?: string }> = [];
  const failures: string[] = [];
  const { data: books, error: bookError } = await supabase.from('autopilot_positions').select('user_id, mode').eq('status', 'open');
  if (bookError) return NextResponse.json({ error: 'Cannot determine which Autopilot positions need management' }, { status: 500 });
  for (const settings of rows ?? []) {
    const entry: (typeof summary)[number] = {};
    const wallet = (() => { try { return hlClientFromSettings(settings); } catch { return null; } })();

    let policy: AutomationDecision;
    try { policy = await automationDecision(supabase, settings.user_id, 'crypto', (candidates, mode) => cryptoOpportunity(supabase, settings.user_id, candidates, mode)); }
    catch {
      policy = { decision: 'paused', detail: 'Could not verify automation settings', profile: null, candidate: null, results: null };
      failures.push(policy.detail);
    }
    const legacy = configFromSettings(settings);
    const controlled = controlledCryptoConfig(legacy, policy, process.env.HL_TESTNET === 'true' || settings.is_testnet === true);
    const cfg = controlled ?? legacy;
    const entries = !!controlled || (policy.decision === 'legacy' && settings.autopilot_enabled === true);
    const modes = new Set<Mode>();
    if (entries) modes.add(cfg.mode);
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
          const manageOnly = !entries || mode !== cfg.mode || !await sameAutomationProfile(supabase, policy.profile, settings.user_id, 'crypto');
          return { ...cfg, mode, manageOnly, symbols: manageOnly ? [] : cfg.symbols, checkEntries: async () => {
            const latest = await supabase.from('settings').select('updated_at, autopilot_enabled').eq('user_id', settings.user_id).single();
            return !latest.error && (!!controlled || latest.data.autopilot_enabled === true) && latest.data.updated_at === current.updated_at &&
              await sameAutomationProfile(supabase, policy.profile, settings.user_id, 'crypto');
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

    // Last, and on its own: nothing that goes wrong here may stop the scan.
    if (settings.strategy_enabled === true) {
      try {
        if (await strategyCatchUpDue(supabase, settings)) {
          if (Date.now() - started > CATCH_UP_START_BY_MS) {
            // No run is recorded, so the next scan tries again; a scan that is always this slow shows up in the heartbeat.
            entry.strategy = 'postponed';
            failures.push('Daily strategy catch-up postponed: the scan ran out of time');
          } else {
            // Records the run and sends the alert exactly as the daily job does.
            entry.strategy = (await runStrategyForAccount(supabase, settings, { lockWaitMs: CATCH_UP_LOCK_WAIT_MS })).status;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[strategy catch-up]', message);
        entry.strategy = 'failed';
        failures.push(`Daily strategy catch-up failed: ${message}`);
      }
    }
    if (entry.autopilot || entry.upkeep || entry.error || entry.strategy) summary.push(entry);
  }

  await heartbeat(supabase, 'scan', failures.length === 0, failures.join(' | ') || null);
  await alertOnStalePeers(supabase, 'scan');
  return NextResponse.json({ ran: summary.length, results: summary });
}
