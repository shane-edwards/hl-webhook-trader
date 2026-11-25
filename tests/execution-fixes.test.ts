// Review fixes for the order path:
//   - an entry never reduces the protection a position already has;
//   - a failed exchange request halts and flattens the account only when it could have added exposure;
//   - a manual entry always carries a stop.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { memoryDb, SimExchange } from './helpers';
import { HyperliquidClient } from '../lib/hyperliquid/client';
import { manualStopLoss, openPosition } from '../lib/execution';
import { manageExits } from '../lib/exits';
import { managePending, placeLimitEntry } from '../lib/pending';
import { haltAndFlatten } from '../lib/risk/flatten';
import { withTradingLock } from '../lib/trading-lock';
import { DEFAULT_PORTFOLIO_LIMITS } from '../lib/risk/portfolio';

const USER = '00000000-0000-4000-8000-000000000009';
const entry = { userId: USER, symbol: 'BTC', side: 'long' as const, leverage: 2, slippagePercent: 1, source: 'manual' as const, closeIfUnprotected: true };
const stops = (ex: SimExchange, coin = 'BTC') => ex.resting(coin, 'sl').map(o => [o.px, o.size]);
const targets = (ex: SimExchange, coin = 'BTC') => ex.resting(coin, 'tp').map(o => [o.px, o.size]);

// ---------------------------------------------------------------- an entry never reduces protection
test('adding with only a take-profit keeps a verified full-size stop at the old trigger price', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  assert.deepEqual(stops(ex), [[98, 10]]);

  // The replacement must be resting, at full size, before the old stop is cancelled.
  const cancel = ex.cancelOrders.bind(ex);
  let cancels = 0;
  ex.cancelOrders = async (coin, oids) => {
    cancels++;
    assert.ok(ex.resting('BTC', 'sl').some(o => o.px === 98 && o.size === 15 && !oids.map(Number).includes(o.oid)), 'the full-size stop rests before the old one is cancelled');
    return cancel(coin, oids);
  };
  const added = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: null, takeProfitPct: 4 });
  assert.equal(added.protectionError, null);
  assert.equal(ex.positions.get('BTC')!.size, 15);
  assert.deepEqual(stops(ex), [[98, 15]], 'one stop, at the old price, for the whole larger position');
  assert.deepEqual(targets(ex), [[104, 15]]);
  assert.equal(added.stopLossPx, 98);
  assert.match(added.exitWarning!, /existing stop at 98 was kept/);
  assert.equal(cancels, 1);
});

test('adding with a new stop still replaces the old one, and leaves an older target alone when no new target is given', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: 4 });
  const added = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: 1, takeProfitPct: null });
  assert.equal(added.protectionError, null);
  assert.equal(added.exitWarning, null);
  assert.deepEqual(stops(ex), [[99, 15]]);
  assert.deepEqual(targets(ex), [[104, 10]], 'no new target replaced it, so the old one stays');
  // A new target does replace the old one.
  await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: 1, takeProfitPct: 5 });
  assert.deepEqual(stops(ex), [[99, 20]]);
  assert.deepEqual(targets(ex), [[105, 20]]);
});

test('adding with split targets and no stop keeps the old stop for the whole position and puts it in the exit plan', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  const added = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: null, takeProfitPct: 3, exit: { tp1Fraction: 0.5, takeProfit2Pct: 6 } });
  assert.equal(added.protectionError, null);
  assert.equal(added.stopLossPx, 98);
  assert.deepEqual(stops(ex), [[98, 15]]);
  assert.deepEqual(targets(ex), [[103, 7.5], [106, 7.5]]);
  const plan = tables.position_plans.find(p => p.status === 'active')!;
  assert.equal(plan.stop_px, 98);
  assert.equal(String(plan.stop_oid), String(ex.resting('BTC', 'sl')[0].oid));
  // The scan sees the stop it expects and leaves it alone.
  assert.deepEqual(await manageExits(ex.client, db, USER, 1), []);
  assert.deepEqual(stops(ex), [[98, 15]]);
});

