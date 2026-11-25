// The daily trend strategy's two safety nets: an exchange-side stop on every
// position it leaves, and a second chance when the daily run is missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb, SimExchange } from './helpers';
import { withTradingLock } from '../lib/trading-lock';
import {
  MAX_STRATEGY_ERROR_RUNS_PER_DAY, STRATEGY_STOP_PCT, runStrategyForAccount, runStrategyOnce,
  shouldCatchUpStrategy, strategyCatchUpDue, strategyConfigFromSettings, type StrategyRunConfig,
} from '../lib/strategy/run';
import type { TriggerLeg } from '../lib/hyperliquid/client';

const userId = '00000000-0000-4000-8000-000000000001';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 10, 0, 10);

function series(n: number, dailyReturn: (i: number) => number, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + dailyReturn(i)));
  return out;
}
const wiggle = (i: number) => (i % 2 === 0 ? 0.02 : -0.02);
const calmUp = series(260, i => 0.004 + wiggle(i) / 20, 50_000); // target exposure: the 2x cap
const down = series(260, i => -0.003 + wiggle(i), 50_000); // target exposure: 0

/** The simulated exchange plus the two calls only the strategy uses, and a record of what was sent in what order. */
class StrategyExchange extends SimExchange {
  closes: number[];
  log: string[] = [];
  /** The exchange answers "resting" but the order is not there (to test that the answer is not trusted). */
  ghostStops = false;
  /** Only this share of a close fills. */
  closeFraction = 1;
  /** What was resting each time a cancel arrived. */
  restingAtCancel: number[][] = [];

  constructor(closes: number[]) {
    super({ BTC: closes[closes.length - 1] });
    this.closes = closes;
  }
  get mark() { return this.prices.get('BTC')!; }
  stops() { return this.resting('BTC', 'sl'); }

  async getDailyCandles() {
    const lastDay = Date.UTC(2026, 0, 9);
    return this.closes.map((close, i) => ({ time: lastDay - (this.closes.length - 1 - i) * DAY, close }));
  }
  async placeIocOrder(o: { coin: string; isBuy: boolean; size: number; reduceOnly: boolean }) {
    this.log.push(`ioc:${o.isBuy ? 'buy' : 'sell'}`);
    const pos = this.positions.get(o.coin);
    const signed = (pos ? (pos.side === 'long' ? pos.size : -pos.size) : 0) + (o.isBuy ? o.size : -o.size);
    if (Math.abs(signed) < 1e-9) this.positions.delete(o.coin);
    else this.positions.set(o.coin, { side: signed > 0 ? 'long' : 'short', size: Math.abs(signed), entryPrice: this.mark });
    return { orderId: 'ioc', fillPrice: this.mark, sizeInContracts: o.size };
  }
  async closePosition(coin: string) {
    this.log.push('close');
    if (this.closeFraction === 1) return super.closePosition(coin);
    const pos = this.positions.get(coin)!;
    const filled = pos.size * this.closeFraction;
    pos.size -= filled;
    return { fillPrice: this.mark, filledSize: filled, side: pos.side, fullyClosed: false };
  }
  async placeTriggerOrders(p: { coin: string; side: 'long' | 'short'; legs: TriggerLeg[] }) {
    if (this.ghostStops) { this.log.push('place:ghost'); return p.legs.map(() => '999999'); }
    const oids = await super.placeTriggerOrders(p);
    this.log.push(...oids.map(oid => `place:${oid}`));
    return oids;
  }
  async cancelOrders(coin: string, oids: Array<string | number>) {
    this.restingAtCancel.push(this.stops().map(o => o.oid));
    this.log.push(...oids.map(oid => `cancel:${oid}`));
    return super.cancelOrders(coin, oids);
  }
}

const cfg = (over: Partial<StrategyRunConfig> = {}): StrategyRunConfig =>
  ({ symbol: 'BTC', targetVol: 0.4, maxLeverage: 2, capitalUsd: null, dryRun: false, slippagePercent: 1, ...over });
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;

