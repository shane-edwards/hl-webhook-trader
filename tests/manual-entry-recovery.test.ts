// A manual market entry writes an intent before it sends anything. These tests cover the entry's own
// bookkeeping of that intent, and the scan finishing an entry whose request died partway:
// recorded and stopped when the exchange shows it filled, left alone when it does not.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { memoryDb, SimExchange } from './helpers';
import { openPosition } from '../lib/execution';
import { ENTRY_RECOVERY_AFTER_MS, recoverManualEntries } from '../lib/entry-recovery';
import { runFastPass, runUpkeep } from '../lib/upkeep';

const USER = '00000000-0000-4000-8000-000000000024';
const entry = { userId: USER, symbol: 'BTC', side: 'long' as const, leverage: 2, slippagePercent: 1, source: 'manual' as const, closeIfUnprotected: true };
const settings = { user_id: USER, slippage_percent: 1, daily_summary_enabled: false };
const stops = (ex: SimExchange) => ex.resting('BTC', 'sl').map(o => [o.px, o.size]);
type Row = Record<string, unknown>;
type RawDb = { from: (table: string) => Record<string, unknown>; rpc: unknown };

/** Stands in for the exchange's fill history, which is read over HTTP. */
function fillHistory(t: TestContext) {
  const fills: Row[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    let body: { type?: string; startTime?: number } = {};
    try { body = JSON.parse(String(init?.body)); } catch { /* an alert, not the exchange */ }
    return Response.json(body.type === 'userFillsByTime' ? fills.filter(f => Number(f.time) >= Number(body.startTime)) : []);
  });
  return fills;
}

/** An intent as the entry leaves it when its request dies: written two minutes before `now` and still 'sending'. */
function interrupted(ex: SimExchange, now: number, over: Row = {}): Row {
  const created = new Date(now - 120_000).toISOString();
  return {
    id: 'intent-1', user_id: USER, account_resource: `testnet:${ex.address}`, symbol: 'BTC', side: 'long', size_usd: 500, leverage: 2,
    stop_loss_pct: 2, take_profit_pct: null, exit: null, payload: { journal: { note: 'from the ticket' } }, slippage_percent: 1,
    status: 'sending', detail: null, created_at: created, updated_at: created, ...over,
  };
}

/** The order that went out before the request died: it fills on the exchange and appears in its history. */
async function lostFill(ex: SimExchange, fills: Row[], intent: Row, sizeUsd = 500) {
  const sent = await ex.placeMarketOrder({ coin: 'BTC', isBuy: intent.side === 'long', sizeUsd });
  fills.push({ coin: 'BTC', px: String(sent.fillPrice), sz: String(sent.sizeInContracts), time: Date.parse(String(intent.created_at)) + 1_500,
    oid: Number(sent.orderId), dir: intent.side === 'long' ? 'Open Long' : 'Open Short', closedPnl: '0', fee: '0.2' });
  return sent;
}

/** The database with one table answering every request with `error`. */
function brokenTable(db: unknown, name: string, error: { code?: string; message: string }) {
  const raw = db as RawDb;
  const broken = () => {
    const q: Record<string, unknown> = { then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error }).then(ok) };
    for (const m of ['select', 'insert', 'update', 'eq', 'lt', 'order', 'limit']) q[m] = () => q;
    q.single = q.maybeSingle = async () => ({ data: null, error });
    return q;
  };
  return { rpc: raw.rpc, from: (table: string) => (table === name ? broken() : raw.from(table)) } as never;
}

/** The database with its next `count` trade inserts failing, as when the journal is briefly unavailable. */
function failingTradeInserts(db: unknown, count: number) {
  const raw = db as RawDb;
  const refused = { select: () => ({ single: async () => ({ data: null, error: { message: 'write unavailable' } }) }) };
  return { rpc: raw.rpc, from: (table: string) => {
    const q = raw.from(table);
    return table === 'trades' ? { ...q, insert: (row: Row) => (count-- > 0 ? refused : (q.insert as (r: Row) => unknown)(row)) } : q;
  } } as never;
}

