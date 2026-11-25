import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EtoroError, type EtoroClient } from '../lib/stocks/etoro';
import { manageStockOrder } from '../lib/stocks/autopilot';
import { stockOrderAction, stockOrderInput } from '../lib/stocks/manual-orders';
import { memoryDb } from './helpers';

const start = Date.parse('2026-11-24T19:00:00Z');
const MINUTE = 60_000;
type Managed = Parameters<typeof manageStockOrder>[3];
type Position = { id: number; instrumentId: number; side: string; opened?: string };
const ORDER_ID = '00000000-0000-4000-8000-00000000000a';
const HOUR = 60 * 60_000;
// The cron route alerts on messages matching this pattern, so the tests read it from the route itself.
const alerts = new RegExp(readFileSync('app/api/cron/stock-autopilot/route.ts', 'utf8').match(/if \(\/(.+)\/\.test\(message\)\) await notify/)![1]);
const request = { action: 'open', transaction: 'buy', instrumentId: 456, orderType: 'mkt', amount: 100, orderCurrency: 'usd', settlementType: 'real', leverage: 1 } as const;

/** A filled order whose first close request gets no answer. `lookup` decides what eToro says about a reference. */
function exitFixture(lookup: (reference: string) => Promise<{ orderId: number }>, closeStatus?: () => Promise<unknown>) {
  let clock = start, portfolioOpen = true;
  const sent: string[] = [];
  const order: Managed = {
    id: 'order', environment: 'demo', connection_version: 'version', state: 'filled', position_ids: [123], request,
    strategy: 'breakout', signal_day: null, strategy_exit_at: new Date(start - 1).toISOString(), updated_at: new Date(start - 100).toISOString(),
    close_requests: {}, protection_state: null,
  };
  const { db, tables } = memoryDb({ etoro_stock_orders: [{ ...order, user_id: 'user' }] });
  const broker = {
    portfolio: async () => ({ positions: portfolioOpen ? [{ id: 123, instrumentId: 456, side: 'Long' }] : [], pending: 0 }),
    quotes: async () => [{ instrumentId: 456, date: new Date(clock).toISOString(), quoteType: 'realtime', bid: 49, ask: 50 }],
    closeStock: async (_id: number, _instrument: number, reference: string) => {
      sent.push(reference);
      if (sent.length === 1) throw new Error('Timed out before any response');
      return { orderForClose: { orderID: 55 } };
    },
    stockOrderStatus: lookup,
    stockCloseStatus: closeStatus ?? (async () => ({ orderID: 55, instrumentID: 456, statusID: 1, proceeds: 0, positions: [{ positionID: 123 }] })),
  } as unknown as EtoroClient;
  const snapshot = () => structuredClone(tables.etoro_stock_orders[0]) as unknown as Managed;
  return { sent, tables, snapshot, clock: () => clock, advance: (ms: number) => { clock += ms; }, flat: (flat = true) => { portfolioOpen = !flat; },
    scan: (connection = 'version') => manageStockOrder(db, broker, 'user', snapshot(), connection, '2026-11-23', clock) };
}

test('a close eToro has no record of is resent once with a fresh reference after 3 minutes and not before', async t => {
  const looked: string[] = [];
  const f = exitFixture(async reference => { looked.push(reference); throw new EtoroError(404); });
  t.mock.method(Date, 'now', f.clock);
  await f.scan();
  assert.equal(f.snapshot().close_attempts?.[123].state, 'uncertain');
  assert.equal(f.snapshot().close_attempts?.[123].sentAt, start);
  f.advance(MINUTE);
  assert.match(await f.scan(), /unconfirmed/);
  f.advance(2 * MINUTE - 1);
  assert.doesNotMatch(await f.scan(), /not received/);
  assert.equal(f.snapshot().close_attempts?.[123].state, 'uncertain');
  assert.equal(f.sent.length, 1);
  f.advance(1);
  const released = await f.scan();
  assert.match(released, /not received/);
  assert.match(released, alerts);
  assert.equal(f.snapshot().close_attempts?.[123].state, 'rejected');
  assert.equal(f.sent.length, 1);
  // The alert belongs to the scan that changed the state. Later scans only report the scheduled retry.
  f.advance(MINUTE);
  assert.doesNotMatch(await f.scan(), alerts);
  assert.equal(f.sent.length, 1);
  f.advance(MINUTE);
  await f.scan();
  assert.equal(f.sent.length, 2);
  assert.notEqual(f.sent[1], f.sent[0]);
  assert.deepEqual(looked, Array(3).fill(f.sent[0]));
  assert.deepEqual([f.snapshot().close_attempts?.[123].state, f.snapshot().close_attempts?.[123].count], ['submitted', 2]);
  assert.equal(f.snapshot().close_requests[123], f.sent[1]);
  f.advance(30 * MINUTE);
  await f.scan();
  assert.equal(f.sent.length, 2);
});

