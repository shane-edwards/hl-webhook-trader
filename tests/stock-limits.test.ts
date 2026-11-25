import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { EtoroClient } from '../lib/stocks/etoro';
import { encrypt } from '../lib/encryption';
import { scanStockAutopilot, type StockAutoConfig } from '../lib/stocks/autopilot';
import { stockOrderAction, stockOrderInput } from '../lib/stocks/manual-orders';
import { STOCK_INSTRUMENTS, type StockTradeSymbol } from '../lib/stocks/trade-rules';
import { memoryDb } from './helpers';

// Tuesday 2:00 p.m. ET: the regular session is open and the daily strategies' entry window has closed.
const start = Date.parse('2026-11-24T19:00:00Z');
const day = '2026-11-24';
const limits = { symbols: ['AAPL', 'MSFT'], strategies: ['breakout'], maxExposure: 3000, maxGroup: 1500, maxPositions: 2, dailyLoss: 100, maxCostBps: 60 };
type Row = Record<string, unknown>;
type Position = { id: number; instrumentId: number; amount: number; leverage: number; pnl: number | null; side: string; opened: string };
const holding = (symbol: StockTradeSymbol, amount: number, pnl: number | null = 0): Position =>
  ({ id: STOCK_INSTRUMENTS[symbol], instrumentId: STOCK_INSTRUMENTS[symbol], amount, leverage: 1, pnl, side: 'Long', opened: '2026-11-02T15:00:00Z' });

/** A signed-in account's manual order actions against a fake eToro book. `portfolio` is what stock_autopilot.portfolio holds. */
function fixture(t: TestContext, portfolio?: unknown, sessions: Row[] = []) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const book = { credit: 10_000, availableCash: 10_000, pending: 0, mirrors: 0, positions: [] as Position[] };
  const sent: string[] = [];
  const { db: memory, tables } = memoryDb({
    stock_autopilot: portfolio === undefined ? [] : [{ user_id: 'user', updated_at: 'settings', scan_until: null, active_environment: null, portfolio }],
    stock_portfolio_sessions: sessions, etoro_stock_orders: [],
  });
  const raw = memory as unknown as { from: (name: string) => Row; rpc: unknown };
  const db = { rpc: raw.rpc, from: (name: string) => {
    const query = raw.from(name);
    // memoryDb keys an upsert on user_id alone. The session row is keyed on account, environment and day, and is never overwritten.
    if (name === 'stock_portfolio_sessions') query.upsert = async (row: Row) => {
      if (!tables[name].some(saved => ['user_id', 'environment', 'session_day'].every(key => saved[key] === row[key]))) tables[name].push({ loss_locked: false, ...row });
      return { data: null, error: null };
    };
    // The column defaults a saved review relies on.
    const insert = query.insert as (row: Row) => unknown;
    if (name === 'etoro_stock_orders') query.insert = (row: Row) => insert({ state: 'draft', position_ids: [], close_requests: {}, ...row });
    return query;
  } } as never;
  const broker = {
    instrument: async (symbol: StockTradeSymbol) => ({ instrumentId: STOCK_INSTRUMENTS[symbol], displayName: symbol }),
    stockOrderOptions: async () => [{ leverage: 1, minimum: 1, stopMargin: null }, { leverage: 2, minimum: 1, stopMargin: { min: 0, max: 50 } }],
    quotes: async (ids: number[]) => ids.map(instrumentId => ({ instrumentId, bid: 99.95, ask: 100, date: new Date().toISOString(), quoteType: 'realtime' })),
    portfolio: async () => structuredClone(book),
    stockOrderCosts: async () => [],
    openStock: async (_order: unknown, reference: string) => { sent.push(reference); return { orderId: 77 }; },
  } as unknown as EtoroClient;
  const act = (body: Row) => stockOrderAction(db, broker, 'user', 'version', stockOrderInput.parse(body));
  const review = (symbol: StockTradeSymbol, amount: number, more: Row = {}) => act({ action: 'review', environment: 'demo', symbol, amount, ...more });
  const submit = (reviewed: Awaited<ReturnType<typeof review>>, environment = 'demo') => act({ action: 'submit', environment, id: (reviewed.body.review as { id: string }).id });
  const session = (environment = 'demo') => tables.stock_portfolio_sessions.find(row => row.environment === environment && row.session_day === day);
  return { db, book, sent, tables, act, review, submit, session };
}
const refused = (result: { status: number; body: Row }, status: number, error: RegExp) => {
  assert.equal(result.status, status);
  assert.match(String(result.body.error), error);
};

