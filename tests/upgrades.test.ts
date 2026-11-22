import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb, SimExchange } from './helpers';
import { sizeByRisk } from '../lib/sizing';
import { checkPortfolio, DEFAULT_PORTFOLIO_LIMITS } from '../lib/risk/portfolio';
import { limitOrderWire, orderAction, triggerOrderWire } from '../lib/hyperliquid/orders';
import { buildExitLegs, manageExits, nextExitStep, type PlanRow } from '../lib/exits';
import { openPosition, closePositionFully } from '../lib/execution';
import { managePending, placeLimitEntry } from '../lib/pending';
import { attributeCosts, exitFromFills, NO_FILL_NOTE, syncAccount } from '../lib/reconcile';
import { buildScorecard, resolveOutcome } from '../lib/scorecard';
import { evaluateHealth } from '../lib/health';
import { buildDailySummary } from '../lib/upkeep';
import { journalTags, resultsByTag } from '../lib/journal';
import { calculateAnalytics, equityStats } from '../lib/analytics';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from '../lib/autopilot/strategies';
import { computeDrift } from '../lib/autopilot/drift';
import { DEFAULT_RISK } from '../lib/autopilot/risk';
import type { Fill } from '../lib/hyperliquid/public';
import type { Trade } from '../types';

const HOUR = 3_600_000;
const USER = 'user-1';
const limits = DEFAULT_PORTFOLIO_LIMITS;

// ---------------------------------------------------------------- item 1
test('sizing: the loss at the stop stays at the entered risk when the stop changes', () => {
  const base = { equity: 10_000, risk: 1, riskUnit: 'pct' as const, maxPositionUsd: 1e9, maxLeverage: 20 };
  for (const stopPct of [0.5, 1, 2, 4, 8]) {
    const s = sizeByRisk({ ...base, stopPct });
    assert.equal(s.error, null);
    assert.ok(Math.abs(s.riskUsd - 100) < 0.01, `stop ${stopPct}% risks ${s.riskUsd}`);
    assert.ok(Math.abs(s.sizeUsd - 100 / (stopPct / 100)) < 0.01);
  }
  // Dollars and percent agree.
  assert.equal(sizeByRisk({ ...base, risk: 100, riskUnit: 'usd', stopPct: 2 }).sizeUsd, 5_000);
  // Leverage needed is the smallest whole number that funds the position.
  assert.equal(sizeByRisk({ ...base, stopPct: 0.5 }).leverageNeeded, 2);
  assert.equal(sizeByRisk({ ...base, stopPct: 2 }).leverageNeeded, 1);
});

test('sizing: capped by max position size and by the market max leverage, and the reported risk shrinks with it', () => {
  const capped = sizeByRisk({ equity: 10_000, risk: 1, riskUnit: 'pct', stopPct: 1, maxPositionUsd: 2_000, maxLeverage: 20 });
  assert.equal(capped.sizeUsd, 2_000);
  assert.equal(capped.cappedBy, 'max position size');
  assert.equal(capped.riskUsd, 20);
  const lev = sizeByRisk({ equity: 1_000, risk: 5, riskUnit: 'pct', stopPct: 0.1, maxPositionUsd: 1e9, maxLeverage: 3 });
  assert.equal(lev.sizeUsd, 3_000);
  assert.equal(lev.cappedBy, 'market max leverage');
  assert.ok(sizeByRisk({ equity: 10_000, risk: 1, riskUnit: 'pct', stopPct: 0, maxPositionUsd: 1e9, maxLeverage: 20 }).error);
  assert.ok(sizeByRisk({ equity: 100, risk: 0.01, riskUnit: 'pct', stopPct: 5, maxPositionUsd: 1e9, maxLeverage: 20 }).error); // under $10
});

// ---------------------------------------------------------------- item 10
test('portfolio limits: gross exposure cap counts every position, and the daily loss limit blocks entries', () => {
  const base = { equity: 1_000, grossExposureUsd: 2_500, dayStartEquity: 1_000, limits };
  assert.equal(checkPortfolio({ ...base, newNotionalUsd: 400 }).ok, true); // 2,900 of a 3,000 cap
  const over = checkPortfolio({ ...base, newNotionalUsd: 600 });
  assert.equal(over.ok, false);
  assert.match(over.reason!, /Total exposure/);
  const down = checkPortfolio({ ...base, equity: 940, grossExposureUsd: 0, newNotionalUsd: 50 }); // -6% today
  assert.equal(down.ok, false);
  assert.match(down.reason!, /Daily loss limit/);
  // Unknown day-start (table missing) skips only the daily check.
  assert.equal(checkPortfolio({ ...base, equity: 940, grossExposureUsd: 0, newNotionalUsd: 50, dayStartEquity: null }).ok, true);
});

