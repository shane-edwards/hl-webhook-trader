// Finishes a manual market entry whose request died partway (a timeout, a crash,
// a deploy). The entry wrote an `entry_intents` row before it sent anything
// (lib/execution.ts); a row still marked 'sending' long after its request must
// have ended is worked out here from the exchange's own records: the position,
// the fills since the row was written, and the trade log.
//
// Only what the fills show this entry opened is ever touched. A position with no
// opening fill after the intent was opened by the owner on Hyperliquid, or by an
// earlier entry, and is left exactly as it is.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { getUserFills } from '@/lib/hyperliquid/public';
import { finishEntryIntent, insertTrade, isMissingTable, protectAfterFill } from '@/lib/execution';
import { accountResource } from '@/lib/trading-lock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * An intent is looked at only once its own request cannot still be running: the trade route is cut off after
 * 60 seconds and the trading lease it holds lapses after 90.
 */
export const ENTRY_RECOVERY_AFTER_MS = 90_000;
/** A fill later than this cannot be the intent's own: its request has ended, and an order expires 15 seconds after it is signed. */
export const ENTRY_FILL_WINDOW_MS = 75_000;
/**
 * The intent is stamped by the database and a fill by the exchange. A fill is accepted this long before the
 * intent's own time, so a small difference between the two clocks cannot hide a real fill and leave it unprotected.
 */
export const ENTRY_CLOCK_SLACK_MS = 2_000;

/** Entries still marked as being sent, for the fast scan to pick its accounts. Empty until migration 024 is applied. */
export async function entriesInFlight(db: Db): Promise<{ data: Array<{ user_id: string }>; error: { message: string } | null }> {
  const { data, error } = await db.from('entry_intents').select('user_id').eq('status', 'sending');
  return error && !isMissingTable(error) ? { data: [], error } : { data: data ?? [], error: null };
}

export interface EntryRecoveryResult { notes: string[]; errors: string[] }

/**
 * One pass over the account's interrupted manual entries. Call it under the trading lock, so no entry is in
 * flight while it reads the exchange. Each outcome is reported once: the intent leaves 'sending' with it.
 */