// ---------------------------------------------------------------- the entry keeps its own intent
test('a manual entry writes its intent before the order and closes it once the trade is recorded and stopped', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  const send = ex.placeMarketOrder.bind(ex);
  ex.placeMarketOrder = async (p) => {
    assert.equal(tables.entry_intents?.[0]?.status, 'sending', 'the intent is written before anything is sent');
    return send(p);
  };
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: 4, exit: { trailPct: null }, payload: { journal: { note: 'x' } } });
  ex.placeMarketOrder = send;
  assert.equal(tables.entry_intents.length, 1);
  const intent = tables.entry_intents[0];
  assert.equal(intent.status, 'done');
  assert.deepEqual([intent.user_id, intent.account_resource, intent.symbol, intent.side, intent.size_usd, intent.leverage, intent.stop_loss_pct, intent.take_profit_pct, intent.slippage_percent],
    [USER, `testnet:${ex.address}`, 'BTC', 'long', 1_000, 2, 2, 4, 1]);
  assert.deepEqual(intent.payload, { journal: { note: 'x' } });
  assert.deepEqual(stops(ex), [[98, 10]]);

  // An entry whose stop fails is closed by the entry itself: nothing is left for the scan either.
  ex.rejectStops = true;
  const unprotected = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: 1, takeProfitPct: null });
  assert.equal(unprotected.closedUnprotected, true);
  assert.equal(ex.positions.size, 0);
  assert.equal(tables.entry_intents[1].status, 'done');

  // Webhook and Autopilot entries have their own recovery and write no intent.
  ex.rejectStops = false;
  await openPosition(ex.client, db, { ...entry, source: 'webhook', sizeUsd: 500, stopLossPct: 2, takeProfitPct: null });
  await openPosition(ex.client, db, { ...entry, source: 'autopilot', sizeUsd: 500, stopLossPct: 2, takeProfitPct: null });
  assert.equal(tables.entry_intents.length, 2);

  // With every intent closed the scan has nothing to do.
  assert.deepEqual(await recoverManualEntries(ex.client, db, USER, Date.now() + 10 * ENTRY_RECOVERY_AFTER_MS), { notes: [], errors: [] });
});

test('an order that is refused or does not fill leaves the intent failed, not waiting', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  ex.placeMarketOrder = async () => { throw new Error('Order did not fill: {"resting":{}}'); };
  await assert.rejects(openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null }), /did not fill/);
  assert.equal(tables.entry_intents[0].status, 'failed');
  assert.match(String(tables.entry_intents[0].detail), /did not go through: Order did not fill/);
  assert.equal(tables.trades, undefined);
});

test('before migration 024 the entry still works; any other failure to write the intent refuses it with nothing sent', async (t) => {
  fillHistory(t);
  for (const missing of [
    { code: '42P01', message: 'relation "public.entry_intents" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.entry_intents' in the schema cache" },
  ]) {
    const ex = new SimExchange({ BTC: 100 });
    const memory = memoryDb();
    const db = brokenTable(memory.db, 'entry_intents', missing);
    const opened = await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
    assert.equal(opened.protectionError, null, missing.code);
    assert.equal(memory.tables.trades.length, 1);
    assert.deepEqual(stops(ex), [[98, 10]]);
    // The scans are just as quiet about a table that is not there yet.
    assert.deepEqual((await runFastPass(ex.client, db, settings, Date.now() + 200_000)).errors, []);
    assert.deepEqual((await runUpkeep(ex.client, db, settings, Date.now() + 200_000)).errors, []);
  }

  const ex = new SimExchange({ BTC: 100 });
  const memory = memoryDb();
  let sent = 0;
  const send = ex.placeMarketOrder.bind(ex);
  ex.placeMarketOrder = async (p) => { sent++; return send(p); };
  const db = brokenTable(memory.db, 'entry_intents', { code: '42501', message: 'permission denied for table entry_intents' });
  await assert.rejects(openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null }), /nothing was sent: permission denied/);
  assert.equal(sent, 0);
  assert.equal(ex.positions.size, 0);
  assert.equal(memory.tables.trades, undefined);
  // And the scan reports that it cannot read the intents rather than passing over them.
  assert.match((await runFastPass(ex.client, db, settings)).errors.join(' '), /manual entry recovery: permission denied/);
});