test('manual orders are unchanged for an account with no valid portfolio settings saved', async t => {
  for (const portfolio of [undefined, null, { ...limits, maxPositions: 0 }]) {
    const f = fixture(t, portfolio);
    // A book that would break every limit and cannot be measured.
    Object.assign(f.book, { credit: 5000, availableCash: 5000, pending: 1, mirrors: 1, positions: [holding('MSFT', 9000), holding('NVDA', 9000), holding('JPM', 9000, null)] });
    const reviewed = await f.review('AAPL', 100);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.exposure, 100);
    assert.deepEqual((await f.submit(reviewed)).body, { orderId: 77 });
    assert.equal(f.tables.etoro_stock_orders[0].state, 'submitted');
    assert.equal(f.tables.stock_portfolio_sessions.length, 0);
    // Buying power is still the only check.
    refused(await f.review('AAPL', 6000), 422, /buying power/);
    t.mock.timers.reset();
  }
});

test('a manual review is refused by each saved portfolio limit and names it', async t => {
  const f = fixture(t, limits);
  const holds = (...positions: Position[]) => { f.book.positions = positions; };
  assert.equal((await f.review('AAPL', 100)).status, 200);
  // The first usable check of the session saved the opening equity.
  assert.deepEqual([f.session()?.opening_equity, f.session()?.loss_locked], [10_000, false]);

  holds(holding('NVDA', 500), holding('JPM', 500));
  refused(await f.review('AAPL', 100), 422, /limit of 2 open instruments/);
  // Adding to a ticker that is already held was always possible by hand and leaves the instrument count unchanged.
  assert.equal((await f.review('NVDA', 100)).status, 200);
  refused(await f.review('NVDA', 1001), 422, /per-group limit/);

  holds(holding('JPM', 2950));
  refused(await f.review('AAPL', 100), 422, /gross exposure above your \$3,000\.00/);
  assert.equal((await f.review('AAPL', 50)).status, 200);
  // Exposure is the amount times the leverage.
  refused(await f.review('AAPL', 30, { leverage: 2, stopMarginPct: 10 }), 422, /gross exposure/);
  // A losing position still counts at its opening exposure.
  holds(holding('JPM', 2960, -500));
  refused(await f.review('AAPL', 50), 422, /gross exposure/);

  holds(holding('MSFT', 1450));
  refused(await f.review('AAPL', 100), 422, /one group of stocks above your \$1,500\.00 per-group limit/);
  assert.equal((await f.review('NVDA', 100)).status, 200);

  for (const unknown of [{ pending: 1 }, { mirrors: 1 }, { positions: [holding('MSFT', 100, null)] }]) {
    Object.assign(f.book, { pending: 0, mirrors: 0, positions: [] }, unknown);
    refused(await f.review('AAPL', 100), 409, /cannot measure your eToro exposure/);
  }
  Object.assign(f.book, { pending: 0, mirrors: 0, positions: [] });
  // None of the refusals above saved a review or reached the daily loss lock.
  assert.equal(f.tables.etoro_stock_orders.length, 4);
  assert.equal(f.session()?.loss_locked, false);

  f.book.credit = 9900.01;
  assert.equal((await f.review('AAPL', 100)).status, 200);
  f.book.credit = 9900;
  refused(await f.review('AAPL', 100), 409, /daily equity loss limit has been reached/);
  assert.equal(f.session()?.loss_locked, true);
  // The lock holds for the rest of the session, even after equity recovers.
  f.book.credit = 10_500;
  refused(await f.review('AAPL', 100), 409, /daily equity loss limit/);
  // It belongs to the environment the order targets. The other one starts its own session.
  assert.equal((await f.act({ action: 'review', environment: 'real', symbol: 'AAPL', amount: 100 })).status, 200);
  assert.deepEqual([f.session('real')?.opening_equity, f.session('real')?.loss_locked], [10_500, false]);
});