test('adding with no stop and no target at all still resizes the old stop for the whole position', async () => {
  const ex = new SimExchange({ ETH: 100 });
  const { db } = memoryDb();
  const short = { ...entry, symbol: 'ETH', side: 'short' as const };
  await openPosition(ex.client, db, { ...short, sizeUsd: 1_000, stopLossPct: 3, takeProfitPct: 5 });
  const added = await openPosition(ex.client, db, { ...short, sizeUsd: 500, stopLossPct: null, takeProfitPct: null });
  assert.equal(added.protectionError, null);
  assert.deepEqual(stops(ex, 'ETH'), [[103, 15]]);
  assert.deepEqual(targets(ex, 'ETH'), [[95, 10]], 'the old target is untouched');
});

test('when the old stop cannot be carried forward it counts as failed protection, and the old stop is never cancelled', async () => {
  // Autopilot-style caller (no closeIfUnprotected): the error is reported and the old stop still rests.
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  ex.rejectStops = true;
  const kept = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: null, takeProfitPct: 4, closeIfUnprotected: false });
  assert.match(kept.protectionError!, /rejected/);
  assert.equal(kept.closedUnprotected, false);
  assert.deepEqual(stops(ex), [[98, 10]], 'the old stop was not cancelled');

  // Manual / webhook caller: the same failure closes the position, like any other missing stop.
  const closed = await openPosition(ex.client, db, { ...entry, sizeUsd: 500, stopLossPct: null, takeProfitPct: 4 });
  assert.equal(closed.closedUnprotected, true);
  assert.equal(ex.positions.size, 0);

  // A replacement that is accepted but not seen resting is treated the same way.
  const ex2 = new SimExchange({ BTC: 100 });
  const second = memoryDb();
  await openPosition(ex2.client, second.db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  ex2.placeProtectiveOrders = async () => ({ stopLossOid: '1', takeProfitOid: null });
  const unseen = await openPosition(ex2.client, second.db, { ...entry, sizeUsd: 500, stopLossPct: null, takeProfitPct: 4, closeIfUnprotected: false });
  assert.match(unseen.protectionError!, /not resting/);
  assert.deepEqual(stops(ex2), [[98, 10]]);
});

test('a take-profit-only entry with no earlier stop is unchanged: target placed, no stop, no error', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  const opened = await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: null, takeProfitPct: 4 });
  assert.equal(opened.protectionError, null);
  assert.equal(opened.stopLossPx, null);
  assert.deepEqual(stops(ex), []);
  assert.deepEqual(targets(ex), [[104, 10]]);
});

test('limit entry: an add-on with no stop of its own keeps the earlier stop for the whole position', async () => {
  const ex = new SimExchange({ SOL: 100 });
  const { db } = memoryDb();
  await openPosition(ex.client, db, { ...entry, symbol: 'SOL', sizeUsd: 1_000, stopLossPct: 10, takeProfitPct: null });
  assert.deepEqual(stops(ex, 'SOL'), [[90, 10]]);
  await placeLimitEntry(ex.client, db, { userId: USER, symbol: 'SOL', side: 'long', limitPx: 95, sizeUsd: 475, leverage: 2, stopLossPct: null, takeProfitPct: 8, expiryHours: 1, limits: DEFAULT_PORTFOLIO_LIMITS });
  ex.move('SOL', 94.9);
  assert.equal(ex.positions.get('SOL')!.size, 15);
  const events = await managePending(ex.client, db, USER);
  assert.ok(events.every(e => e.level !== 'error'), JSON.stringify(events));
  const resting = ex.resting('SOL', 'sl');
  assert.ok(resting.some(o => o.px === 90 && o.size === 15), 'a full-size stop at the old price');
  assert.ok(resting.every(o => o.px === 90), 'nothing looser was introduced');
  // A second pass adds nothing more.
  await managePending(ex.client, db, USER);
  assert.equal(ex.resting('SOL', 'sl').length, resting.length);
});

// ---------------------------------------------------------------- failed exchange requests
// The real client over a stand-in for the exchange's HTTP API, so the request path itself
// (journal, nonce, halt and recovery) is what runs. Nothing leaves the process.
interface WireOrder { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: string }; trigger?: { triggerPx: string; tpsl: 'sl' | 'tp' } } }
interface WireAction { type: string; orders?: WireOrder[]; cancels?: Array<{ o: number }> }
/** drop: the request never arrives. lost: it is carried out but the answer never comes back. http: the exchange answers 502. */
type Fault = 'drop' | 'lost' | 'http' | null;