/** Exactly one stop rests, it is reduce-only, covers the whole position and sits `pct` under the mark. */
function assertOneFullStop(ex: StrategyExchange, pct = STRATEGY_STOP_PCT) {
  const pos = ex.positions.get('BTC')!;
  assert.ok(pos, 'a position is open');
  assert.equal(ex.resting('BTC').length, 1, 'one resting order on the symbol');
  const [stop] = ex.stops();
  assert.ok(stop, 'it is a stop-loss');
  assert.equal(stop.reduceOnly, true);
  assert.equal(stop.isBuy, pos.side === 'short');
  assert.ok(near(stop.size, pos.size), `stop size ${stop.size} covers the position ${pos.size}`);
  assert.ok(near(stop.px, ex.mark * (pos.side === 'long' ? 1 - pct / 100 : 1 + pct / 100)), `stop at ${stop.px}, mark ${ex.mark}`);
  return stop;
}

// ---------- the stop ----------

test('strategy stop: a live run that buys ends with one verified full-size stop 15% below the mark', async () => {
  assert.equal(STRATEGY_STOP_PCT, 15);
  assert.equal(strategyConfigFromSettings({}).stopPct, 15);
  const ex = new StrategyExchange(calmUp);
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'traded');
  assert.ok(near(ex.positions.get('BTC')!.size, 20_000 / ex.mark));
  const stop = assertOneFullStop(ex);
  assert.ok(near(stop.px, ex.mark * 0.85));
  // The stop price is in the result and in the message that is stored in strategy_runs.
  assert.equal(r.stopPrice, stop.px);
  assert.match(r.message, /^Executed: buy .*Stop-loss resting at /);
  assert.ok(r.message.includes(String(stop.px)));
  assert.deepEqual(ex.log, ['ioc:buy', `place:${stop.oid}`]);
});

test('strategy stop: the distance comes from the run config', async () => {
  const ex = new StrategyExchange(calmUp);
  const r = await runStrategyOnce(ex.client, cfg({ stopPct: 8 }), NOW);
  assert.equal(r.status, 'traded');
  assertOneFullStop(ex, 8);
});

test('strategy stop: a later run replaces it, with the new stop resting before the old one is cancelled', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  const first = assertOneFullStop(ex);
  ex.log.length = 0;

  ex.move('BTC', ex.mark * 1.04); // still inside the rebalance band
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'held');
  const second = assertOneFullStop(ex);
  assert.notEqual(second.oid, first.oid);
  assert.equal(r.stopPrice, second.px);
  assert.match(r.message, /within rebalance band\. Stop-loss resting at /);
  // New stop first, then the old one goes; both were resting when the cancel was sent.
  assert.deepEqual(ex.log, [`place:${second.oid}`, `cancel:${first.oid}`]);
  assert.deepEqual(ex.restingAtCancel, [[first.oid, second.oid]]);
});

test('strategy stop: running twice in a row trades once and still leaves one stop', async () => {
  const ex = new StrategyExchange(calmUp);
  assert.equal((await runStrategyOnce(ex.client, cfg(), NOW)).status, 'traded');
  const size = ex.positions.get('BTC')!.size;
  assert.equal((await runStrategyOnce(ex.client, cfg(), NOW)).status, 'held');
  assert.equal(ex.positions.get('BTC')!.size, size);
  assert.equal(ex.log.filter(l => l.startsWith('ioc')).length, 1);
  assertOneFullStop(ex);
});

test('strategy stop: a run that closes the position leaves no trigger orders', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  assertOneFullStop(ex);
  // A target left by hand goes too.
  await ex.placeTriggerOrders({ coin: 'BTC', side: 'long', legs: [{ kind: 'tp', triggerPx: ex.mark * 1.2, size: 0.01 }] });

  ex.closes = down;
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'traded');
  assert.equal(ex.positions.get('BTC'), undefined);
  assert.equal(ex.resting('BTC').length, 0);
  assert.equal(r.stopPrice, null);
  assert.match(r.message, /go flat.*No position: 2 leftover stop\/target orders cancelled/);

  // Already flat with nothing resting: a quiet hold that sends nothing.
  ex.log.length = 0;
  assert.equal((await runStrategyOnce(ex.client, cfg(), NOW)).status, 'held');
  assert.deepEqual(ex.log, []);
});