test('a close whose lookup cannot be answered keeps waiting and is never sent twice', async t => {
  for (const failure of [new Error('Timed out'), new EtoroError(503), new EtoroError(429)]) {
    const f = exitFixture(async () => { throw failure; });
    t.mock.method(Date, 'now', f.clock);
    await f.scan();
    for (let i = 0; i < 12; i++) {
      f.advance(5 * MINUTE);
      const message = await f.scan();
      assert.match(message, /unconfirmed/);
      assert.doesNotMatch(message, /not received/);
    }
    assert.equal(f.sent.length, 1);
    assert.equal(f.snapshot().close_attempts?.[123].state, 'uncertain');
    f.flat();
    f.advance(30 * MINUTE);
    assert.match(await f.scan(), /Waiting for eToro to resolve the exit reference/);
    assert.equal(f.tables.etoro_stock_orders[0].closed_at, undefined);
    t.mock.restoreAll();
  }
});

test('a position that left the portfolio with an exit reference eToro never received is closed as external after 15 minutes', async t => {
  for (const legacy of [false, true]) {
    const f = exitFixture(async () => { throw new EtoroError(404); });
    t.mock.method(Date, 'now', f.clock);
    await f.scan();
    const partial = { orderId: 54, quote: null, rate: 49, units: 1, complete: true };
    f.tables.etoro_stock_orders[0].close_execution = { '123:54': partial };
    // Rows saved before sentAt existed fall back to the row's updated_at.
    if (legacy) Object.assign(f.tables.etoro_stock_orders[0], { close_attempts: {}, updated_at: new Date(start).toISOString() });
    f.flat();
    f.advance(15 * MINUTE - 1);
    assert.match(await f.scan(), /Waiting for eToro to resolve the exit reference/);
    assert.equal(f.tables.etoro_stock_orders[0].closed_at, undefined);
    f.advance(1);
    const message = await f.scan();
    assert.match(message, /closed outside/);
    assert.match(message, alerts);
    const row = f.snapshot() as Managed & { closed_at?: string };
    assert.equal(row.closed_at, new Date(f.clock()).toISOString());
    assert.deepEqual([row.close_attempts?.[123].state, row.close_attempts?.[123].count], ['external', 1]);
    assert.deepEqual(row.close_execution, { '123:54': partial });
    assert.match(row.broker_message!, /exit details are unavailable/);
    assert.equal(f.sent.length, 1);
    t.mock.restoreAll();
  }
});

/** An entry order whose submission outcome is unknown and whose reference eToro answers with `status`. */
function entryFixture(status: number, positions: Position[] = [], overrides: Partial<Managed> = {}, pending = 0, others: Record<string, unknown>[] = []) {
  let clock = start;
  const answer = { status };
  const order: Managed = {
    id: ORDER_ID, environment: 'real', connection_version: 'version', state: 'review', position_ids: [], request, symbol: 'AAPL',
    strategy: 'breakout', signal_day: '2026-11-24', strategy_exit_at: null, created_at: new Date(start - 30_000).toISOString(),
    updated_at: new Date(start).toISOString(), close_requests: {}, protection_state: null, broker_message: 'No confirmed response from eToro', ...overrides,
  };
  const { db, tables } = memoryDb({ etoro_stock_orders: [{ ...order, user_id: 'user' }, ...others] });
  const broker = {
    portfolio: async () => ({ positions, pending }),
    // Status 200 stands for an order eToro did receive and has not executed yet.
    stockOrderStatus: async () => { if (answer.status === 200) return { orderId: 77, status: { id: 1 }, positionExecutions: [] }; throw new EtoroError(answer.status); },
  } as unknown as EtoroClient;
  const snapshot = () => structuredClone(tables.etoro_stock_orders[0]) as unknown as Managed;
  // The owner's actions on the orders route, which reads the clock itself.
  const act = (action: 'status' | 'resolve', connection: string) => stockOrderAction(db, broker, 'user', connection,
    stockOrderInput.parse({ action, environment: order.environment, id: ORDER_ID, ...(action === 'resolve' ? { outcome: 'not_received' } : {}) }));
  return { snapshot, answer, clock: () => clock, advance: (ms: number) => { clock += ms; },
    scan: (connection = 'version') => manageStockOrder(db, broker, 'user', snapshot(), connection, '2026-11-23', clock),
    status: (connection = 'version') => act('status', connection), resolve: (connection = 'version') => act('resolve', connection) };
}