// ---------------------------------------------------------------- the scan finishes an interrupted entry
test('filled but never recorded: the scan writes the trade from the fills and rests a verified stop for the whole position', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  // An earlier, complete entry: 10 BTC at 100 with its stop at 98.
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  ex.move('BTC', 110);
  // The request for a second entry dies after its order filled and before anything was recorded.
  const now = Date.now() + 500_000;
  const intent = interrupted(ex, now, { size_usd: 550, stop_loss_pct: 3 });
  tables.entry_intents.push(intent);
  const sent = await lostFill(ex, fills, intent, 550);
  assert.equal(ex.positions.get('BTC')!.size, 15);
  assert.deepEqual(stops(ex), [[98, 10]], 'the new 5 BTC has no stop');

  // Too soon: the request could still be running.
  const early = await runFastPass(ex.client, db, settings, Date.parse(String(intent.created_at)) + ENTRY_RECOVERY_AFTER_MS - 1_000);
  assert.deepEqual([early.notes, early.errors], [[], []]);
  assert.equal(intent.status, 'sending');
  assert.equal(tables.trades.length, 1);

  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.equal(out.notes.length, 1);
  assert.match(out.notes[0], /BTC: an interrupted manual long entry had filled: the trade \(5 BTC at 110\) was recorded from the exchange fills, and a stop-loss at 100\.2333 now covers the whole position/);
  // The missing record, with the exchange's own order id, size and price.
  assert.equal(tables.trades.length, 2);
  const row = tables.trades[1];
  assert.deepEqual([row.user_id, row.symbol, row.side, row.status, row.entry_price, row.size, row.size_usd, row.leverage, row.signal_source, row.hyperliquid_order_id, row.order_type],
    [USER, 'BTC', 'long', 'open', 110, 5, 550, 2, 'manual', sent.orderId, 'market']);
  assert.equal(row.entry_time, new Date(Number(fills[0].time)).toISOString());
  assert.deepEqual(row.webhook_payload, { journal: { note: 'from the ticket' } });
  // One stop, 3% under the average entry of the whole 15 BTC, seen resting; the old one is gone.
  const average = (10 * 100 + 5 * 110) / 15;
  assert.equal(stops(ex).length, 1);
  assert.ok(Math.abs(stops(ex)[0][0] - average * 0.97) < 1e-9);
  assert.equal(stops(ex)[0][1], 15);
  assert.equal(intent.status, 'recovered');
  assert.match(String(intent.detail), /recorded from the exchange fills/);

  // Reported once: later scans neither repeat it nor write the trade again.
  const again = await runUpkeep(ex.client, db, settings, now + 10_000);
  assert.deepEqual([again.notes, again.errors], [[], []]);
  assert.equal(tables.trades.length, 2);
  assert.equal(stops(ex).length, 1);
});

test('a sliced entry and a trailing-only ticket are recovered the same way', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now, { side: 'short', size_usd: 1_000, stop_loss_pct: null, exit: { trailPct: 2 } });
  const { db, tables } = memoryDb({ entry_intents: [intent] });
  const first = await lostFill(ex, fills, intent, 500);
  ex.prices.set('BTC', 102);
  await lostFill(ex, fills, intent, 510);
  const out = await runUpkeep(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.equal(tables.trades.length, 1);
  assert.deepEqual([tables.trades[0].size, tables.trades[0].entry_price, tables.trades[0].hyperliquid_order_id, tables.trades[0].order_type], [10, 101, first.orderId, 'sliced']);
  // The trailing stop is the stop: one trail-distance above the short's average entry, with a plan so the scan moves it.
  assert.equal(stops(ex).length, 1);
  assert.ok(Math.abs(stops(ex)[0][0] - 101 * 1.02) < 1e-9);
  assert.equal(stops(ex)[0][1], 10);
  assert.equal(tables.position_plans.filter(p => p.status === 'active').length, 1);
  assert.equal(intent.status, 'recovered');
});

