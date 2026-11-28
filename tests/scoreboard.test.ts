import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreboard, crowdedBreakTest, dailyResults, eventTests, fundingBasketTest, fundingHedgeTest, momentumTest, onePerCoin,
  paperRuleTests, scoreTest, type Close, type PaperPosition, type TestInput } from '../lib/automation/scoreboard';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);
const iso = (t: number) => new Date(t).toISOString();
const near = (actual: number | null | undefined, expected: number) => assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
const position = (over: Partial<PaperPosition>): PaperPosition => ({ strategy_id: 'trend_pullback', symbol: 'BTC', side: 'short', status: 'closed',
  entry_time: iso(T0), exit_time: iso(T0 + DAY), pnl: 10, notional_usd: 1000, ...over });
const input = (over: Partial<TestInput>): TestInput => ({ id: 'x', name: 'X', detail: '', market: 'crypto', unit: 'trades', start: T0,
  capitalUsd: null, closes: [], open: 0, ...over });

test('one position per rule and coin: stacked entries drop out, other coins and rules stay', () => {
  const rows = [
    position({ entry_time: iso(T0), exit_time: iso(T0 + 2 * DAY), pnl: 5 }),
    position({ entry_time: iso(T0 + DAY), exit_time: iso(T0 + 3 * DAY), pnl: 50 }), // opened while the first was still open
    position({ entry_time: iso(T0 + 2 * DAY), exit_time: iso(T0 + 4 * DAY), pnl: 7 }), // opened as the first closed
    position({ symbol: 'ETH', entry_time: iso(T0 + DAY), pnl: 1 }),
    position({ strategy_id: 'trend_breakout', entry_time: iso(T0 + DAY), pnl: 2 }),
    position({ symbol: 'SOL', status: 'open', exit_time: null, pnl: null }),
    position({ symbol: 'SOL', entry_time: iso(T0 + 5 * DAY), exit_time: iso(T0 + 6 * DAY), pnl: 3 }), // the open SOL position blocks it
  ];
  assert.deepEqual(onePerCoin(rows).map(row => String(row.pnl)).sort(), ['1', '2', '5', '7', 'null']);
});

test('a test is scored as a share of its capital, against HLP over the same days', () => {
  const closes: Close[] = [{ at: T0 + DAY, value: 0.02, asset: 'BTC' }, { at: T0 + 2 * DAY, value: -0.03, asset: 'ETH' }, { at: T0 + 3 * DAY, value: 0.05, asset: 'BTC' }];
  const row = scoreTest(input({ capitalUsd: 10_000, closes, open: 1 }), T0 + 10 * DAY, 0.1);
  assert.equal(row.closed, 3);
  near(row.ret, 0.04);
  near(row.netUsd, 400);
  near(row.drawdown, 0.03);
  near(row.hlp, 1.1 ** (10 / 365) - 1);
  assert.equal(row.best?.asset, 'BTC');
  near(row.best?.without, -0.03);
  assert.equal(row.verdict, 'Ahead of HLP so far');
  assert.deepEqual(row.missing, ['46 more days', '47 more trades']);
  assert.deepEqual(row.checks.map(check => check.met), [false, false, true, true, false, false]);
  assert.equal(row.ready, false);
  assert.equal(row.started, '2026-11-01');
});

test('trades are judged by day: results closing on the same day count once, quiet days count as zero', () => {
  const closes: Close[] = [{ at: T0 + 3_600_000, value: 0.01 }, { at: T0 + 5 * 3_600_000, value: 0.02 }, { at: T0 + 2 * DAY, value: -0.005 }];
  const days = dailyResults(closes, T0, T0 + 3 * DAY);
  assert.equal(days.length, 4);
  near(days[0], 0.03);
  assert.equal(days[1], 0);
  near(days[2], -0.005);
});

test('a test meets the bar only with time, results, a lead over HLP, a small drop, breadth and a reliable average', () => {
  const now = T0 + 60 * DAY;
  const closes = Array.from({ length: 60 }, (_, i) => ({ at: T0 + i * DAY + 3_600_000, value: i % 4 === 0 ? -0.001 : 0.003, asset: ['BTC', 'ETH', 'SOL'][i % 3] }));
  const good = scoreTest(input({ capitalUsd: 18_000, closes }), now, 0.09);
  assert.equal(good.ready, true);
  assert.equal(good.verdict, 'Meets the bar');
  assert.deepEqual(good.missing, []);
  near(good.ret, 0.12);

  const oneCoin = scoreTest(input({ closes: closes.map(close => ({ ...close, asset: 'ZEC' })) }), now, 0.09);
  assert.equal(oneCoin.ready, false);
  assert.equal(oneCoin.checks[4].met, false, 'all of the profit rests on one coin');

  const deepDrop = scoreTest(input({ closes: [...closes, { at: T0 + 20 * DAY, value: -0.11, asset: 'BTC' }, { at: T0 + 40 * DAY, value: 0.11, asset: 'ETH' }] }), now, 0.09);
  assert.equal(deepDrop.checks[3].met, false);
  assert.equal(deepDrop.ready, false);

  const behind = scoreTest(input({ closes }), now, 2);
  assert.equal(behind.verdict, 'Behind HLP so far');
  assert.equal(behind.ready, false);

  const losing = scoreTest(input({ closes: closes.map(close => ({ ...close, value: -close.value })) }), now, 0.09);
  assert.equal(losing.verdict, 'Losing so far');
});