test('portfolio limits are enforced inside openPosition, so no entry path can skip them', async () => {
  const ex = new SimExchange({ BTC: 100 });
  ex.equity = 100;
  const { db } = memoryDb();
  await assert.rejects(
    openPosition(ex.client, db, { userId: USER, symbol: 'BTC', side: 'long', sizeUsd: 400, leverage: 5, slippagePercent: 1, stopLossPct: 2, takeProfitPct: null, source: 'webhook' }),
    /Blocked by a portfolio limit/);
  assert.equal(ex.positions.size, 0);
});

// ---------------------------------------------------------------- item 3 / 4 wire format
test('order builders reproduce the exact actions whose signatures were checked against the SDK', () => {
  const v = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'signing-vectors.json'), 'utf8'));
  assert.deepEqual(orderAction([limitOrderWire(0, 5, true, 61235, 0.00123, 'Ioc')], 'na'), v.ioc.action);
  // The SDK vector's stop uses its own worst-fill price; everything else must match field for field.
  const sl = orderAction([triggerOrderWire(0, 5, 'long', 58000, 0.00123, 'sl')], 'positionTpsl');
  assert.equal(sl.orders[0].p, '52200'); // 10% through the trigger
  assert.deepEqual({ ...sl, orders: [{ ...sl.orders[0], p: v.sl.action.orders[0].p }] }, v.sl.action);
  // Key order matters (the action is hashed as msgpack): the new shapes keep the SDK's order.
  const keys = (o: object) => Object.keys(o).join(',');
  const tp = triggerOrderWire(0, 5, 'long', 65000, 0.0006, 'tp');
  assert.equal(keys(tp), keys(v.sl.action.orders[0]));
  assert.equal(keys((tp.t as { trigger: object }).trigger), keys(v.sl.action.orders[0].t.trigger));
  const alo = limitOrderWire(0, 5, true, 60000, 0.001, 'Alo');
  assert.equal(keys(alo), keys(v.ioc.action.orders[0]));
  assert.deepEqual(alo.t, { limit: { tif: 'Alo' } });
  assert.equal(keys(orderAction([alo, tp], 'normalTpsl')), keys(v.ioc.action));
  // A short's stop buys back above; its worst fill price is 10% through the trigger.
  const shortStop = triggerOrderWire(0, 5, 'short', 60000, 0.001, 'sl');
  assert.equal(shortStop.b, true);
  assert.equal(shortStop.p, '66000');
  assert.equal(shortStop.r, true);
});

// ---------------------------------------------------------------- item 3
test('exit legs: split sizes add up, targets sit on the right side, and a too-small split falls back to one target', () => {
  const { legs, plan, warning } = buildExitLegs({
    side: 'short', entryPrice: 100, size: 1.001, szDecimals: 3, stopLossPct: 2, takeProfitPct: 3,
    exit: { tp1Fraction: 0.5, takeProfit2Pct: 6, breakevenAfterTp1: true, trailPct: null },
  });
  assert.equal(warning, null);
  assert.deepEqual(legs.map(l => l.kind), ['sl', 'tp', 'tp']);
  assert.equal(legs[0].triggerPx, 102); assert.equal(legs[1].triggerPx, 97); assert.equal(legs[2].triggerPx, 94);
  assert.equal(legs[0].size, 1.001);
  assert.ok(Math.abs(legs[1].size + legs[2].size - 1.001) < 1e-9);
  assert.equal(plan.breakeven_after_tp1, true);

  const tiny = buildExitLegs({ side: 'long', entryPrice: 100, size: 0.15, szDecimals: 3, stopLossPct: 2, takeProfitPct: 3, exit: { tp1Fraction: 0.5, takeProfit2Pct: 6 } });
  assert.match(tiny.warning!, /too small to split/);
  assert.deepEqual(tiny.legs.map(l => [l.kind, l.size]), [['sl', 0.15], ['tp', 0.15]]);
  assert.equal(tiny.plan.tp1_fraction, null);

  // A trailing stop with no fixed stop starts one trail-distance from entry.
  const trailOnly = buildExitLegs({ side: 'long', entryPrice: 100, size: 1, szDecimals: 3, stopLossPct: null, takeProfitPct: null, exit: { trailPct: 2 } });
  assert.deepEqual(trailOnly.legs, [{ kind: 'sl', triggerPx: 98, size: 1 }]);
});