test('strategy stop: with no position but a resting limit entry, stop orders on the symbol are left alone', async () => {
  // The entry may own stop / target orders that wait for it to fill; the run cannot tell them from leftovers.
  const ex = new StrategyExchange(down);
  await ex.placeLimitEntry({ coin: 'BTC', isBuy: true, size: 0.01, price: ex.mark * 0.9, stopLossPx: ex.mark * 0.8 });
  await ex.placeTriggerOrders({ coin: 'BTC', side: 'long', legs: [{ kind: 'sl', triggerPx: ex.mark * 0.85, size: 0.01 }] });
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'held');
  assert.equal(ex.resting('BTC').length, 2);
  assert.equal(ex.log.filter(l => l.startsWith('cancel')).length, 0);
});

test('strategy stop: a rejected stop is an error that says the position is unprotected, and the previous stop stays', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  const first = assertOneFullStop(ex);
  const size = ex.positions.get('BTC')!.size;
  ex.log.length = 0;

  ex.rejectStops = true;
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /POSITION UNPROTECTED/);
  assert.match(r.message, /Stop-loss rejected: simulated/);
  assert.equal(r.stopPrice, null);
  // Nothing was cancelled and the position was not closed: the strategy's target says to hold it.
  assert.deepEqual(ex.stops().map(o => o.oid), [first.oid]);
  assert.equal(ex.positions.get('BTC')!.size, size);
  assert.deepEqual(ex.log, []);
});

test('strategy stop: a stop the exchange accepted but that is not resting is not trusted', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  const first = assertOneFullStop(ex);

  ex.ghostStops = true;
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /POSITION UNPROTECTED.*not resting on the exchange/);
  assert.deepEqual(ex.stops().map(o => o.oid), [first.oid]);
});

test('strategy stop: if the old stop cannot be cancelled the run is an error, but the new stop is in place', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  const first = assertOneFullStop(ex);
  const cancel = ex.cancelOrders.bind(ex);
  ex.cancelOrders = async () => { throw new Error('Cancel failed: simulated'); };
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /Stop-loss resting at .*The position is protected, but 1 older stop\/target order could not be cancelled/);
  assert.doesNotMatch(r.message, /UNPROTECTED/);
  assert.equal(ex.stops().length, 2);
  assert.ok(r.stopPrice);

  // The retry clears every older stop.
  ex.cancelOrders = cancel;
  assert.equal((await runStrategyOnce(ex.client, cfg(), NOW)).status, 'held');
  const last = assertOneFullStop(ex);
  assert.notEqual(last.oid, first.oid);
});

test('strategy stop: a buy whose stop is rejected is reported as an error, with the fill kept and the position left open', async () => {
  const ex = new StrategyExchange(calmUp);
  ex.rejectStops = true;
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /^Executed: buy .*POSITION UNPROTECTED/);
  assert.ok(near(r.tradedSize!, 20_000 / ex.mark));
  assert.ok(ex.positions.get('BTC'));
  assert.equal(ex.resting('BTC').length, 0);

  // The next run (the scan's catch-up) holds the position and puts the stop on.
  ex.rejectStops = false;
  const again = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(again.status, 'held');
  assertOneFullStop(ex);
});

test('strategy stop: a position that only partly closes is an error, and what is left is protected', async () => {
  const ex = new StrategyExchange(calmUp);
  await runStrategyOnce(ex.client, cfg(), NOW);
  ex.closes = down;
  ex.closeFraction = 0.5;
  const r = await runStrategyOnce(ex.client, cfg(), NOW);
  assert.equal(r.status, 'error');
  assert.match(r.message, /only partly closed.*Stop-loss resting at /);
  assertOneFullStop(ex);
});