test('an entry eToro has no record of is released after 15 minutes when no position could be its fill', async () => {
  // A position in another instrument, and one in this instrument opened days before the order, cannot be its fill.
  const f = entryFixture(404, [{ id: 1, instrumentId: 999, side: 'Long', opened: new Date(start).toISOString() },
    { id: 2, instrumentId: 456, side: 'Long', opened: '2026-11-20T15:00:00' }]);
  f.advance(15 * MINUTE - 1);
  assert.equal(await f.scan(), 'Waiting for eToro to confirm the submitted order');
  assert.equal(f.snapshot().state, 'review');
  f.advance(1);
  const message = await f.scan();
  assert.match(message, /AAPL order .* not received/);
  assert.match(message, alerts);
  assert.equal(f.snapshot().state, 'rejected');
  assert.match(f.snapshot().broker_message!, /Not received by eToro/);

  const sending = entryFixture(404, [], { state: 'sending' });
  sending.advance(15 * MINUTE);
  await sending.scan();
  assert.equal(sending.snapshot().state, 'rejected');
});

test('an entry eToro has no record of stays reserved when a matching position exists or the outcome is not definitive', async () => {
  const matched = entryFixture(404, [{ id: 7, instrumentId: 456, side: 'Long', opened: new Date(start + 5000).toISOString() }]);
  matched.advance(60 * MINUTE);
  const first = await matched.scan();
  assert.match(first, /needs a manual check/);
  assert.match(first, alerts);
  const second = await matched.scan();
  assert.match(second, /stays reserved/);
  assert.doesNotMatch(second, alerts);
  assert.equal(matched.snapshot().state, 'review');

  // A position without a readable open time, or any pending eToro order, could still be this order.
  for (const f of [entryFixture(404, [{ id: 7, instrumentId: 456, side: 'Long' }]), entryFixture(404, [], {}, 1)]) {
    f.advance(60 * MINUTE);
    assert.match(await f.scan(), /needs a manual check/);
    assert.equal(f.snapshot().state, 'review');
  }

  // eToro acknowledged a submitted order with an order ID, so it is never treated as not received.
  const acknowledged = entryFixture(404, [], { state: 'submitted' });
  acknowledged.advance(60 * MINUTE);
  assert.equal(await acknowledged.scan(), 'Waiting for eToro to confirm the submitted order');
  assert.equal(acknowledged.snapshot().state, 'submitted');

  const otherAccount = entryFixture(404);
  otherAccount.advance(60 * MINUTE);
  assert.match(await otherAccount.scan('replaced'), /key changed/);
  assert.equal(otherAccount.snapshot().state, 'review');

  const unavailable = entryFixture(503);
  unavailable.advance(60 * MINUTE);
  await assert.rejects(unavailable.scan(), /eToro HTTP 503/);
  assert.equal(unavailable.snapshot().state, 'review');
});

const refused = (result: { status: number; body: Record<string, unknown> }, status: number, error: RegExp) => {
  assert.equal(result.status, status);
  assert.match(String(result.body.error), error);
};
const matching = { id: 7, instrumentId: 456, side: 'Long', opened: new Date(start + 5000).toISOString() };
// A manual buy with no strategy has no signal day, timed exit or protection state, so the scan never selects it.
const manual = { strategy: null, signal_day: null } as unknown as Partial<Managed>;

test('a matching position that another order of the account already tracks does not keep an entry reserved', async () => {
  const other = { id: 'other', user_id: 'user', environment: 'real', state: 'filled', position_ids: [7] };
  const f = entryFixture(404, [matching], {}, 0, [other]);
  f.advance(15 * MINUTE);
  const message = await f.scan();
  assert.match(message, /AAPL order .* not received/);
  assert.match(message, alerts);
  assert.equal(f.snapshot().state, 'rejected');

  // Another account's row, the other environment's row and a row tracking a different position say nothing about this one.
  // A second matching position that no order tracks could still be the fill.
  const unrelated: [Position[], Record<string, unknown>][] = [
    [[matching], { ...other, user_id: 'someone-else' }], [[matching], { ...other, environment: 'demo' }],
    [[matching], { ...other, position_ids: [9] }], [[matching, { ...matching, id: 8 }], other],
  ];
  for (const [positions, row] of unrelated) {
    const kept = entryFixture(404, positions, {}, 0, [row]);
    kept.advance(60 * MINUTE);
    assert.match(await kept.scan(), /needs a manual check/);
    assert.equal(kept.snapshot().state, 'review');
  }
});