test('exits on a simulated exchange: target 1 fills, the stop moves to break-even, then stops out flat with nothing left behind', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  const opened = await openPosition(ex.client, db, {
    userId: USER, symbol: 'BTC', side: 'long', sizeUsd: 1_000, leverage: 2, slippagePercent: 1, stopLossPct: 2, takeProfitPct: 3, source: 'manual',
    exit: { tp1Fraction: 0.5, takeProfit2Pct: 6, breakevenAfterTp1: true },
  });
  assert.equal(opened.protectionError, null);
  assert.equal(opened.stopLossPx, 98);
  assert.deepEqual(ex.resting('BTC').map(o => [o.kind, o.px, o.size]), [['sl', 98, 10], ['tp', 103, 5], ['tp', 106, 5]]);
  assert.equal(tables.position_plans.length, 1);

  // Nothing to do while price sits between stop and target.
  assert.deepEqual(await manageExits(ex.client, db, USER, 1), []);

  ex.move('BTC', 103.5); // target 1 takes half off
  assert.equal(ex.positions.get('BTC')!.size, 5);
  const events = await manageExits(ex.client, db, USER, 1);
  assert.match(events[0].message, /break-even/);
  const stops = ex.resting('BTC', 'sl');
  assert.equal(stops.length, 1, 'exactly one stop: the old one was cancelled after the new one was placed');
  assert.equal(stops[0].px, 100);
  assert.equal(stops[0].size, 5);
  assert.equal(tables.position_plans[0].tp1_done, true);

  ex.move('BTC', 99.9); // back through entry: the break-even stop closes the rest
  assert.equal(ex.positions.has('BTC'), false);
  await manageExits(ex.client, db, USER, 1);
  assert.equal(tables.position_plans[0].status, 'done');
  assert.equal(ex.resting('BTC').length, 0, 'target 2 must not be left resting with no position');
});

test('exits: a trailing stop only ever moves in the trade\'s favour, and only when the scan runs', async () => {
  const ex = new SimExchange({ ETH: 100 });
  const { db } = memoryDb();
  await openPosition(ex.client, db, {
    userId: USER, symbol: 'ETH', side: 'short', sizeUsd: 1_000, leverage: 2, slippagePercent: 1, stopLossPct: 3, takeProfitPct: null, source: 'manual',
    exit: { trailPct: 2 },
  });
  const stopPx = () => ex.resting('ETH', 'sl')[0].px;
  assert.equal(stopPx(), 103);
  ex.move('ETH', 95);
  assert.equal(stopPx(), 103, 'the price moved but no scan has run: the stop has not');
  await manageExits(ex.client, db, USER, 1);
  assert.ok(Math.abs(stopPx() - 96.9) < 1e-9); // 2% above the low of 95
  ex.move('ETH', 96.5); // a bounce that stays under the stop
  await manageExits(ex.client, db, USER, 1);
  assert.ok(Math.abs(stopPx() - 96.9) < 1e-9, 'a trailing stop never moves back');
  assert.equal(ex.resting('ETH', 'sl').length, 1);
});

test('exits: a missing stop is put back; if price is already through it the position is closed instead', () => {
  const plan: PlanRow = { id: 'p', symbol: 'BTC', side: 'long', entry_price: 100, initial_size: 1, stop_px: 98, tp1_px: null, tp1_fraction: null, tp2_px: null, breakeven_after_tp1: false, trail_pct: null, tp1_done: false, high_water: null, stop_oid: '1' };
  assert.equal(nextExitStep(plan, { side: 'long', size: 1, markPrice: 101 }, true, 3).type, 'hold');
  const again = nextExitStep(plan, { side: 'long', size: 1, markPrice: 101 }, false, 3);
  assert.equal(again.type, 'move_stop');
  assert.equal(again.type === 'move_stop' && again.stopPx, 98);
  assert.equal(nextExitStep(plan, { side: 'long', size: 1, markPrice: 97 }, false, 3).type, 'close');
  assert.equal(nextExitStep(plan, null, false, 3).type, 'done');
});