test('a manual submit checks the limits again when the book changed after the review', async t => {
  const f = fixture(t, limits);
  const reviewed = await f.review('AAPL', 100);
  assert.equal(reviewed.status, 200);
  const changes: [Partial<typeof f.book>, number, RegExp][] = [
    [{ positions: [holding('NVDA', 500), holding('JPM', 500)] }, 422, /open instruments/],
    [{ positions: [holding('JPM', 2950)] }, 422, /gross exposure/],
    [{ positions: [holding('MSFT', 1450)] }, 422, /per-group limit/],
    [{ pending: 1 }, 409, /cannot measure your eToro exposure/],
    [{ mirrors: 1 }, 409, /cannot measure your eToro exposure/],
  ];
  for (const [change, status, error] of changes) {
    Object.assign(f.book, { pending: 0, mirrors: 0, positions: [] }, change);
    refused(await f.submit(reviewed), status, error);
  }
  assert.deepEqual([f.sent.length, f.tables.etoro_stock_orders[0].state], [0, 'draft']);
  // The same review goes through once the book is back inside the limits.
  Object.assign(f.book, { pending: 0, mirrors: 0, positions: [] });
  assert.deepEqual((await f.submit(reviewed)).body, { orderId: 77 });
  assert.deepEqual([f.sent.length, f.tables.etoro_stock_orders[0].state], [1, 'submitted']);

  const second = await f.review('MSFT', 100);
  assert.equal(second.status, 200);
  f.book.credit = 9850;
  refused(await f.submit(second), 409, /daily equity loss limit has been reached/);
  assert.equal(f.session()?.loss_locked, true);
  f.book.credit = 10_000;
  refused(await f.submit(second), 409, /daily equity loss limit/);
  assert.deepEqual([f.sent.length, f.tables.etoro_stock_orders[1].state], [1, 'draft']);
});

test('the Autopilot scan and manual orders share one session row, so a lock set by a manual attempt stops the scan', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.ENCRYPTION_KEY = 'stock-limits-test-key';
  const f = fixture(t, limits);
  f.tables.etoro_connections = [{ user_id: 'user', environment: 'demo', updated_at: 'version',
    credentials_encrypted: encrypt(JSON.stringify({ apiKey: 'test-public-key', userKey: 'test-user-key' })) }];
  const config = { user_id: 'user', symbol: 'AAPL', strategy: 'breakout', amount: 100, active_environment: 'demo', updated_at: 'settings',
    leverage: 1, stop_margin_pct: null, portfolio: limits } as unknown as StockAutoConfig;
  // The scan reads the account through the real client, so the portfolio endpoint is the only eToro call it may make here.
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.ok(String(url).endsWith('/trading/info/demo/pnl'), String(url));
    reads++;
    return Response.json({ clientPortfolio: { credit: 10_000, positions: [] } });
  });
  const scan = () => scanStockAutopilot(f.db, 'user', config, start);

  // The scan gets past the loss check and saves the session's opening equity.
  assert.equal(await scan(), 'Waiting for the next scheduled strategy entry window');
  assert.deepEqual([reads, f.session()?.opening_equity, f.session()?.loss_locked], [1, 10_000, false]);

  // A manual attempt measures the loss from that same baseline and locks the session.
  f.book.credit = 9880;
  refused(await f.review('AAPL', 100), 409, /daily equity loss limit has been reached/);
  assert.equal(f.tables.stock_portfolio_sessions.length, 1);
  assert.equal(f.session()?.loss_locked, true);

  // The scan now stops at the lock, before it reads the account.
  assert.equal(await scan(), 'Daily loss limit reached. New entries paused for this US session.');
  assert.equal(reads, 1);
  assert.equal(f.tables.stock_autopilot[0].scan_until, null);
});