test('recorded but not yet stopped: only the protection step is run; an entry that was already stopped is just closed off', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now, { take_profit_pct: 5 });
  const { db, tables } = memoryDb({ entry_intents: [intent], trades: [] });
  const sent = await lostFill(ex, fills, intent);
  tables.trades.push({ id: 'recorded', user_id: USER, symbol: 'BTC', side: 'long', status: 'open', entry_price: 100, size: 5, leverage: 2,
    entry_time: new Date(Number(fills[0].time)).toISOString(), signal_source: 'manual', hyperliquid_order_id: sent.orderId });

  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.match(out.notes[0], /the trade was already recorded, and a stop-loss at 98 now covers the whole position/);
  assert.equal(tables.trades.length, 1);
  assert.deepEqual(stops(ex), [[98, 5]]);
  assert.deepEqual(ex.resting('BTC', 'tp').map(o => [o.px, o.size]), [[105, 5]]);
  assert.equal(intent.status, 'recovered');

  // The request died after its stop was resting: nothing is placed again and nothing is reported.
  intent.status = 'sending';
  const placed = ex.orders.length;
  const quiet = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual([quiet.notes, quiet.errors], [[], []]);
  assert.equal(ex.orders.length, placed);
  assert.equal(intent.status, 'done');
});

test('nothing filled: the intent fails and nothing on the exchange or in the trade log is touched', async (t) => {
  fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const { db, tables } = memoryDb({ entry_intents: [intent] });
  for (const method of ['placeMarketOrder', 'closePosition', 'placeTriggerOrders', 'placeProtectiveOrders', 'cancelOrders', 'cancelProtectiveOrders'] as const) {
    ex[method] = (async () => { throw new Error(`${method} must not be called`); }) as never;
  }
  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.notes, ['BTC: an interrupted manual long entry did not fill: nothing was opened and nothing was changed']);
  assert.equal(intent.status, 'failed');
  assert.match(String(intent.detail), /nothing was opened/);
  assert.equal(ex.orders.length, 0);
  assert.equal(tables.trades.length, 0);
});

test("the owner's own position is never adopted or closed: no intent, an intent with no fill of its own, or another wallet's intent", async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const { db, tables } = memoryDb({ entry_intents: [], trades: [] });
  // Opened by the owner on Hyperliquid, with a stop of their own.
  const own = await ex.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 2_000 });
  await ex.placeProtectiveOrders({ coin: 'BTC', side: 'long', size: 20, stopLossPx: 90 });
  const untouched = () => {
    assert.deepEqual(ex.positions.get('BTC'), { side: 'long', size: 20, entryPrice: 100 });
    assert.deepEqual(stops(ex), [[90, 20]]);
    assert.equal(ex.orders.length, 1);
    assert.equal(tables.trades.length, 0);
  };
  for (const method of ['closePosition', 'placeTriggerOrders', 'cancelOrders', 'cancelProtectiveOrders'] as const) {
    ex[method] = (async () => { throw new Error(`${method} must not be called`); }) as never;
  }

  // No intent at all.
  assert.deepEqual(await runFastPass(ex.client, db, settings, now), { notes: [], errors: [] });
  untouched();

  // An intent for the same market and side whose order never filled. The owner's fills are in the history:
  // one from before the intent, and one from long after its request had ended.
  const intent = interrupted(ex, now);
  const created = Date.parse(String(intent.created_at));
  tables.entry_intents.push(intent);
  fills.push({ coin: 'BTC', px: '100', sz: '15', time: created - 4_000, oid: Number(own.orderId), dir: 'Open Long', closedPnl: '0', fee: '0' },
    { coin: 'BTC', px: '100', sz: '5', time: created + 80_000, oid: 77, dir: 'Open Long', closedPnl: '0', fee: '0' },
    { coin: 'BTC', px: '100', sz: '1', time: created + 2_000, oid: 78, dir: 'Open Short', closedPnl: '0', fee: '0' },
    { coin: 'ETH', px: '100', sz: '1', time: created + 2_000, oid: 79, dir: 'Open Long', closedPnl: '0', fee: '0' });
  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.match(out.notes[0], /did not fill: nothing was opened and nothing was changed/);
  assert.equal(intent.status, 'failed');
  assert.match(String(intent.detail), /The open position was not opened by it and was left alone/);
  untouched();

  // A fill inside the window that belongs to a resting limit entry is not this entry's either.
  const second = interrupted(ex, now, { id: 'intent-2' });
  tables.entry_intents.push(second);
  tables.pending_orders = [{ id: 'limit', user_id: USER, symbol: 'BTC', side: 'long', oid: '4242', status: 'resting', created_at: new Date(created - 3_600_000).toISOString() }];
  fills.push({ coin: 'BTC', px: '100', sz: '2', time: created + 3_000, oid: 4242, dir: 'Open Long', closedPnl: '0', fee: '0' });
  await recoverManualEntries(ex.client, db, USER, now);
  assert.equal(second.status, 'failed');
  untouched();

  // An intent written for another wallet or network cannot be judged from this one. Nothing on this account
  // is touched; the intent is closed with one alert, so it does not keep waking the scan.
  const other = interrupted(ex, now, { id: 'intent-3', account_resource: 'mainnet:0x00000000000000000000000000000000000000ff' });
  tables.entry_intents.push(other);
  fills.push({ coin: 'BTC', px: '100', sz: '5', time: created + 1_000, oid: 80, dir: 'Open Long', closedPnl: '0', fee: '0' });
  const elsewhere = await recoverManualEntries(ex.client, db, USER, now);
  assert.deepEqual(elsewhere.notes, []);
  assert.equal(elsewhere.errors.length, 1);
  assert.match(elsewhere.errors[0], /different wallet or network.*Check that account on Hyperliquid by hand/);
  assert.equal(other.status, 'failed');
  untouched();
  assert.deepEqual(await recoverManualEntries(ex.client, db, USER, now), { notes: [], errors: [] }, 'reported once');
});