test('closing a position by hand ends its exit plan and clears its orders', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  await openPosition(ex.client, db, { userId: USER, symbol: 'BTC', side: 'long', sizeUsd: 1_000, leverage: 2, slippagePercent: 1, stopLossPct: 2, takeProfitPct: 3, source: 'manual', exit: { tp1Fraction: 0.5 } });
  await closePositionFully(ex.client, db, USER, 'BTC', 1);
  assert.equal(ex.resting('BTC').length, 0);
  assert.equal(tables.position_plans[0].status, 'done');
  assert.equal(tables.trades[0].status, 'closed');
});

// ---------------------------------------------------------------- item 4
const limitParams = { userId: USER, symbol: 'SOL', side: 'long' as const, limitPx: 95, sizeUsd: 950, leverage: 2, stopLossPct: 2, takeProfitPct: 4, expiryHours: 1, limits };

test('limit entry: an order that never fills expires and leaves no stop behind', async () => {
  const ex = new SimExchange({ SOL: 100 });
  const { db, tables } = memoryDb();
  await placeLimitEntry(ex.client, db, limitParams);
  assert.equal(ex.resting('SOL', 'limit').length, 1);
  assert.equal(ex.resting('SOL', 'sl').length, 0, 'the stop is not active before the entry fills');

  assert.deepEqual(await managePending(ex.client, db, USER), []); // still resting
  const events = await managePending(ex.client, db, USER, Date.now() + 2 * HOUR);
  assert.match(events[0].message, /expired unfilled/);
  assert.equal(tables.pending_orders[0].status, 'expired');
  assert.equal(ex.orders.filter(o => o.status === 'open').length, 0, 'no order of any kind remains, active or waiting');
  assert.equal((tables.trades ?? []).length, 0);
  // Price later trading through the old level opens nothing.
  ex.move('SOL', 90);
  assert.equal(ex.positions.size, 0);
});

test('limit entry: a fill is recorded and has its stop, from the exchange or, failing that, from the scan', async () => {
  for (const dropChildren of [false, true]) {
    const ex = new SimExchange({ SOL: 100 });
    ex.dropChildren = dropChildren;
    const { db, tables } = memoryDb();
    await placeLimitEntry(ex.client, db, limitParams);
    ex.move('SOL', 94.9);
    assert.equal(ex.positions.get('SOL')!.size, 10);
    assert.equal(ex.resting('SOL', 'sl').length, dropChildren ? 0 : 1);

    const events = await managePending(ex.client, db, USER);
    assert.ok(events.some(e => /Limit long filled: 10 SOL at 95/.test(e.message)));
    const stops = ex.resting('SOL', 'sl'), targets = ex.resting('SOL', 'tp');
    assert.equal(stops.length, 1, `stop present (dropChildren=${dropChildren})`);
    assert.ok(Math.abs(stops[0].px - 93.1) < 1e-9);
    assert.equal(targets.length, 1);
    assert.equal(tables.pending_orders[0].status, 'filled');
    assert.equal(tables.trades.length, 1);
    assert.equal(tables.trades[0].entry_price, 95);
    // A second pass changes nothing: no duplicate trade, no stacked stops.
    await managePending(ex.client, db, USER);
    assert.equal(tables.trades.length, 1);
    assert.equal(ex.resting('SOL', 'sl').length, 1);
  }
});

test('limit entry: a partial fill is protected at once, and recorded at its real size when the rest expires', async () => {
  const ex = new SimExchange({ SOL: 100 });
  ex.dropChildren = true;
  const { db, tables } = memoryDb();
  await placeLimitEntry(ex.client, db, limitParams);
  ex.move('SOL', 94.9, 0.4); // 4 of 10 fill
  await managePending(ex.client, db, USER);
  assert.equal(ex.resting('SOL', 'sl')[0].size, 4);
  assert.equal(tables.pending_orders[0].status, 'resting');
  ex.prices.set('SOL', 96);
  await managePending(ex.client, db, USER, Date.now() + 2 * HOUR);
  assert.equal(tables.pending_orders[0].status, 'filled');
  assert.equal(tables.trades[0].size, 4);
  assert.equal(ex.resting('SOL', 'limit').length, 0);
  assert.equal(ex.resting('SOL', 'sl').length, 1);
});

test('limit entry: must rest on the passive side, and obeys the portfolio limits', async () => {
  const ex = new SimExchange({ SOL: 100 });
  const { db } = memoryDb();
  await assert.rejects(placeLimitEntry(ex.client, db, { ...limitParams, limitPx: 101 }), /must be below/);
  await assert.rejects(placeLimitEntry(ex.client, db, { ...limitParams, side: 'short', limitPx: 99 }), /must be above/);
  ex.equity = 100;
  await assert.rejects(placeLimitEntry(ex.client, db, limitParams), /portfolio limit/);
  assert.equal(ex.orders.length, 0);
});