test('the owner can mark an unmatched entry as not placed only after 15 minutes, on a fresh 404 and with the same key', async t => {
  const f = entryFixture(404, [matching]);
  t.mock.method(Date, 'now', f.clock);
  f.advance(15 * MINUTE - 1);
  refused(await f.resolve(), 409, /Wait 15 minutes/);
  f.advance(1);
  refused(await f.resolve('replaced'), 409, /key changed/);
  // A lookup that cannot be answered proves nothing, and an order eToro knows is not missing.
  f.answer.status = 503;
  refused(await f.resolve(), 503, /Could not confirm/);
  f.answer.status = 200;
  refused(await f.resolve(), 409, /eToro has a record of this order/);
  assert.deepEqual([f.snapshot().state, f.snapshot().broker_message], ['review', 'No confirmed response from eToro']);

  f.answer.status = 404;
  const resolved = await f.resolve();
  assert.equal(resolved.status, 200);
  assert.match(String(resolved.body.message), /AAPL order marked as not placed/);
  assert.equal(f.snapshot().state, 'rejected');
  assert.match(f.snapshot().broker_message!, /owner confirmed in eToro that this order was not placed/);
  refused(await f.resolve(), 409, /unknown outcome/);

  // eToro acknowledged a submitted order with an order ID, so the owner cannot wave it away.
  t.mock.restoreAll();
  const acknowledged = entryFixture(404, [], { state: 'submitted' });
  t.mock.method(Date, 'now', acknowledged.clock);
  acknowledged.advance(60 * MINUTE);
  refused(await acknowledged.resolve(), 409, /unknown outcome/);
  assert.equal(acknowledged.snapshot().state, 'submitted');
  for (const outcome of ['filled', undefined]) {
    assert.equal(stockOrderInput.safeParse({ action: 'resolve', environment: 'real', id: ORDER_ID, outcome }).success, false);
  }
});

test('refreshing the status of a manual order outside the scan applies the not-received rule', async t => {
  for (const state of ['review', 'sending']) {
    // A position in this instrument opened days before the order cannot be its fill.
    const f = entryFixture(404, [{ id: 2, instrumentId: 456, side: 'Long', opened: '2026-11-20T15:00:00' }], { ...manual, state });
    t.mock.method(Date, 'now', f.clock);
    f.advance(15 * MINUTE - 1);
    refused(await f.status(), 404, /no matching confirmation yet/);
    assert.equal(f.snapshot().state, state);
    f.advance(1);
    const released = await f.status();
    assert.equal(released.status, 200);
    assert.match(String(released.body.brokerMessage), /AAPL order .* not received/);
    assert.equal((released.body.order as { state: string }).state, 'rejected');
    assert.match(f.snapshot().broker_message!, /Not received by eToro/);
    refused(await f.status(), 409, /needs no status refresh/);
    t.mock.restoreAll();
  }

  // A position or pending order it could have opened keeps it reserved, and the owner's check is the way out.
  for (const kept of [entryFixture(404, [matching], manual), entryFixture(404, [], manual, 1)]) {
    t.mock.method(Date, 'now', kept.clock);
    kept.advance(60 * MINUTE);
    const first = await kept.status();
    assert.equal(first.status, 200);
    assert.match(String(first.body.brokerMessage), /needs a manual check in eToro.*mark it as not placed/);
    assert.match(String((await kept.status()).body.brokerMessage), /stays reserved/);
    assert.equal(kept.snapshot().state, 'review');
    assert.match(kept.snapshot().broker_message!, /could have opened/);
    assert.equal((await kept.resolve()).status, 200);
    assert.equal(kept.snapshot().state, 'rejected');
    t.mock.restoreAll();
  }

  const otherAccount = entryFixture(404, [], manual);
  t.mock.method(Date, 'now', otherAccount.clock);
  otherAccount.advance(60 * MINUTE);
  refused(await otherAccount.status('replaced'), 409, /key changed/);
  assert.equal(otherAccount.snapshot().state, 'review');
  t.mock.restoreAll();

  // An acknowledged order and a lookup that cannot be answered are never released.
  const acknowledged = entryFixture(404, [], { ...manual, state: 'submitted' });
  t.mock.method(Date, 'now', acknowledged.clock);
  acknowledged.advance(60 * MINUTE);
  refused(await acknowledged.status(), 404, /no matching confirmation yet/);
  assert.equal(acknowledged.snapshot().state, 'submitted');
  t.mock.restoreAll();
  const unavailable = entryFixture(503, [], manual);
  t.mock.method(Date, 'now', unavailable.clock);
  unavailable.advance(60 * MINUTE);
  refused(await unavailable.status(), 503, /could not complete the request/);
  assert.equal(unavailable.snapshot().state, 'review');
  // Once eToro answers, the refresh reconciles the order as before.
  unavailable.answer.status = 200;
  const found = await unavailable.status();
  assert.deepEqual([found.status, (found.body.order as { state: string }).state], [200, 'submitted']);
  assert.equal((unavailable.snapshot() as Managed & { broker_order_id?: number }).broker_order_id, 77);
});