test('strategy stop: a failed rebalance still protects the position that is there', async () => {
  const ex = new StrategyExchange(calmUp);
  ex.positions.set('BTC', { side: 'long', size: 0.1, entryPrice: ex.mark });
  // Four days without a completed candle: the run refuses to trade.
  const r = await runStrategyOnce(ex.client, cfg(), NOW + 4 * DAY);
  assert.equal(r.status, 'error');
  assert.match(r.message, /stale.*Stop-loss resting at /);
  assert.equal(ex.log.filter(l => l.startsWith('ioc')).length, 0);
  assertOneFullStop(ex);
});

test('strategy stop: a dry run places and cancels nothing', async () => {
  // Would buy.
  const flat = new StrategyExchange(calmUp);
  const buy = await runStrategyOnce(flat.client, cfg({ dryRun: true }), NOW);
  assert.equal(buy.status, 'dry_run');
  assert.deepEqual(flat.log, []);
  assert.equal(flat.resting('BTC').length, 0);
  assert.equal(buy.stopPrice, null);

  // Would close, with a stop already resting; and would hold: neither touches the orders.
  for (const closes of [down, calmUp]) {
    const ex = new StrategyExchange(calmUp);
    await runStrategyOnce(ex.client, cfg(), NOW);
    const before = assertOneFullStop(ex);
    ex.log.length = 0;
    ex.closes = closes;
    const r = await runStrategyOnce(ex.client, cfg({ dryRun: true }), NOW);
    assert.equal(r.status, closes === down ? 'dry_run' : 'held');
    assert.deepEqual(ex.log, []);
    assert.deepEqual(ex.stops().map(o => o.oid), [before.oid]);
    assert.ok(ex.positions.get('BTC'));
  }
});

// ---------- waiting for the trading lease ----------

/** Holds the account's lease until `release` is called. */
async function holdLease(ex: SimExchange, db: never) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const done = withTradingLock(ex.client, db, userId, async () => { entered(); await gate; });
  await ready;
  return { release, done };
}

/** Counts lease requests without changing what the database answers. */
function countAcquires(db: never) {
  const real = (db as { rpc: (name: string, args: Record<string, string>) => Promise<unknown> }).rpc;
  const counter = { acquires: 0 };
  (db as { rpc: unknown }).rpc = async (name: string, args: Record<string, string>) => {
    if (name === 'acquire_trading_lock') counter.acquires++;
    return real(name, args);
  };
  return counter;
}

test('trading lock: with a wait it takes the lease once the holder releases', async () => {
  const { db } = memoryDb();
  const ex = new SimExchange({ BTC: 100 });
  const holder = await holdLease(ex, db);
  const counter = countAcquires(db);
  setTimeout(holder.release, 60);
  let ran = false;
  const value = await withTradingLock(ex.client, db, userId, async () => { ran = true; return 'done'; }, false, { waitMs: 5_000, pollMs: 10 });
  assert.equal(value, 'done');
  assert.equal(ran, true);
  assert.ok(counter.acquires > 1, 'it had to ask more than once');
  await holder.done;
  // The waiter released the lease when it finished.
  await withTradingLock(ex.client, db, userId, async () => {});
});

test('trading lock: it still throws when the wait runs out', async () => {
  const { db } = memoryDb();
  const ex = new SimExchange({ BTC: 100 });
  const holder = await holdLease(ex, db);
  const counter = countAcquires(db);
  const started = Date.now();
  let ran = false;
  await assert.rejects(withTradingLock(ex.client, db, userId, async () => { ran = true; }, false, { waitMs: 80, pollMs: 10 }), /already processing/);
  assert.ok(Date.now() - started >= 70, 'it waited before giving up');
  assert.ok(counter.acquires > 1);
  assert.equal(ran, false);
  holder.release(); await holder.done;
});

test('trading lock: without the option it fails at once, as before', async () => {
  const { db } = memoryDb();
  const ex = new SimExchange({ BTC: 100 });
  const holder = await holdLease(ex, db);
  const counter = countAcquires(db);
  const started = Date.now();
  await assert.rejects(withTradingLock(ex.client, db, userId, async () => {}), /already processing/);
  await assert.rejects(withTradingLock(ex.client, db, userId, async () => {}, false), /already processing/);
  await assert.rejects(withTradingLock(ex.client, db, userId, async () => {}, false, {}), /already processing/);
  assert.equal(counter.acquires, 3, 'one request each, no retry');
  assert.ok(Date.now() - started < 500);
  holder.release(); await holder.done;
  await withTradingLock(ex.client, db, userId, async () => {});
});