test('a fill stamped just before the intent, by a clock slightly behind, is still recognised as its own', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const created = Date.parse(String(intent.created_at));
  const { db, tables } = memoryDb({ entry_intents: [intent], trades: [] });
  const sent = await lostFill(ex, fills, intent);
  fills[0].time = created - 1_200;
  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.equal(intent.status, 'recovered');
  assert.equal(tables.trades.length, 1);
  assert.equal(tables.trades[0].hyperliquid_order_id, sent.orderId);
  assert.equal(stops(ex).length, 1);

  // A manual entry recorded before a later intent was written is that entry's, however close in time.
  const later = interrupted(ex, now, { id: 'intent-2', created_at: new Date(created + 500).toISOString() });
  tables.entry_intents.push(later);
  tables.trades[0].created_at = new Date(created - 1_000).toISOString();
  const resting = stops(ex);
  await recoverManualEntries(ex.client, db, USER, now);
  assert.equal(later.status, 'failed');
  assert.equal(tables.trades.length, 1);
  assert.deepEqual(stops(ex), resting);
});

test('filled and already closed again: nothing is added and the intent is closed with the reason', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const { db, tables } = memoryDb({ entry_intents: [intent], trades: [] });
  await lostFill(ex, fills, intent);
  await ex.closePosition('BTC'); // e.g. the client closing a fill whose answer never arrived
  fills.push({ coin: 'BTC', px: '100', sz: '5', time: Number(fills[0].time) + 16_000, oid: 9, dir: 'Close Long', closedPnl: '0', fee: '0.2' });
  const out = await runFastPass(ex.client, db, settings, now);
  assert.deepEqual(out.errors, []);
  assert.match(out.notes[0], /had filled, and its position is already closed on the exchange\. It is not in the trade log/);
  assert.equal(intent.status, 'recovered');
  assert.match(String(intent.detail), /no longer open on the exchange/);
  assert.equal(tables.trades.length, 0);
  assert.equal(ex.orders.length, 0);
});

test('the stop cannot be placed during recovery: the position is closed; if that fails too the account flatten is requested', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const { db, tables } = memoryDb({ entry_intents: [intent], settings: [{ user_id: USER, trading_halted: false, flatten_pending: false }] });
  await lostFill(ex, fills, intent);
  ex.rejectStops = true;
  const out = await runFastPass(ex.client, db, settings, now);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /recorded from the exchange fills, and its stop-loss could not be placed \(Stop-loss rejected: simulated\), so the position was CLOSED AT ONCE/);
  assert.equal(ex.positions.size, 0, 'flat again');
  assert.equal(tables.trades.length, 1);
  assert.equal(tables.trades[0].status, 'closed');
  assert.match(String(tables.trades[0].notes), /stop-loss could not be placed/);
  assert.equal(intent.status, 'recovered');
  assert.equal(tables.settings[0].flatten_pending, false);

  // Neither stopped nor closed: the same last resort as a normal entry.
  const ex2 = new SimExchange({ BTC: 100 });
  const intent2 = interrupted(ex2, now);
  const second = memoryDb({ entry_intents: [intent2], settings: [{ user_id: USER, trading_halted: false, flatten_pending: false }] });
  fills.length = 0;
  await lostFill(ex2, fills, intent2);
  ex2.rejectStops = true;
  ex2.closePosition = async () => { throw new Error('exchange unreachable'); };
  const failed = await runFastPass(ex2.client, second.db, settings, now);
  assert.match(failed.errors[0], /could NOT be placed: .*could NOT be closed either \(exchange unreachable\).*Trading is halted/);
  assert.equal(second.tables.settings[0].trading_halted, true);
  assert.equal(second.tables.settings[0].flatten_pending, true);
  assert.equal(intent2.status, 'recovered');
  assert.equal(ex2.positions.size, 1);
});