class HttpExchange {
  mark = 100;
  position: { szi: number; entryPx: number } | null = null;
  orders: Array<{ oid: number; isBuy: boolean; triggerPx: number; sz: number; kind: 'sl' | 'tp' }> = [];
  /** Every action sent to /exchange, whether or not it got through. */
  sent: WireAction[] = [];
  fault: (a: WireAction) => Fault = () => null;
  onFault: () => void = () => {};
  private seq = 500;

  install(t: TestContext) {
    t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => this.handle(String(url), JSON.parse(String(init?.body))));
  }

  private handle(url: string, body: { type: string; action: WireAction }): Response {
    if (url.endsWith('/info')) return Response.json(this.info(body.type));
    if (!url.endsWith('/exchange')) throw new Error(`unexpected request to ${url}`);
    this.sent.push(body.action);
    const fault = this.fault(body.action);
    if (fault === 'drop' || fault === 'lost') {
      if (fault === 'lost') this.apply(body.action);
      this.onFault();
      throw new TypeError('fetch failed');
    }
    if (fault === 'http') { this.onFault(); return new Response('Bad Gateway', { status: 502 }); }
    return Response.json(this.apply(body.action));
  }

  private info(type: string) {
    const midnight = new Date().setUTCHours(0, 0, 0, 0);
    switch (type) {
      case 'meta': return { universe: [{ name: 'BTC', szDecimals: 3, maxLeverage: 50 }] };
      case 'allMids': return { BTC: String(this.mark) };
      case 'clearinghouseState': return {
        assetPositions: this.position ? [{ position: { coin: 'BTC', szi: String(this.position.szi), entryPx: String(this.position.entryPx), unrealizedPnl: '0', leverage: { value: '2' }, liquidationPx: '0', marginUsed: '0' } }] : [],
        marginSummary: { accountValue: '10000', totalUnrealizedPnl: '0', totalMarginUsed: '0' }, withdrawable: '10000',
      };
      case 'frontendOpenOrders': return this.orders.map(o => ({
        coin: 'BTC', oid: o.oid, isTrigger: true, reduceOnly: true, triggerPx: String(o.triggerPx), limitPx: String(o.triggerPx),
        side: o.isBuy ? 'B' : 'A', sz: String(o.sz), orderType: o.kind === 'sl' ? 'Stop Market' : 'Take Profit Market',
      }));
      case 'portfolio': return [['day', {
        accountValueHistory: [[midnight - 60_000, '10000'], [midnight + 1, '10000']], pnlHistory: [[midnight - 60_000, '0'], [midnight + 1, '0']],
      }]];
      case 'userNonFundingLedgerUpdates': return [];
      default: throw new Error(`unexpected info request ${type}`);
    }
  }

  private apply(action: WireAction) {
    if (action.type === 'updateLeverage') return { status: 'ok', response: { type: 'default' } };
    if (action.type === 'cancel') {
      const gone = new Set(action.cancels!.map(c => c.o));
      this.orders = this.orders.filter(o => !gone.has(o.oid));
      return { status: 'ok', response: { type: 'cancel', data: { statuses: action.cancels!.map(() => 'success') } } };
    }
    if (action.type !== 'order') throw new Error(`unexpected action ${action.type}`);
    const statuses = action.orders!.map(o => {
      const oid = ++this.seq, size = Number(o.s);
      if (o.t.trigger) {
        this.orders.push({ oid, isBuy: o.b, triggerPx: Number(o.t.trigger.triggerPx), sz: size, kind: o.t.trigger.tpsl });
        return { resting: { oid } };
      }
      const held = this.position?.szi ?? 0;
      if (o.r) {
        const left = Math.sign(held) * Math.max(0, Math.abs(held) - size);
        this.position = left === 0 ? null : { szi: left, entryPx: this.position!.entryPx };
      } else {
        const next = held + (o.b ? size : -size);
        this.position = { szi: next, entryPx: held === 0 ? this.mark : (Math.abs(held) * this.position!.entryPx + size * this.mark) / Math.abs(next) };
      }
      return { filled: { totalSz: o.s, avgPx: String(this.mark), oid } };
    });
    return { status: 'ok', response: { type: 'order', data: { statuses } } };
  }
}

type RawDb = { from: (table: string) => Record<string, unknown>; rpc: (name: string, args: Record<string, string>) => Promise<unknown> };