// ---------- catch-up ----------

const at = (h: number, m: number) => Date.UTC(2026, 0, 10, h, m);
const run = (status: string, h: number, m: number, day = 10) => ({ status, created_at: new Date(Date.UTC(2026, 0, day, h, m)).toISOString() });

test('catch-up decision: runs when today has no run or the latest is an error, never before the daily job', () => {
  // No run yet.
  assert.equal(shouldCatchUpStrategy([], at(0, 15)), true);
  assert.equal(shouldCatchUpStrategy([], at(13, 0)), true);
  // Yesterday's runs do not count for today.
  assert.equal(shouldCatchUpStrategy([run('traded', 0, 10, 9), run('held', 23, 59, 9)], at(0, 15)), true);

  // Before the daily job's time (00:10 UTC) nothing runs, whatever is recorded; nor in the two minutes it is given to finish.
  assert.equal(shouldCatchUpStrategy([], at(0, 0)), false);
  assert.equal(shouldCatchUpStrategy([], at(0, 5)), false);
  assert.equal(shouldCatchUpStrategy([], at(0, 9)), false);
  assert.equal(shouldCatchUpStrategy([], at(0, 10)), false);
  assert.equal(shouldCatchUpStrategy([run('error', 0, 1)], at(0, 5)), false);
  assert.equal(shouldCatchUpStrategy([], at(0, 12)), true);

  // Error, then retry.
  assert.equal(shouldCatchUpStrategy([run('error', 0, 10)], at(0, 15)), true);
  assert.equal(shouldCatchUpStrategy([run('error', 0, 10), run('error', 0, 15)], at(0, 20)), true);

  // A successful run settles the day, whichever kind it is and whatever came before it.
  for (const ok of ['traded', 'held', 'dry_run']) {
    assert.equal(shouldCatchUpStrategy([run(ok, 0, 10)], at(0, 15)), false, ok);
    assert.equal(shouldCatchUpStrategy([run('error', 0, 10), run(ok, 0, 15)], at(0, 20)), false, ok);
    // Order of the rows does not matter, only their times.
    assert.equal(shouldCatchUpStrategy([run(ok, 0, 15), run('error', 0, 10)], at(0, 20)), false, ok);
  }

  // The cap: three error runs in a UTC day and it stops, until the next day.
  assert.equal(MAX_STRATEGY_ERROR_RUNS_PER_DAY, 3);
  const three = [run('error', 0, 10), run('error', 0, 15), run('error', 0, 20)];
  assert.equal(shouldCatchUpStrategy(three, at(0, 25)), false);
  assert.equal(shouldCatchUpStrategy(three, at(23, 55)), false);
  assert.equal(shouldCatchUpStrategy(three, Date.UTC(2026, 0, 11, 0, 15)), true);
});

const account = { user_id: userId, strategy_enabled: true, strategy_dry_run: false, strategy_max_leverage: 2, slippage_percent: 1 };

