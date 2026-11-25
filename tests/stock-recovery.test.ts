import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EtoroError, type EtoroClient } from '../lib/stocks/etoro';
import { manageStockOrder } from '../lib/stocks/autopilot';
import { memoryDb } from './helpers';

const start = Date.parse('2026-11-24T19:00:00Z');
const MINUTE = 60_000;
type Managed = Parameters<typeof manageStockOrder>[3];
type Position = { id: number; instrumentId: number; side: string; opened?: string };
// The cron route alerts on messages matching this pattern, so the tests read it from the route itself.
const alerts = new RegExp(readFileSync('app/api/cron/stock-autopilot/route.ts', 'utf8').match(/if \(\/(.+)\/\.test\(message\)\) await notify/)![1]);
const request = { action: 'open', transaction: 'buy', instrumentId: 456, orderType: 'mkt', amount: 100, orderCurrency: 'usd', settlementType: 'real', leverage: 1 } as const;

/** A filled order whose first close request gets no answer. `lookup` decides what eToro says about a reference. */
function exitFixture(lookup: (reference: string) => Promise<{ orderId: number }>) {
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
    stockCloseStatus: async () => ({ orderID: 55, instrumentID: 456, statusID: 1, proceeds: 0, positions: [{ positionID: 123 }] }),
  } as unknown as EtoroClient;
  const snapshot = () => structuredClone(tables.etoro_stock_orders[0]) as unknown as Managed;
  return { sent, tables, snapshot, clock: () => clock, advance: (ms: number) => { clock += ms; }, flat: () => { portfolioOpen = false; },
    scan: () => manageStockOrder(db, broker, 'user', snapshot(), 'version', '2026-11-23', clock) };
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
function entryFixture(status: number, positions: Position[] = [], overrides: Partial<Managed> = {}, pending = 0) {
  let clock = start;
  const order: Managed = {
    id: 'order', environment: 'real', connection_version: 'version', state: 'review', position_ids: [], request, symbol: 'AAPL',
    strategy: 'breakout', signal_day: '2026-11-24', strategy_exit_at: null, created_at: new Date(start - 30_000).toISOString(),
    updated_at: new Date(start).toISOString(), close_requests: {}, protection_state: null, broker_message: 'No confirmed response from eToro', ...overrides,
  };
  const { db, tables } = memoryDb({ etoro_stock_orders: [{ ...order, user_id: 'user' }] });
  const broker = {
    portfolio: async () => ({ positions, pending }),
    stockOrderStatus: async () => { throw new EtoroError(status); },
  } as unknown as EtoroClient;
  const snapshot = () => structuredClone(tables.etoro_stock_orders[0]) as unknown as Managed;
  return { snapshot, advance: (ms: number) => { clock += ms; },
    scan: (connection = 'version') => manageStockOrder(db, broker, 'user', snapshot(), connection, '2026-11-23', clock) };
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