function live(t: TestContext, seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const ex = new HttpExchange();
  ex.install(t);
  // A throwaway key made for this test run: it signs requests that never leave the process.
  const hl = new HyperliquidClient({ privateKey: ethers.Wallet.createRandom().privateKey, isTestnet: true });
  const memory = memoryDb({ settings: [{ user_id: USER, trading_halted: false, flatten_pending: false, max_position_size_usd: 100_000, slippage_percent: 1 }], ...seed });
  const raw = memory.db as unknown as RawDb;
  const rpcCalls: string[] = [];
  const db = { from: raw.from, rpc: (name: string, args: Record<string, string>) => { rpcCalls.push(name); return raw.rpc(name, args); } } as never;
  const settings = () => memory.tables.settings[0];
  const untouched = () => {
    assert.equal(settings().trading_halted, false, 'trading is not halted');
    assert.equal(settings().flatten_pending, false, 'no flatten is pending');
    assert.equal(rpcCalls.includes('halt_trading_account'), false, 'the account was not halted');
  };
  return { ex, hl, db, raw, tables: memory.tables, rpcCalls, settings, untouched };
}

const hasEntry = (a: WireAction) => a.orders?.some(o => !o.r) ?? false;
const isStopOrTarget = (a: WireAction) => a.orders?.some(o => !!o.t.trigger) ?? false;
const isClose = (a: WireAction) => (a.orders?.length ?? 0) > 0 && a.orders!.every(o => o.r && !!o.t.limit);

test('a failed cancel or leverage update is recorded as uncertain and does not halt or flatten the account', async (t) => {
  const { ex, hl, db, tables, untouched } = live(t);
  ex.position = { szi: 10, entryPx: 100 };
  ex.orders.push({ oid: 7, isBuy: false, triggerPx: 98, sz: 10, kind: 'sl' });

  ex.fault = a => (a.type === 'cancel' ? 'drop' : null); // a timeout or network error
  await assert.rejects(withTradingLock(hl, db, USER, () => hl.cancelOrders('BTC', [7])), /fetch failed/);
  untouched();
  assert.equal(tables.exchange_actions[0].status, 'uncertain');

  ex.fault = a => (a.type === 'cancel' ? 'http' : null); // a 502 from the exchange
  await assert.rejects(withTradingLock(hl, db, USER, () => hl.cancelOrders('BTC', [7])), /exchange error 502/);
  untouched();
  assert.equal(tables.exchange_actions[1].status, 'uncertain');

  ex.fault = a => (a.type === 'updateLeverage' ? 'drop' : null);
  await assert.rejects(withTradingLock(hl, db, USER, () => hl.setLeverage('BTC', 3)), /fetch failed/);
  untouched();
  assert.equal(tables.exchange_actions[2].status, 'uncertain');

  assert.equal(ex.position!.szi, 10, 'nothing was closed');
  assert.equal(ex.orders.length, 1, 'the stop still rests');
  assert.equal(ex.sent.some(isClose), false, 'no close was sent');
});

test('a failed stop move leaves the old stop in place, halts nothing, and the next pass finishes the move', async (t) => {
  const { ex, hl, db, tables, untouched } = live(t, { position_plans: [{
    id: 'plan', user_id: USER, symbol: 'BTC', side: 'long', status: 'active', entry_price: 100, initial_size: 10, stop_px: 98,
    tp1_px: null, tp1_fraction: null, tp2_px: null, breakeven_after_tp1: false, trail_pct: 2, tp1_done: false, high_water: null, stop_oid: '7',
  }] });
  ex.position = { szi: 10, entryPx: 100 };
  ex.orders.push({ oid: 7, isBuy: false, triggerPx: 98, sz: 10, kind: 'sl' });
  ex.mark = 110; // the trailing stop should now be 107.8

  // The new stop is placed first. Its request is carried out but the answer is lost.
  ex.fault = a => (isStopOrTarget(a) ? 'lost' : null);
  const failed = await manageExits(hl, db, USER, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].level, 'error');
  assert.match(failed[0].message, /fetch failed/);
  untouched();
  assert.ok(ex.orders.some(o => o.oid === 7 && o.triggerPx === 98 && o.sz === 10), 'the old stop was not cancelled');
  assert.equal(ex.sent.some(a => a.type === 'cancel'), false);
  assert.equal(tables.position_plans[0].stop_px, 98);
  assert.equal(ex.position!.szi, 10);

  // Next pass, exchange reachable: one stop at the new price, the old one and the stray one gone.
  ex.fault = () => null;
  const moved = await manageExits(hl, db, USER, 1);
  assert.equal(moved[0].level, 'info');
  assert.deepEqual(ex.orders.map(o => [o.triggerPx, o.sz]), [[107.8, 10]]);
  assert.equal(tables.position_plans[0].stop_px, 110 * 0.98);
  untouched();
});