test('catch-up: the due check reads today\'s runs for the account and symbol', async () => {
  const other = '00000000-0000-4000-8000-000000000002';
  const row = (status: string, h: number, m: number, over: Record<string, unknown> = {}) => ({ user_id: userId, symbol: 'BTC', ...run(status, h, m), ...over });
  const due = (rows: Array<Record<string, unknown>>, now = at(0, 15)) => strategyCatchUpDue(memoryDb({ strategy_runs: rows }).db, account, now);

  assert.equal(await due([]), true);
  assert.equal(await due([], at(0, 5)), false);
  assert.equal(await due([row('held', 0, 10)]), false);
  assert.equal(await due([row('error', 0, 10)]), true);
  assert.equal(await due([row('error', 0, 10), row('error', 0, 15), row('error', 0, 20)], at(0, 25)), false);
  // Another account's run, another symbol's run and yesterday's run are not this account's run today.
  assert.equal(await due([row('held', 0, 10, { user_id: other }), row('held', 0, 10, { symbol: 'ETH' }), { user_id: userId, symbol: 'BTC', ...run('held', 0, 10, 9) }]), true);

  // Settings changed since the daily job's time (the strategy may just have been switched on): a day with
  // no run waits for the next daily job, but a failed run that day is still retried.
  const changedToday = { ...account, updated_at: new Date(at(9, 30)).toISOString() };
  const settled = { ...account, updated_at: new Date(Date.UTC(2026, 0, 9, 18, 0)).toISOString() };
  const dueFor = (settings: typeof account, rows: Array<Record<string, unknown>>, now: number) => strategyCatchUpDue(memoryDb({ strategy_runs: rows }).db, settings, now);
  assert.equal(await dueFor(changedToday, [], at(9, 35)), false);
  assert.equal(await dueFor(settled, [], at(9, 35)), true);
  assert.equal(await dueFor(changedToday, [row('error', 0, 10)], at(9, 35)), true);

  // If the runs cannot be read the cap cannot be applied, so it does not run.
  const broken = { from: () => { throw new Error('database is down'); } } as never;
  await assert.rejects(strategyCatchUpDue(broken, account, at(0, 15)), /database is down/);
});

test('catch-up: one account run trades under the lease, records the run and alerts, as the daily job does', async () => {
  const ex = new StrategyExchange(calmUp);
  const { db, tables } = memoryDb();
  const alerts: Array<{ message: string; user: string }> = [];
  const opts = { now: NOW, client: () => ex.client, notify: async (message: string, _subject: string | undefined, user: string) => { alerts.push({ message, user }); } };

  const r = await runStrategyForAccount(db, account, opts);
  assert.equal(r.status, 'traded');
  assertOneFullStop(ex);
  assert.equal(tables.strategy_runs.length, 1);
  const row = tables.strategy_runs[0];
  assert.equal(row.user_id, userId);
  assert.equal(row.symbol, 'BTC');
  assert.equal(row.status, 'traded');
  assert.match(String(row.message), /Stop-loss resting at /);
  assert.equal('stopPrice' in row || 'stop_price' in row, false, 'no column that the table does not have');
  assert.deepEqual(alerts.map(a => a.user), [userId]);
  assert.match(alerts[0].message, /^Strategy BTC traded: Executed: buy /);

  // The same call again holds: recorded, no alert, no second order.
  const again = await runStrategyForAccount(db, account, opts);
  assert.equal(again.status, 'held');
  assert.equal(tables.strategy_runs.length, 2);
  assert.equal(alerts.length, 1);
  assert.equal(ex.log.filter(l => l.startsWith('ioc')).length, 1);
  // The lease was released each time.
  await withTradingLock(ex.client, db, userId, async () => {});
});

test('catch-up: a busy lease or a missing wallet is a recorded error run with an alert, and a wait gets past a short hold', async () => {
  const ex = new StrategyExchange(calmUp);
  const { db, tables } = memoryDb();
  const alerts: string[] = [];
  const opts = { now: NOW, client: () => ex.client, notify: async (message: string) => { alerts.push(message); } };

  const holder = await holdLease(ex, db);
  const busy = await runStrategyForAccount(db, account, opts);
  assert.equal(busy.status, 'error');
  assert.match(busy.message, /already processing/);
  assert.equal(tables.strategy_runs[0].status, 'error');
  assert.match(alerts[0], /^Strategy BTC ERROR: .*already processing/);
  assert.deepEqual(ex.log, []);

  setTimeout(holder.release, 1_100);
  const waited = await runStrategyForAccount(db, account, { ...opts, lockWaitMs: 5_000 });
  assert.equal(waited.status, 'traded');
  await holder.done;

  const none = await runStrategyForAccount(db, account, { ...opts, client: () => null });
  assert.equal(none.status, 'error');
  assert.match(none.message, /credentials not configured/);
  assert.deepEqual(tables.strategy_runs.map(r => r.status), ['error', 'traded', 'error']);
});