test('filled, the record failed and so did the close: the emergency stop holds until the scan records the trade and places the real protection', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const memory = memoryDb({ settings: [{ user_id: USER, trading_halted: false, flatten_pending: false }] });
  const db = failingTradeInserts(memory.db, 2); // the insert and its retry without the newer columns
  const close = ex.closePosition.bind(ex);
  let closeFails = true;
  ex.closePosition = async (coin) => { if (closeFails) { closeFails = false; throw new Error('exchange unreachable'); } return close(coin); };

  await assert.rejects(openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: null, takeProfitPct: null, exit: { trailPct: 3 } }),
    /could not be recorded: write unavailable\. Emergency protection was placed/);
  const intent = memory.tables.entry_intents[0];
  assert.equal(intent.status, 'sending', 'left for the scan: the position is open with no record');
  assert.deepEqual(stops(ex), [[98, 10]], 'the emergency stop');
  assert.equal(memory.tables.trades.length, 0);

  const order = String(ex.orders[0].oid - 1); // the entry's order id, one before its emergency stop
  fills.push({ coin: 'BTC', px: '100', sz: '10', time: Date.parse(String(intent.created_at)) + 400, oid: Number(order), dir: 'Open Long', closedPnl: '0', fee: '0.4' });
  const out = await runFastPass(ex.client, db, settings, Date.now() + 120_000);
  assert.deepEqual(out.errors, []);
  assert.equal(memory.tables.trades.length, 1);
  assert.equal(memory.tables.trades[0].hyperliquid_order_id, order);
  assert.deepEqual(stops(ex), [[97, 10]], 'the ticket asked for a 3% trailing stop; the emergency stop is replaced');
  assert.equal(memory.tables.position_plans.filter(p => p.status === 'active').length, 1);
  assert.equal(intent.status, 'recovered');

  // Had the close worked, the entry is over and the intent says so at once.
  const ex2 = new SimExchange({ BTC: 100 });
  const second = memoryDb();
  await assert.rejects(openPosition(ex2.client, failingTradeInserts(second.db, 2), { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null }), /The position was closed immediately/);
  assert.equal(second.tables.entry_intents[0].status, 'failed');
  assert.match(String(second.tables.entry_intents[0].detail), /could not be recorded \(write unavailable\)\. The position was closed immediately/);
  assert.equal(ex2.positions.size, 0);
});

test('a trade that cannot be recorded during recovery is still stopped, and reported once', async (t) => {
  const fills = fillHistory(t);
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const memory = memoryDb({ entry_intents: [intent] });
  const db = failingTradeInserts(memory.db, Infinity);
  await lostFill(ex, fills, intent);
  const out = await runFastPass(ex.client, db, settings, now);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /the trade could NOT be recorded \(write unavailable\): add it to the journal by hand, and a stop-loss at 98 now covers the whole position/);
  assert.deepEqual(stops(ex), [[98, 5]]);
  assert.equal(intent.status, 'recovered');
  assert.deepEqual(await runFastPass(ex.client, db, settings, now + 10_000), { notes: [], errors: [] });
});