// ---------------------------------------------------------------- items 8 / 11
const fill = (f: Partial<Fill>): Fill => ({ coin: 'BTC', px: 100, sz: 1, time: 0, oid: '1', dir: 'Open Long', closedPnl: 0, fee: 0, ...f });

test('reconcile: exit price comes from the closing fills after the entry, size-weighted', () => {
  const fills = [
    fill({ time: 500, dir: 'Close Long', px: 90, sz: 5, closedPnl: -50 }), // an earlier position: ignored
    fill({ time: 1_000, dir: 'Open Long' }),
    fill({ time: 2_000, dir: 'Close Long', px: 110, sz: 1, closedPnl: 10 }),
    fill({ time: 3_000, dir: 'Close Long', px: 120, sz: 3, closedPnl: 60 }),
    fill({ time: 3_500, coin: 'ETH', dir: 'Close Long', px: 1, sz: 1, closedPnl: 1 }),
  ];
  assert.deepEqual(exitFromFills(fills, 'BTC', 900), { price: 117.5, time: 3_000 });
  assert.equal(exitFromFills(fills, 'SOL', 0), null);
});

test('reconcile: a stale open row with no position and no closing fill is cancelled, never given a made-up P&L', async (t) => {
  // The exchange's fill and funding history is read over HTTP; stand in an empty one.
  t.mock.method(globalThis, 'fetch', async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
  const ex = new SimExchange({ BTC: 61_000 });
  const old = new Date(Date.now() - 150 * 86_400_000).toISOString();
  const { db, tables } = memoryDb({ trades: [
    { id: 'stale', user_id: USER, symbol: 'BTC', side: 'short', status: 'open', entry_price: 65_000, size: 0.01, leverage: 2, entry_time: old, pnl: null },
    { id: 'fresh', user_id: USER, symbol: 'ETH', side: 'long', status: 'open', entry_price: 1_700, size: 1, leverage: 2, entry_time: new Date().toISOString(), pnl: null },
  ] });
  const r = await syncAccount(ex.client, db, USER);
  const stale = tables.trades.find(x => x.id === 'stale')!;
  assert.equal(stale.status, 'cancelled');
  assert.equal(stale.pnl, null);
  assert.equal(stale.exit_price, undefined);
  assert.equal(stale.notes, NO_FILL_NOTE);
  assert.match(r.notes[0], /marked cancelled with no profit or loss/);
  // A row opened moments ago is left alone: its fill may not be in the history yet.
  assert.equal(tables.trades.find(x => x.id === 'fresh')!.status, 'open');
});

test('true costs: fees, funding and realised P&L are attributed per trade; overlapping rows share one position', () => {
  const fills = [
    fill({ time: 1_000_000, dir: 'Open Long', sz: 2, fee: 0.09 }),
    fill({ time: 1_500_000, dir: 'Open Long', sz: 1, fee: 0.045 }),
    fill({ time: 2_000_000, dir: 'Close Long', sz: 3, px: 110, closedPnl: 30, fee: 0.15 }),
    fill({ time: 9_000_000, dir: 'Open Long', sz: 1, fee: 0.05 }),
    fill({ time: 9_500_000, dir: 'Close Long', sz: 1, closedPnl: -4, fee: 0.05 }),
  ];
  const funding = [{ coin: 'BTC', time: 1_200_000, usdc: -0.3 }, { coin: 'BTC', time: 9_200_000, usdc: 0.1 }, { coin: 'ETH', time: 1_200_000, usdc: -9 }];
  const costs = attributeCosts([
    { id: 'a', symbol: 'BTC', size: 2, entryTime: 1_000_000, exitTime: 2_000_000 },
    { id: 'b', symbol: 'BTC', size: 1, entryTime: 1_500_000, exitTime: 2_000_000 },
    { id: 'c', symbol: 'BTC', size: 1, entryTime: 9_000_000, exitTime: 9_500_000 },
  ], fills, funding);
  const a = costs.get('a')!, b = costs.get('b')!, c = costs.get('c')!;
  assert.ok(Math.abs(a.fees - 0.19) < 1e-9 && Math.abs(b.fees - 0.095) < 1e-9); // 0.285 split 2:1
  assert.ok(Math.abs(a.exchangePnl - 20) < 1e-9 && Math.abs(b.exchangePnl - 10) < 1e-9);
  assert.ok(Math.abs(a.fundingPaid - 0.2) < 1e-9);
  assert.ok(Math.abs(a.netPnl - (20 - 0.19 - 0.2)) < 1e-9);
  // The later trade paid fees, RECEIVED funding, and lost: net = -4 - 0.1 + 0.1.
  assert.ok(Math.abs(c.fees - 0.1) < 1e-9 && Math.abs(c.fundingPaid + 0.1) < 1e-9 && Math.abs(c.netPnl + 4) < 1e-9);
});

// ---------------------------------------------------------------- items 5 / 6
const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c });