export async function recoverManualEntries(hl: HyperliquidClient, db: Db, userId: string, now = Date.now()): Promise<EntryRecoveryResult> {
  const out: EntryRecoveryResult = { notes: [], errors: [] };
  const { data, error } = await db.from('entry_intents').select('*').eq('user_id', userId)
    .eq('status', 'sending').lt('created_at', new Date(now - ENTRY_RECOVERY_AFTER_MS).toISOString()).order('created_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) return out;
    throw new Error(error.message);
  }
  const resource = accountResource(hl, userId);
  for (const intent of data ?? []) {
    if (intent.account_resource !== resource) {
      // Written for another wallet or network, which cannot be read from this one. Left waiting it would
      // wake the scan for ever, so it is closed with one alert and nothing on this account is touched.
      await finishEntryIntent(db, intent.id, 'failed', 'Sent from a different wallet or network than the one now connected: it could not be checked');
      out.errors.push(`${intent.symbol}: an interrupted manual ${intent.side} entry was sent from a different wallet or network than the one now connected, so it could not be checked. Check that account on Hyperliquid by hand`);
      continue;
    }
    try {
      await recoverEntry(hl, db, userId, intent, out);
    } catch (err) {
      // Left as 'sending': the next scan tries again.
      out.errors.push(`${intent.symbol}: an interrupted manual entry could not be checked (${err instanceof Error ? err.message : err}). The next scan tries again`);
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function recoverEntry(hl: HyperliquidClient, db: Db, userId: string, intent: Record<string, any>, out: EntryRecoveryResult): Promise<void> {
  const symbol: string = intent.symbol, side: 'long' | 'short' = intent.side;
  const created = new Date(intent.created_at).getTime();
  const what = `${symbol}: an interrupted manual ${side} entry`;
  const [{ fills, truncated }, position, rows, resting] = await Promise.all([
    getUserFills(hl.address, created - ENTRY_CLOCK_SLACK_MS, hl.isTestnet),
    hl.getPosition(symbol),
    // A minute of slack for the difference between this server's clock and the exchange's.
    db.from('trades').select('id, status, signal_source, hyperliquid_order_id, created_at').eq('user_id', userId).eq('symbol', symbol)
      .gte('entry_time', new Date(created - 60_000).toISOString()),
    db.from('pending_orders').select('oid').eq('user_id', userId).eq('symbol', symbol).order('created_at', { ascending: false }).limit(200),
  ]);
  if (rows.error) throw new Error(rows.error.message);
  if (truncated && fills[fills.length - 1].time < created + ENTRY_FILL_WINDOW_MS) throw new Error('the exchange fill history is incomplete');

  // Fills that belong to something else: a limit or chase entry resting on the exchange, an entry of another
  // kind with its own record, or a manual entry recorded before this intent was written.
  // (No pending-orders table yet means no such entries.)
  const others = new Set([
    ...(resting.data ?? []).map(r => String(r.oid)),
    ...(rows.data ?? []).filter(r => r.signal_source !== 'manual' || new Date(r.created_at).getTime() < created).map(r => String(r.hyperliquid_order_id)),
  ]);
  const opening = fills.filter(f => f.coin === symbol && f.time >= created - ENTRY_CLOCK_SLACK_MS && f.time < created + ENTRY_FILL_WINDOW_MS
    && f.dir.toLowerCase() === `open ${side}` && !others.has(f.oid));
  const held = position && position.side === side ? position : null;

  if (!opening.length) {
    // Nothing shows this entry filled. Whatever is open was not opened by it and is not ours to touch.
    await finishEntryIntent(db, intent.id, 'failed', `No fill from this order on the exchange: nothing was opened${held ? '. The open position was not opened by it and was left alone' : ''}`);
    out.notes.push(`${what} did not fill: nothing was opened and nothing was changed`);
    return;
  }
  const oids = new Set(opening.map(f => f.oid));
  const own = (rows.data ?? []).find(r => r.signal_source === 'manual' && oids.has(String(r.hyperliquid_order_id)));
  if (!held) {
    // Opened and already closed again (the failed-order recovery, the account flatten, a stop, or by hand).
    // An open record, if there is one, is settled from the fills by the reconcile; nothing is added here.
    await finishEntryIntent(db, intent.id, 'recovered', `Filled, and the position is no longer open on the exchange: nothing was left to protect${own ? '' : '. It was never recorded in the trade log'}`);
    out.notes.push(`${what} had filled, and its position is already closed on the exchange${own ? '' : '. It is not in the trade log: the fills are in the exchange history'}`);
    return;
  }
  if (own && own.status !== 'open') {
    await finishEntryIntent(db, intent.id, 'done', 'Recorded, and the trade has since been settled');
    return;
  }

  let record = 'the trade was already recorded';
  if (!own) {
    const size = opening.reduce((a, f) => a + f.sz, 0), price = opening.reduce((a, f) => a + f.px * f.sz, 0) / size;
    const stamp = new Date().toISOString();
    try {
      // The first fill's order id is the one the entry itself would have recorded, so the row cannot be written twice.
      await insertTrade(db, {
        user_id: userId, symbol, side, status: 'open', entry_price: price, size, size_usd: size * price,
        leverage: intent.leverage, entry_time: new Date(opening[0].time).toISOString(), signal_source: 'manual',
        webhook_payload: intent.payload ?? null, hyperliquid_order_id: opening[0].oid, created_at: stamp, updated_at: stamp,
        notes: 'Recorded from the exchange fills: the request that opened it was interrupted', order_type: oids.size > 1 ? 'sliced' : 'market',
      });
      record = `the trade (${size} ${symbol} at ${Number(price.toPrecision(7))}) was recorded from the exchange fills`;
    } catch (err) {
      // The stop matters more than the journal: carry on, and say so once.
      record = `the trade could NOT be recorded (${err instanceof Error ? err.message : err}): add it to the journal by hand`;
    }
  } else {
    // Recorded, so the request died during or after its protection step. A stop already covering the whole
    // position means that step finished; placing it again would reset a stop that has since been trailed.
    const covered = (await hl.getOpenOrders(symbol)).some(o => o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType)
      && o.side === (side === 'long' ? 'sell' : 'buy') && o.size >= held.size * 0.999);
    if (covered) {
      await finishEntryIntent(db, intent.id, 'done', 'Recorded and stopped: only the last step of the request was missing');
      return;
    }
  }

  // The same protection a normal entry gets, for the whole position: stop seen resting, or the position is closed.
  const num = (v: unknown) => (v == null ? null : Number(v));
  const p = await protectAfterFill(hl, db, {
    userId, symbol, side, slippagePercent: Number(intent.slippage_percent), stopLossPct: num(intent.stop_loss_pct),
    takeProfitPct: num(intent.take_profit_pct), exit: intent.exit ?? null, closeIfUnprotected: true,
  });
  const failedRecord = /could NOT be recorded/.test(record);
  let outcome: string;
  if (p.closedUnprotected) outcome = `its stop-loss could not be placed (${p.protectionError}), so the position was CLOSED AT ONCE`;
  else if (p.protectionError) outcome = `its stop or target could NOT be placed: ${p.protectionError}`;
  else outcome = p.stopLossPx != null ? `a stop-loss at ${Number(p.stopLossPx.toPrecision(7))} now covers the whole position` : 'it asked for no stop-loss';
  const line = `${what} had filled: ${record}, and ${outcome}${p.exitWarning ? `. ${p.exitWarning}` : ''}`;
  await finishEntryIntent(db, intent.id, 'recovered', line);
  (p.protectionError || failedRecord ? out.errors : out.notes).push(line);
}