test('an exchange that cannot be read leaves the intent waiting and the position alone', async (t) => {
  const ex = new SimExchange({ BTC: 100 });
  const now = Date.now();
  const intent = interrupted(ex, now);
  const { db, tables } = memoryDb({ entry_intents: [intent], trades: [] });
  await ex.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 500 });
  t.mock.method(globalThis, 'fetch', async () => new Response('Bad Gateway', { status: 502 }));
  const out = await runFastPass(ex.client, db, settings, now);
  assert.match(out.errors.join(' '), /BTC: an interrupted manual entry could not be checked \(Hyperliquid info error 502.*The next scan tries again/);
  assert.equal(intent.status, 'sending');
  assert.equal(ex.positions.get('BTC')!.size, 5);
  assert.equal(ex.orders.length, 0);
  assert.equal(tables.trades.length, 0);
});

// ---------------------------------------------------------------- the migration
test('migration 024 applies on top of the earlier ones, is server-only, and running it twice changes nothing', async () => {
  const pg = new PGlite({ extensions: { uuid_ossp } });
  const user = '00000000-0000-4000-8000-000000000001';
  const migration = readFileSync('supabase/migrations/024_entry_intents.sql', 'utf8');
  try {
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
      CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text PRIMARY KEY, command text);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.job VALUES ($1,$3) ON CONFLICT(jobname) DO UPDATE SET command=excluded.command RETURNING 1::bigint $$;
      INSERT INTO cron.job VALUES ('hl-autopilot', 'SELECT 1;');
    `);
    const earlier = readdirSync('supabase/migrations').filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '024').sort();
    assert.equal(earlier.at(-1), '023_server_only_writes.sql');
    for (const file of earlier) await pg.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
    await pg.query('INSERT INTO auth.users VALUES ($1)', [user]);
    const fast = async () => (await pg.query<{ command: string }>("SELECT command FROM cron.job WHERE jobname='hl-fast'")).rows[0]?.command;
    const before = await fast();
    assert.ok(before && !before.includes('entry_intents'));

    await pg.exec(migration);
    const once = await fast();
    assert.equal(once, before!.replace(/;\s*$/, '') + " OR EXISTS (SELECT 1 FROM public.entry_intents WHERE status='sending');");
    await pg.exec(migration);
    assert.equal(await fast(), once, 'the wake condition is not added a second time');

    // The schedule's own query runs, and wakes for an intent that is still being sent.
    const wakes = async () => (await pg.query(once!)).rows.length;
    assert.equal(await wakes(), 0);
    await pg.query(`INSERT INTO entry_intents(user_id, account_resource, symbol, side, size_usd, leverage, stop_loss_pct, exit, slippage_percent)
      VALUES ($1, 'testnet:0x1', 'BTC', 'long', 500, 2, 2.5, '{"trailPct":2}', 1)`, [user]);
    assert.equal(await wakes(), 1);
    const row = (await pg.query<{ status: string; detail: string | null; exit: { trailPct: number } }>('SELECT status, detail, exit FROM entry_intents')).rows[0];
    assert.deepEqual([row.status, row.detail, row.exit.trailPct], ['sending', null, 2]);
    await pg.exec("UPDATE entry_intents SET status='recovered', detail='x'");
    assert.equal(await wakes(), 0);
    await assert.rejects(pg.exec("UPDATE entry_intents SET status='lost'"), /check constraint/);
    await assert.rejects(pg.query(`INSERT INTO entry_intents(user_id, account_resource, symbol, side, size_usd, leverage, slippage_percent)
      VALUES ($1, 'testnet:0x1', 'BTC', 'flat', 500, 2, 1)`, [user]), /check constraint/);

    // Server only: row security on, nothing for the browser roles, everything for the service role.
    const secured = await pg.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_class WHERE oid='public.entry_intents'::regclass");
    assert.equal(secured.rows[0].on, true);
    const can = async (role: string, privilege: string) =>
      (await pg.query<{ ok: boolean }>('SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.entry_intents', privilege])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await can(role, privilege), false, `${role} ${privilege}`);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await can('service_role', privilege), true, privilege);
    // The row from the first run survived the second.
    assert.equal((await pg.query('SELECT 1 FROM entry_intents')).rows.length, 1);

    // With no fast job scheduled the block does nothing, and creates none.
    await pg.exec("DELETE FROM cron.job WHERE jobname='hl-fast'");
    await pg.exec(migration);
    assert.equal(await fast(), undefined);
  } finally { await pg.close(); }
});