test('scorecard: first touch decides; a bar touching both counts as the stop; returns wait for enough time', () => {
  const t0 = 0;
  const up = [bar(0, 100, 101, 99.5, 100.5), bar(HOUR, 100.5, 104.2, 100, 104)];
  assert.equal(resolveOutcome(100, 1, 2, 4, t0, up).outcome, 'target');
  assert.equal(resolveOutcome(100, -1, 2, 4, t0, up).outcome, 'stop'); // the same move stops a short
  assert.equal(resolveOutcome(100, 1, 2, 4, t0, [bar(0, 100, 104.5, 97.5, 101)]).outcome, 'stop');
  const quiet = resolveOutcome(100, 1, 5, 10, t0, up);
  assert.equal(quiet.outcome, null);
  assert.equal(quiet.ret1d, null, 'no 1-day return until a day of bars exists');
  const day = Array.from({ length: 25 }, (_, i) => bar(i * HOUR, 100, 100.5, 99.5, 100 + i * 0.1));
  const r = resolveOutcome(100, -1, 5, 10, t0, day);
  assert.ok(Math.abs(r.ret1d! - -2.3) < 1e-9, 'close of the 24th bar, signed for a short');
});

test('scorecard tables: hit rate, average R and the level-versus-volatility split', () => {
  const idea = (o: Partial<Parameters<typeof buildScorecard>[0][number]>) => ({ bias: 'long' as const, strength: 'strong', stopKind: 'level' as const, stopPct: 2, targetPct: 4, outcome: null, ret1d: null, ret3d: null, ret7d: null, ...o });
  const rows = buildScorecard([
    idea({ outcome: 'target', ret1d: 1 }), idea({ outcome: 'stop', ret1d: -1 }), idea({ outcome: 'stop', stopKind: 'volatility', bias: 'short' }), idea({}),
  ]);
  const by = (g: string) => rows.find(r => r.group === g)!;
  assert.equal(by('All ideas').ideas, 4);
  assert.equal(by('All ideas').decided, 3);
  assert.ok(Math.abs(by('All ideas').hitRate! - 100 / 3) < 1e-9);
  assert.equal(by('All ideas').avgR, 0); // +2R, -1R, -1R
  assert.equal(by('Stop beyond a level').avgR, 0.5);
  assert.equal(by('Stop from volatility only').hitRate, 0);
  assert.equal(by('All ideas').avgRet1d, 0);
  assert.equal(by('Short').ideas, 1);
});

// ---------------------------------------------------------------- items 12 / 13
test('health: a job is down once it has not succeeded for 20 minutes or has never reported', () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const checks = evaluateHealth([{ key: 'scan', ok: true, detail: null, last_ok_at: ago(6) }, { key: 'market', ok: false, detail: 'boom', last_ok_at: ago(45) }], now);
  assert.equal(checks.find(c => c.key === 'scan')!.ok, true);
  const market = checks.find(c => c.key === 'market')!;
  assert.equal(market.ok, false);
  assert.match(market.detail!, /45 minutes ago: boom/);
  assert.equal(evaluateHealth([], now).every(c => !c.ok && c.detail === 'Has never reported'), true);
});