test('a failed entry order still halts trading, asks for the flatten and closes the fill', async (t) => {
  const { ex, hl, db, tables, rpcCalls, settings } = live(t);
  // The client waits for the lost order to expire before it looks for a fill: let that time pass at once.
  let skew = 0;
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + skew);
  ex.onFault = () => { skew += 20_000; };
  ex.fault = a => (hasEntry(a) ? 'lost' : null); // it filled, but the answer never arrived

  await assert.rejects(withTradingLock(hl, db, USER, () => hl.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 1_000, leverage: 2 })), /fetch failed/);
  assert.equal(settings().trading_halted, true);
  assert.equal(settings().flatten_pending, true);
  assert.ok(rpcCalls.includes('halt_trading_account'));
  assert.ok(tables.exchange_actions.some(a => a.status === 'uncertain'));
  assert.equal(ex.position, null, 'the fill was closed again');
  assert.ok(isClose(ex.sent[ex.sent.length - 1]), 'by a reduce-only order');

  // And nothing more can be bought while halted.
  ex.fault = () => null;
  const before = ex.sent.length;
  await assert.rejects(withTradingLock(hl, db, USER, () => hl.placeMarketOrder({ coin: 'BTC', isBuy: true, sizeUsd: 1_000, leverage: 2 })), /halted/);
  assert.equal(ex.sent.slice(before).some(hasEntry), false);
});

test('a database failure after the exchange confirmed an action still halts the account', async (t) => {
  const { ex, hl, raw, rpcCalls, db } = live(t);
  ex.orders.push({ oid: 7, isBuy: false, triggerPx: 98, sz: 10, kind: 'sl' });
  const failing = {
    rpc: (db as unknown as RawDb).rpc,
    from(table: string) {
      const query = raw.from(table);
      return table === 'exchange_actions' ? { ...query, update: () => ({ eq: async () => ({ data: null, error: { message: 'write unavailable' } }) }) } : query;
    },
  } as never;
  await withTradingLock(hl, failing, USER, () => hl.cancelOrders('BTC', [7]));
  assert.equal(ex.orders.length, 0, 'the cancel itself went through');
  assert.ok(rpcCalls.includes('halt_trading_account'));
});

test('a stop that cannot be placed after an entry closes that position without halting the account', async (t) => {
  const { ex, hl, db, tables, untouched } = live(t);
  ex.fault = a => (isStopOrTarget(a) ? 'drop' : null);
  const opened = await openPosition(hl, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null, limits: DEFAULT_PORTFOLIO_LIMITS });
  assert.match(opened.protectionError!, /fetch failed/);
  assert.equal(opened.closedUnprotected, true);
  assert.equal(ex.position, null);
  assert.equal(tables.trades[0].status, 'closed');
  untouched();
});

test('no stop and no close: the account is handed to the kill switch, which keeps retrying until it is flat', async (t) => {
  const { ex, hl, db, settings } = live(t);
  // Every request that would stop or close the position fails.
  ex.fault = a => (isStopOrTarget(a) || isClose(a) ? 'drop' : null);
  const opened = await openPosition(hl, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null, limits: DEFAULT_PORTFOLIO_LIMITS });
  assert.equal(opened.closedUnprotected, false);
  assert.match(opened.protectionError!, /could NOT be closed either/);
  assert.match(opened.protectionError!, /Trading is halted/);
  assert.equal(ex.position!.szi, 10, 'still open');
  assert.equal(settings().trading_halted, true);
  assert.equal(settings().flatten_pending, true, 'so the next scan flattens');

  // The flatten's own close fails too: it must stay pending, not be dropped.
  await assert.rejects(haltAndFlatten(hl, db, USER, 1), /fetch failed/);
  assert.equal(settings().flatten_pending, true);
  assert.equal(ex.position!.szi, 10);

  // Exchange reachable again: the retry closes the position and only then clears the flag.
  ex.fault = () => null;
  await haltAndFlatten(hl, db, USER, 1);
  assert.equal(ex.position, null);
  assert.equal(settings().flatten_pending, false);
  assert.equal(settings().trading_halted, true, 'trading stays halted until the owner resumes it');
});

