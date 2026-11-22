// Per-account housekeeping run by the five-minute scan, after the Autopilot:
// limit entries, managed exits, reconciling the trade log with the exchange,
// and the once-a-day summary.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { managePending } from '@/lib/pending';
import { manageExits } from '@/lib/exits';
import { syncAccount } from '@/lib/reconcile';
import { dayStartEquity } from '@/lib/risk/portfolio';
import { notify } from '@/lib/notify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

const usd = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

export interface SummaryInput {
  day: string; equity: number; dayStartEquity: number | null;
  positions: Array<{ symbol: string; side: string; size: number; entryPrice: number; unrealizedPnl: number }>;
  closedTrades: Array<{ symbol: string; side: string; pnl: number | null; net_pnl?: number | null }>;
  autopilotEvents: Array<{ level: string; symbol: string | null; message: string }>;
  autopilot: { enabled: boolean; mode: string; paperEquity: number | null };
}

/** The daily summary as plain text. Pure, so the wording can be tested. */
export function buildDailySummary(s: SummaryInput): string {
  const lines = [`Daily summary for ${s.day} (UTC)`];
  const dayPnl = s.dayStartEquity != null && s.dayStartEquity > 0 ? s.equity - s.dayStartEquity : null;
  lines.push(`Account value: ${usd(s.equity)}` + (dayPnl != null ? ` (${dayPnl >= 0 ? '+' : ''}${usd(dayPnl)} on the day, ${((dayPnl / s.dayStartEquity!) * 100).toFixed(2)}%; deposits and withdrawals count as change)` : ''));
  if (s.positions.length) {
    lines.push('Open positions:');
    for (const p of s.positions) lines.push(`  ${p.symbol} ${p.side} ${p.size} @ ${p.entryPrice}, unrealised ${usd(p.unrealizedPnl)}`);
  } else lines.push('Open positions: none');
  if (s.closedTrades.length) {
    const total = s.closedTrades.reduce((a, t) => a + Number(t.net_pnl ?? t.pnl ?? 0), 0);
    lines.push(`Trades closed: ${s.closedTrades.length}, total ${usd(total)} (after fees and funding where the exchange figures are in)`);
  } else lines.push('Trades closed: none');
  if (s.autopilot.enabled) {
    const acted = s.autopilotEvents.filter(e => e.level === 'trade' || e.level === 'error' || e.level === 'warn');
    const balance = s.autopilot.mode === 'paper' && s.autopilot.paperEquity != null ? `, paper balance ${usd(s.autopilot.paperEquity)}` : '';
    lines.push(`Autopilot (${s.autopilot.mode}${balance}):${acted.length ? '' : ' nothing to report'}`);
    for (const e of acted.slice(0, 12)) lines.push(`  ${e.symbol ? `${e.symbol} ` : ''}${e.message}`);
  } else lines.push('Autopilot: off');
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SettingsRow = Record<string, any>;

/** Sends yesterday's summary once, on the first scan of a new UTC day. */
async function maybeSendSummary(hl: HyperliquidClient, db: Db, settings: SettingsRow, now: number): Promise<boolean> {
  if (settings.daily_summary_enabled === false) return false;
  const userId: string = settings.user_id;
  const today = new Date(now).toISOString().slice(0, 10);
  const { data: state, error } = await db.from('portfolio_state').select('*').eq('user_id', userId).maybeSingle();
  if (error) return false; // migration 006 not run
  if (state && String(state.last_summary_day ?? '') === today) return false;

  const account = await hl.getAccountSummary();
  if (!state) {
    // First ever scan: start the clock, nothing to summarise yet.
    await dayStartEquity(db, userId, account.totalValue, now);
    await db.from('portfolio_state').update({ last_summary_day: today }).eq('user_id', userId);
    return false;
  }

  const since = new Date(now - 86_400_000).toISOString();
  const yesterday = since.slice(0, 10);
  const [positions, closed, events, auto] = await Promise.all([
    hl.getPositions(),
    db.from('trades').select('symbol, side, pnl, net_pnl').eq('user_id', userId).eq('status', 'closed').gte('exit_time', since),
    db.from('autopilot_events').select('level, symbol, message').eq('user_id', userId).gte('created_at', since).order('created_at', { ascending: true }),
    db.from('autopilot_state').select('paper_equity').eq('user_id', userId).eq('mode', 'paper').maybeSingle(),
  ]);
  const text = buildDailySummary({
    day: yesterday, equity: account.totalValue,
    // The stored day-start still belongs to yesterday until today's first entry check replaces it.
    dayStartEquity: String(state.day_key ?? '') === yesterday ? Number(state.day_start_equity) : null,
    positions, closedTrades: closed.data ?? [], autopilotEvents: events.data ?? [],
    autopilot: { enabled: settings.autopilot_enabled === true, mode: settings.autopilot_mode === 'live' ? 'live' : 'paper', paperEquity: auto.data ? Number(auto.data.paper_equity) : null },
  });
  await db.from('portfolio_state').update({ last_summary_day: today, day_key: today, day_start_equity: account.totalValue, updated_at: new Date(now).toISOString() }).eq('user_id', userId);
  return notify(text, `HL Trader daily summary, ${yesterday}`);
}

export interface UpkeepResult { notes: string[]; errors: string[] }

/**
 * The time-critical subset of the upkeep, run every few seconds while anything
 * is open: follow limit and chase entries, move managed stops, and settle a
 * trade record the moment its position disappears from the exchange.
 */
export async function runFastPass(hl: HyperliquidClient, db: Db, settings: SettingsRow, now = Date.now()): Promise<UpkeepResult> {
  const userId: string = settings.user_id;
  const out: UpkeepResult = { notes: [], errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { out.errors.push(`${name}: ${err instanceof Error ? err.message : err}`); }
  };
  const slippage = Number(settings.slippage_percent ?? 2);

  await step('limit orders', async () => {
    for (const e of await managePending(hl, db, userId, now, { slippagePercent: slippage })) (e.level === 'error' ? out.errors : out.notes).push(e.message);
  });
  await step('exit plans', async () => {
    for (const e of await manageExits(hl, db, userId, slippage)) (e.level === 'error' ? out.errors : out.notes).push(e.message);
  });
  await step('closed positions', async () => {
    // Only when a trade record has lost its position is the (heavier) reconcile worth running.
    const { data: open } = await db.from('trades').select('symbol, side, entry_time').eq('user_id', userId).eq('status', 'open');
    const settled = (open ?? []).filter(t => now - new Date(t.entry_time).getTime() > FAST_SETTLE_AFTER_MS);
    if (!settled.length) return;
    const held = new Map((await hl.getPositions()).map(p => [p.symbol, p.side]));
    if (settled.every(t => held.get(t.symbol) === t.side)) return;
    const r = await syncAccount(hl, db, userId, now, FAST_SETTLE_AFTER_MS);
    for (const n of r.notes) (n.startsWith('Reconcile failed') ? out.errors : out.notes).push(n);
  });

  const lines = [...out.errors.map(e => `ERROR ${e}`), ...out.notes];
  if (lines.length) await notify(lines.join('\n'));
  return out;
}

/** A fill reaches the exchange's history within a few seconds; wait this long before trusting its absence. */
const FAST_SETTLE_AFTER_MS = 20_000;

/** Everything the scan does for one account with a connected wallet. Each step is isolated: one failing does not stop the rest. */
export async function runUpkeep(hl: HyperliquidClient, db: Db, settings: SettingsRow, now = Date.now()): Promise<UpkeepResult> {
  const userId: string = settings.user_id;
  const out: UpkeepResult = { notes: [], errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (err) { out.errors.push(`${name}: ${err instanceof Error ? err.message : err}`); }
  };

  await step('limit orders', async () => {
    for (const e of await managePending(hl, db, userId, now, { slippagePercent: Number(settings.slippage_percent ?? 2) })) (e.level === 'error' ? out.errors : out.notes).push(e.message);
  });
  await step('exit plans', async () => {
    for (const e of await manageExits(hl, db, userId, Number(settings.slippage_percent ?? 2))) (e.level === 'error' ? out.errors : out.notes).push(e.message);
  });
  await step('reconcile', async () => {
    const r = await syncAccount(hl, db, userId, now);
    for (const n of r.notes) (n.startsWith('Reconcile failed') ? out.errors : out.notes).push(n);
  });
  await step('daily summary', async () => { await maybeSendSummary(hl, db, settings, now); });

  const lines = [...out.errors.map(e => `ERROR ${e}`), ...out.notes];
  if (lines.length) await notify(lines.join('\n'));
  return out;
}