test('daily summary states the day\'s change, positions and what the Autopilot did, and says when there is nothing', () => {
  const text = buildDailySummary({
    day: '2026-11-21', equity: 1_050, dayStartEquity: 1_000,
    positions: [{ symbol: 'BTC', side: 'long', size: 0.01, entryPrice: 60_000, unrealizedPnl: 12.5 }],
    closedTrades: [{ symbol: 'ETH', side: 'short', pnl: 10, net_pnl: 8 }, { symbol: 'SOL', side: 'long', pnl: -3 }],
    autopilotEvents: [{ level: 'trade', symbol: 'BTC', message: 'Opened long' }, { level: 'info', symbol: null, message: 'noise' }],
    autopilot: { enabled: true, mode: 'paper', paperEquity: 10_111 },
  });
  assert.match(text, /Account value: \$1,050 \(\+\$50 on the day, 5\.00%/);
  assert.match(text, /BTC long 0\.01 @ 60000, unrealised \$12\.5/);
  assert.match(text, /Trades closed: 2, total \$5 /); // 8 net + (-3) price move
  assert.match(text, /Autopilot \(paper, paper balance \$10,111\):\n {2}BTC Opened long/);
  assert.doesNotMatch(text, /noise/);
  const quiet = buildDailySummary({ day: 'd', equity: 5, dayStartEquity: null, positions: [], closedTrades: [], autopilotEvents: [], autopilot: { enabled: false, mode: 'paper', paperEquity: null } });
  assert.match(quiet, /Open positions: none\nTrades closed: none\nAutopilot: off/);
});

// ---------------------------------------------------------------- items 7 / 9
test('journal: trades are tagged by how they related to the read and the suggested stop', () => {
  assert.deepEqual(journalTags({ side: 'long', stopLossPct: 2.5, context: { bias: 'long', suggestedStopPct: 2.5 }, note: '  breakout  ' }), { read: 'followed', stop: 'suggested', note: 'breakout' });
  assert.deepEqual(journalTags({ side: 'short', stopLossPct: 1, context: { bias: 'long', suggestedStopPct: 2.5 } }), { read: 'against', stop: 'changed' });
  assert.deepEqual(journalTags({ side: 'long', stopLossPct: null, context: { bias: 'neutral' } }), { read: 'no_read', stop: 'none' });
  assert.deepEqual(journalTags({ side: 'long', stopLossPct: 2, context: null }), { read: 'no_read', stop: 'changed' });
});

const trade = (t: Partial<Trade>): Trade => ({
  id: 'x', user_id: USER, symbol: 'BTC', side: 'long', status: 'closed', entry_price: 100, size: 1, size_usd: 100, leverage: 1, pnl: 0,
  entry_time: '2026-11-01T00:00:00Z', exit_time: '2026-11-02T00:00:00Z', signal_source: 'manual', created_at: '', updated_at: '', ...t,
});

test('analytics: trade statistics are net of fees and funding, and grouped by journal tag', () => {
  const trades = [
    trade({ id: 'a', pnl: 10, fees: 1, funding_paid: 2, webhook_payload: { journal: { read: 'followed', stop: 'suggested' } } }), // net +7
    trade({ id: 'b', pnl: 1, net_pnl: -0.5, fills_synced_at: 'x', webhook_payload: { journal: { read: 'against', stop: 'changed' } } }), // a "win" before costs, a loss after
    trade({ id: 'c', pnl: -6, signal_source: 'webhook' }),
    trade({ id: 'd', status: 'open', pnl: null }),
  ];
  const m = calculateAnalytics(trades);
  assert.equal(m.totalTrades, 3);
  assert.equal(m.totalPnl, 0.5);
  assert.equal(m.winningTrades, 1);
  assert.equal(m.losingTrades, 2);
  assert.equal(m.costedTrades, 1);
  assert.ok(Math.abs(m.profitFactor - 7 / 6.5) < 1e-9);
  const tags = resultsByTag(trades);
  assert.deepEqual(tags.read.map(r => [r.tag, r.trades, r.total]), [['Followed the read', 1, 7], ['Against the read', 1, -0.5], ['No read', 0, 0]]);
});

test('analytics: account return ignores deposits, drawdown is measured on equity, Sharpe needs 30 days', () => {
  const day = 86_400_000;
  // 1,000 grows 10% to 1,100; then 1,000 is deposited (P&L unchanged); then it loses 5% of 2,100.
  const h = {
    equity: [{ t: 0, v: 1_000 }, { t: day, v: 1_100 }, { t: 2 * day, v: 2_100 }, { t: 3 * day, v: 1_995 }],
    pnl: [{ t: 0, v: 0 }, { t: day, v: 100 }, { t: 2 * day, v: 100 }, { t: 3 * day, v: -5 }],
    volumeUsd: 0,
  };
  const s = equityStats(h);
  assert.ok(Math.abs(s.returnPct! - (1.1 * 0.95 - 1) * 100) < 1e-9, 'the deposit is not counted as profit');
  assert.ok(Math.abs(s.maxDrawdownPct! - 5) < 1e-9);
  assert.equal(s.sharpe, null);
  assert.equal(s.days, 3);
  assert.equal(equityStats(null).returnPct, null);
  // 40 days of alternating +1% / -0.5% gives a defined, positive Sharpe.
  const eq = [{ t: 0, v: 1_000 }], pnl = [{ t: 0, v: 0 }];
  for (let i = 1; i <= 40; i++) { const prev = eq[i - 1].v, d = prev * (i % 2 ? 0.01 : -0.005); eq.push({ t: i * day, v: prev + d }); pnl.push({ t: i * day, v: pnl[i - 1].v + d }); }
  assert.ok(equityStats({ equity: eq, pnl, volumeUsd: 0 }).sharpe! > 0);
});

// ---------------------------------------------------------------- items 14 / 15
/** Flat hourly bars at 100 with steady volume, then one final UTC day that breaks out (or down) on heavy volume. */
function dailyBreakout(direction: 1 | -1, volumeMultiple: number): Bar[] {
  const days = WARMUP_BARS / 24 + 2, start = Date.UTC(2026, 0, 1);
  const bars: Bar[] = [];
  for (let d = 0; d < days; d++) for (let hr = 0; hr < 24; hr++) {
    const last = d === days - 1;
    const px = last ? 100 + direction * (2 + hr * 0.1) : 100 + (hr % 2 ? 0.2 : -0.2);
    bars.push({ t: start + (d * 24 + hr) * HOUR, o: px, h: px + 0.1, l: px - 0.1, c: px, v: last ? 100 * volumeMultiple : 100 });
  }
  return bars;
}

test('volume breakout: fires only on the daily close, needs 1.5x volume, mirrors for shorts, and is paper-only', () => {
  const s = getStrategy('volume_breakout')!;
  assert.equal(s.paperOnly, true);
  const up = dailyBreakout(1, 2), ind = computeIndicators(up), i = up.length - 1;
  assert.equal(ind.d.fresh[i], true);
  const sig = s.evaluate(ind, up, i, 0, true);
  assert.equal(sig.target, 1);
  assert.ok(sig.stopPct > 0.004 && sig.stopPct <= 0.15);
  assert.equal(s.evaluate(ind, up, i - 1, 0, true).target, 0, 'mid-day: wait for the daily close');
  const quiet = dailyBreakout(1, 1.2);
  assert.equal(s.evaluate(computeIndicators(quiet), quiet, i, 0, true).target, 0, 'a break on ordinary volume does not count');
  const down = dailyBreakout(-1, 2), dInd = computeIndicators(down);
  assert.equal(s.evaluate(dInd, down, i, 0, true).target, -1);
  assert.equal(s.evaluate(dInd, down, i, 0, false).target, 0);
  // A long is closed by a daily close under the 10-day low; otherwise held.
  assert.equal(s.evaluate(dInd, down, i, 1, true).target, 0);
  assert.equal(s.evaluate(ind, up, i, 1, true).target, 1);
});

test('drift: the replay sizes trades the way the paper book does and lines up with the paper record by time', () => {
  const bars = dailyBreakout(1, 2);
  // Add two more days: one holding, one collapsing through the 10-day low, so the replay opens and closes a trade.
  const t0 = bars[bars.length - 1].t + HOUR;
  for (let hr = 0; hr < 48; hr++) { const px = hr < 24 ? 105 : 90; bars.push({ t: t0 + hr * HOUR, o: px, h: px + 0.1, l: px - 0.1, c: px, v: 100 }); }
  const since = bars[WARMUP_BARS].t, now = bars[bars.length - 1].t + HOUR;
  const [d] = computeDrift({
    strategyIds: ['volume_breakout', 'xs_momentum_90'], symbols: ['BTC'], bars: new Map([['BTC', bars]]), allowShort: false,
    risk: DEFAULT_RISK, equity: 10_000, since, now, paper: [{ strategyId: 'volume_breakout', exitTime: now - HOUR, pnl: -40 }],
  });
  assert.equal(d.id, 'volume_breakout'); // the basket has no per-market replay and is left out
  assert.equal(d.replayTrades, 1);
  assert.ok(d.replayPnl < 0, 'bought the breakout, sold the collapse');
  assert.equal(d.paperPnl, -40);
  assert.equal(d.points[0].paper, 0);
  assert.equal(d.points[d.points.length - 1].replay, d.replayPnl);
});