test('simulated exchange: a rejected stop followed by a failed close asks for the account flatten', async () => {
  const ex = new SimExchange({ BTC: 100 });
  ex.rejectStops = true;
  ex.closePosition = async () => { throw new Error('exchange unreachable'); };
  const { db, tables } = memoryDb({ settings: [{ user_id: USER, trading_halted: false, flatten_pending: false }] });
  const opened = await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: 2, takeProfitPct: null });
  assert.equal(opened.closedUnprotected, false);
  assert.match(opened.protectionError!, /could NOT be closed either \(exchange unreachable\)/);
  assert.equal(tables.settings[0].trading_halted, true);
  assert.equal(tables.settings[0].flatten_pending, true);
  assert.equal(ex.positions.size, 1);
});

// ---------------------------------------------------------------- a manual entry always has a stop
test('manual entry: refused with no stop, no trailing stop and no default; the default from Settings is the fallback', () => {
  const none = manualStopLoss({ stopLossPct: null, trailPct: null, resting: false, defaultStopLossPct: null });
  assert.match(none.error!, /needs a stop-loss/);
  assert.equal(none.stopLossPct, null);
  // An unusable stored default is no default.
  for (const bad of [undefined, '', 0, 'abc', 75]) assert.ok(manualStopLoss({ stopLossPct: null, trailPct: null, resting: false, defaultStopLossPct: bad }).error, String(bad));

  // The default (stored as a number or as numeric text) becomes the stop.
  assert.deepEqual(manualStopLoss({ stopLossPct: null, trailPct: null, resting: false, defaultStopLossPct: 2.5 }), { stopLossPct: 2.5, fromDefault: true, error: null });
  assert.deepEqual(manualStopLoss({ stopLossPct: null, trailPct: null, resting: true, defaultStopLossPct: '3.00' }), { stopLossPct: 3, fromDefault: true, error: null });

  // The ticket's own stop always wins.
  assert.deepEqual(manualStopLoss({ stopLossPct: 1.5, trailPct: 2, resting: false, defaultStopLossPct: 4 }), { stopLossPct: 1.5, fromDefault: false, error: null });

  // A trailing stop is protection on a market (or sliced) entry: no fixed stop is added to it.
  assert.deepEqual(manualStopLoss({ stopLossPct: null, trailPct: 2, resting: false, defaultStopLossPct: 4 }), { stopLossPct: null, fromDefault: false, error: null });
  // A limit or chase entry cannot carry a trailing stop, so it does not count there.
  assert.deepEqual(manualStopLoss({ stopLossPct: null, trailPct: 2, resting: true, defaultStopLossPct: 4 }), { stopLossPct: 4, fromDefault: true, error: null });
  assert.match(manualStopLoss({ stopLossPct: null, trailPct: 2, resting: true, defaultStopLossPct: null }).error!, /needs a stop-loss/);
});

test('manual entry: the stop chosen for a trailing-only or default-stop ticket really ends up resting', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  const fromDefault = manualStopLoss({ stopLossPct: null, trailPct: null, resting: false, defaultStopLossPct: 2 });
  await openPosition(ex.client, db, { ...entry, sizeUsd: 1_000, stopLossPct: fromDefault.stopLossPct, takeProfitPct: null });
  assert.deepEqual(stops(ex), [[98, 10]]);

  const ex2 = new SimExchange({ BTC: 100 });
  const trailing = manualStopLoss({ stopLossPct: null, trailPct: 3, resting: false, defaultStopLossPct: null });
  assert.equal(trailing.error, null);
  await openPosition(ex2.client, memoryDb().db, { ...entry, sizeUsd: 1_000, stopLossPct: trailing.stopLossPct, takeProfitPct: null, exit: { trailPct: 3 } });
  assert.deepEqual(stops(ex2), [[97, 10]]);
});