test('a flat portfolio whose exit eToro never confirms is closed 24 hours after the first flat scan and not before', async t => {
  const closedAt = (f: ReturnType<typeof exitFixture>) => f.tables.etoro_stock_orders[0].closed_at;
  // The exit reference cannot be looked up, the exit details never complete, or the exit status cannot be read.
  const cases: [ReturnType<typeof exitFixture>, RegExp | null, object][] = [
    [exitFixture(async () => { throw new EtoroError(503); }), /Waiting for eToro to resolve the exit reference/, {}],
    [exitFixture(async () => ({ orderId: 55 })), /Waiting for eToro exit execution details/, { 123: { orderId: 55, quote: null } }],
    [exitFixture(async () => ({ orderId: 55 }), async () => { throw new EtoroError(503); }), null, { 123: { orderId: 55, quote: null } }],
  ];
  for (const [f, waiting, details] of cases) {
    t.mock.method(Date, 'now', f.clock);
    const wait = async () => waiting ? assert.match(await f.scan(), waiting) : assert.rejects(f.scan(), /eToro HTTP 503/);
    await f.scan();
    f.advance(MINUTE);
    await f.scan();
    const changed = f.snapshot().updated_at;
    f.flat();
    f.advance(30 * MINUTE);
    await wait();
    const flatAt = f.clock();
    // The clock starts at the first flat scan. updated_at still holds the last real change.
    assert.deepEqual([f.snapshot().close_attempts?.[123].flatAt, f.snapshot().updated_at], [flatAt, changed]);
    f.advance(24 * HOUR - 1);
    await wait();
    assert.deepEqual([closedAt(f), f.snapshot().close_attempts?.[123].flatAt], [undefined, flatAt]);
    f.advance(1);
    // Never against a different key: the position may still be open on the original account.
    assert.match(await f.scan('replaced'), /key changed/);
    assert.equal(closedAt(f), undefined);
    const message = await f.scan();
    assert.match(message, /left the portfolio and eToro did not confirm the exit within 24 hours/);
    assert.match(message, alerts);
    const row = f.snapshot();
    assert.equal(closedAt(f), new Date(f.clock()).toISOString());
    assert.deepEqual([row.close_attempts?.[123].state, row.close_attempts?.[123].count], ['unconfirmed', 1]);
    assert.match(row.close_attempts![123].detail!, /did not confirm this exit/);
    // Whatever is known about the exit is kept for the journal.
    assert.deepEqual(row.close_execution ?? {}, details);
    assert.match(row.broker_message!, /did not confirm the exit within 24 hours/);
    assert.equal(f.sent.length, 1);
    t.mock.restoreAll();
  }
});

test('the flat-portfolio clock starts again when the position is back in the portfolio', async t => {
  const f = exitFixture(async () => { throw new EtoroError(503); });
  t.mock.method(Date, 'now', f.clock);
  await f.scan();
  f.flat();
  f.advance(30 * MINUTE);
  await f.scan();
  assert.ok(f.snapshot().close_attempts?.[123].flatAt);
  f.advance(23 * HOUR);
  f.flat(false);
  assert.match(await f.scan(), /unconfirmed/);
  assert.equal(f.snapshot().close_attempts?.[123].flatAt, undefined);
  f.flat();
  f.advance(2 * HOUR);
  assert.match(await f.scan(), /Waiting for eToro to resolve the exit reference/);
  assert.deepEqual([f.tables.etoro_stock_orders[0].closed_at, f.snapshot().close_attempts?.[123].flatAt], [undefined, f.clock()]);
});