test('paper rules become one line per rule and direction, on the stake for every coin, without stacked entries', () => {
  const rows = [
    position({ pnl: 18, entry_time: iso(T0), exit_time: iso(T0 + 2 * DAY) }),
    position({ pnl: 999, entry_time: iso(T0 + DAY), exit_time: iso(T0 + 3 * DAY) }),
    position({ side: 'long', symbol: 'ETH', pnl: -9, entry_time: iso(T0 + DAY), exit_time: iso(T0 + 2 * DAY) }),
    position({ side: 'long', symbol: 'SOL', status: 'open', exit_time: null, pnl: null }),
    position({ strategy_id: 'xs_momentum_90', pnl: 50 }),
  ];
  const tests = paperRuleTests(rows, 18);
  assert.equal(tests.length, 10, 'five rules, long and short');
  const short = tests.find(t => t.id === 'paper.trend_pullback.short')!;
  assert.equal(short.capitalUsd, 18_000);
  assert.equal(short.closes.length, 1);
  near(short.closes[0].value * 18_000, 18);
  assert.equal(short.start, T0);
  const long = tests.find(t => t.id === 'paper.trend_pullback.long')!;
  assert.deepEqual([long.closes.length, long.open], [1, 1]);
  assert.equal(tests.find(t => t.id === 'paper.momentum_burst.long')!.capitalUsd, null);

  // An older entry sized another way does not change the stake the line is measured on.
  const odd = paperRuleTests([...rows, position({ symbol: 'XRP', notional_usd: 2443.24, entry_time: iso(T0 + 9 * DAY), exit_time: iso(T0 + 10 * DAY) })], 18);
  assert.equal(odd.find(t => t.id === 'paper.trend_pullback.short')!.capitalUsd, 18_000);
});

test('the momentum basket is measured on the most it had open at once', () => {
  const leg = (over: Partial<PaperPosition>) => position({ strategy_id: 'xs_momentum_90', notional_usd: 500, exit_time: iso(T0 + 7 * DAY), ...over });
  const basket = momentumTest([leg({ symbol: 'A', side: 'long', pnl: 20 }), leg({ symbol: 'B', side: 'short', pnl: -5 }),
    leg({ symbol: 'C', side: 'long', notional_usd: 600, entry_time: iso(T0 + 7 * DAY), status: 'open', exit_time: null, pnl: null })]);
  assert.equal(basket.capitalUsd, 1000, 'the week-two leg opens after both week-one legs closed');
  assert.deepEqual(basket.closes.map(close => close.value), [0.02, -0.005]);
  assert.equal(basket.open, 1);
  assert.equal(momentumTest([]).start, null);
});

test('record-only tests and event studies keep their own units', () => {
  const basket = fundingBasketTest([{ ended: '2026-11-16', price: 0.03, funding: 0.001, cost: 0.0005 }], T0, true);
  near(basket.closes[0].value, 0.0305);
  assert.deepEqual([basket.unit, basket.open], ['weeks', 1]);

  const crowded = crowdedBreakTest([{ symbol: 'BTC', status: 'closed', exit_day: '2026-11-20', net: 0.09 },
    { symbol: 'ETH', status: 'open', exit_day: null, net: null }], T0, 18);
  near(crowded.closes[0].value, 0.005);
  assert.equal(crowded.open, 1);

  const hedge = fundingHedgeTest([{ symbol: 'BTC', at: iso(T0 + DAY), net: 25 }], T0, 1, 2500, ['BTC', 'ETH']);
  assert.equal(hedge.capitalUsd, 5000);
  near(hedge.closes[0].value, 0.005);

  const [unlock, supplier] = eventTests([
    { id: 'unlock', name: 'Token unlocks', rule: 'Short the unlocking coin against ETH', results: [{ date: '2026-11-10', net: 0.012 }, { date: '2026-11-03', net: null }] },
    { id: 'supplier', name: 'Suppliers', rule: 'Long the strongest supplier', needsConnection: true, results: [] },
  ]);
  assert.deepEqual([unlock.market, unlock.closes.length, unlock.start], ['crypto', 1, Date.UTC(2026, 10, 10)]);
  assert.equal(supplier.market, 'stocks');
  assert.equal(scoreTest(supplier, T0, 0.09).verdict, 'Connect eToro Demo to run this test');
});

test('the scoreboard ranks by money made, then tests with nothing closed, then any that could not be read', () => {
  const board = buildScoreboard([
    input({ id: 'small', closes: [{ at: T0 + DAY, value: 0.01 }] }),
    input({ id: 'none', open: 2 }),
    input({ id: 'broken', unavailable: 'Could not load this test' }),
    input({ id: 'down', closes: [{ at: T0 + DAY, value: -0.02 }] }),
    input({ id: 'big', closes: [{ at: T0 + DAY, value: 0.05 }] }),
  ], T0 + 5 * DAY, 0.08);
  assert.deepEqual(board.rows.map(row => row.id), ['big', 'small', 'down', 'none', 'broken']);
  assert.equal(board.rows[3].verdict, 'Open, nothing closed yet');
  assert.equal(board.hlpAnnual, 0.08);
});
