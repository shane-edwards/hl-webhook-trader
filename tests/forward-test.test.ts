import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { advance, confirmedOn, DAY, entrySignal, FEE, isoDay, quantile, scoreline, setupOn, stopPrice, tradeResult,
  type DayBar, type Positioning } from '../lib/forward-tests/crowded-break';
import { runCrowdedBreak, SEED_THROUGH, type ForwardFeed } from '../lib/forward-tests/run';
import { memoryDb } from './helpers';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);
const D0 = Date.UTC(2026, 5, 1);
const day = (n: number) => D0 + n * DAY;

/** 70 days of flat positioning with a ratio that wobbles between 0.9 and 1.1, then whatever the test sets. */
function flatHistory(overrides: Record<number, Positioning> = {}) {
  const history = new Map<number, Positioning>();
  for (let n = 0; n < 70; n++) history.set(day(n), { oi: 1000, ratio: 0.9 + 0.2 * ((n * 7) % 11) / 10 });
  for (const [n, row] of Object.entries(overrides)) history.set(day(Number(n)), row);
  return history;
}
const flatBars = (from: number, to: number, price = 100): Map<number, DayBar> => {
  const bars = new Map<number, DayBar>();
  for (let n = from; n <= to; n++) bars.set(day(n), { t: day(n), o: price, h: price + 1, l: price - 1, c: price });
  return bars;
};

test('the quantile matches linear interpolation between ranks', () => {
  near(quantile([1, 2, 3, 4], 0.25), 1.75);
  near(quantile([4, 1, 3, 2], 0.75), 3.25);
  near(quantile([5], 0.25), 5);
});

test('a setup needs open interest to have built and the crowd to be at an extreme of the last 60 days', () => {
  // Open interest up 6% over five days and few accounts long: sets up a long.
  assert.equal(setupOn(flatHistory({ 69: { oi: 1061, ratio: 0.5 } }), day(69)), 'long');
  assert.equal(setupOn(flatHistory({ 69: { oi: 1061, ratio: 2 } }), day(69)), 'short');
  // An ordinary crowd, or open interest up only 5%, is no setup.
  assert.equal(setupOn(flatHistory({ 69: { oi: 1061, ratio: 1 } }), day(69)), null);
  assert.equal(setupOn(flatHistory({ 69: { oi: 1050, ratio: 0.5 } }), day(69)), null);
  // The crowd is compared with earlier days only: with every earlier reading at 1, a reading of 1 is no extreme
  // and one just below is, however extreme today's own value would make the window look.
  const level = new Map<number, Positioning>();
  for (let n = 0; n < 70; n++) level.set(day(n), { oi: 1000, ratio: 1 });
  assert.equal(setupOn(new Map(level).set(day(69), { oi: 1061, ratio: 1 }), day(69)), null);
  assert.equal(setupOn(new Map(level).set(day(69), { oi: 1061, ratio: 0.999 }), day(69)), 'long');
  // Too little history, or a missing reading five days back, gives no answer.
  const thin = flatHistory({ 69: { oi: 1061, ratio: 0.5 } });
  for (let n = 9; n < 16; n++) thin.delete(day(n));
  assert.equal(setupOn(thin, day(69)), null, 'fewer than 55 of the last 60 days');
  const gap = flatHistory({ 69: { oi: 1061, ratio: 0.5 } }); gap.delete(day(64));
  assert.equal(setupOn(gap, day(69)), null);
});

test('confirmation is a close beyond the previous five daily highs or lows, on the day after the setup', () => {
  const bars = flatBars(60, 72);
  bars.set(day(70), { t: day(70), o: 100, h: 104, l: 99, c: 103 });
  assert.equal(confirmedOn(bars, day(70), 'long'), true);
  assert.equal(confirmedOn(bars, day(70), 'short'), false);
  bars.set(day(70), { t: day(70), o: 100, h: 104, l: 99, c: 101 });
  assert.equal(confirmedOn(bars, day(70), 'long'), false, 'a close equal to the prior high is not a break');
  bars.delete(day(66));
  assert.equal(confirmedOn(bars, day(70), 'long'), false, 'a missing prior day gives no confirmation');

  // Setup on day 69, confirmation on day 70, entry at the open of day 71 and on no other day.
  const history = flatHistory({ 69: { oi: 1061, ratio: 0.5 } });
  const up = flatBars(60, 72); up.set(day(70), { t: day(70), o: 100, h: 104, l: 99, c: 103 });
  assert.equal(entrySignal(history, up, day(71)), 'long');
  assert.equal(entrySignal(history, up, day(72)), null);
  assert.equal(entrySignal(history, flatBars(60, 72), day(71)), null, 'no break, so the setup expires');
});

test('an open trade leaves at the stop, at a gap through it, or at the open seven days on', () => {
  const trade = { side: 'long' as const, entryDay: day(0), entryPrice: 100, stop: stopPrice(100, 'long'), lastDay: day(-1) };
  near(trade.stop, 88);
  near(stopPrice(100, 'short'), 112);

  // Day 3 trades down to 87: out at the stop that day. Today's forming bar is never used for its low.
  const bars = flatBars(0, 9);
  bars.set(day(3), { t: day(3), o: 95, h: 96, l: 87, c: 90 });
  assert.deepEqual(advance(trade, bars, day(3)), { lastDay: day(2) }, 'day 3 is still forming');
  assert.deepEqual(advance(trade, bars, day(4)), { exit: { day: day(3), price: 88, reason: 'intraday_stop' } });

  // A low on the entry day itself counts, since the trade was open from that day's first price.
  const first = flatBars(0, 3); first.set(day(0), { t: day(0), o: 100, h: 100, l: 80, c: 85 });
  assert.deepEqual(advance(trade, first, day(1)), { exit: { day: day(0), price: 88, reason: 'intraday_stop' } });

  // Opening below the stop exits at that open, not at the stop.
  const gap = flatBars(0, 5); gap.set(day(2), { t: day(2), o: 80, h: 82, l: 79, c: 81 });
  assert.deepEqual(advance(trade, gap, day(2)), { exit: { day: day(2), price: 80, reason: 'gap_stop' } });

  // Nothing happens: out at the open of day 7. Resuming from a later day gives the same answer.
  assert.deepEqual(advance(trade, flatBars(0, 9), day(6)), { lastDay: day(5) });
  assert.deepEqual(advance({ ...trade, lastDay: day(5) }, flatBars(0, 9), day(7)), { exit: { day: day(7), price: 100, reason: 'time' } });
  assert.deepEqual(advance(trade, flatBars(0, 9), day(9)), { exit: { day: day(7), price: 100, reason: 'time' } });

  // A missing day stops the walk there so it is retried, never skipped.
  const hole = flatBars(0, 9); hole.delete(day(4));
  assert.deepEqual(advance(trade, hole, day(9)), { lastDay: day(3) });

  // A short mirrors it.
  const short = { side: 'short' as const, entryDay: day(0), entryPrice: 100, stop: 112, lastDay: day(-1) };
  const squeeze = flatBars(0, 4); squeeze.set(day(1), { t: day(1), o: 101, h: 113, l: 100, c: 110 });
  assert.deepEqual(advance(short, squeeze, day(2)), { exit: { day: day(1), price: 112, reason: 'intraday_stop' } });
});

test('a trade result nets the price move, funding and a fee on each side', () => {
  const long = tradeResult('long', 100, 110, [0.0001, 0.0002]);
  near(long.gross, 0.1); near(long.funding, 0.0003); near(long.net, 0.1 - 0.0003 - FEE * 2.1);
  const short = tradeResult('short', 100, 90, [0.0001, 0.0002]);
  near(short.gross, 0.1); near(short.funding, -0.0003); near(short.net, 0.1 + 0.0003 - FEE * 1.9);

  const score = scoreline([{ symbol: 'A', net: 0.1 }, { symbol: 'B', net: -0.02 }, { symbol: 'C', net: 0.04 }]);
  assert.equal(score.closed, 3); assert.equal(score.wins, 2); near(score.mean!, 0.04); near(score.total, 0.12);
  near(score.tStat!, 0.04 / (Math.sqrt((0.06 ** 2 + 0.06 ** 2) / 2) / Math.sqrt(3)));
  assert.equal(scoreline([]).mean, null);
  assert.equal(scoreline([{ symbol: 'A', net: 0.1 }]).tStat, null);
});

test('the daily pass enters at the open, carries the trade, closes it with funding, and works each day once', async () => {
  const { db, tables } = memoryDb();
  // Entry day E is two days after the seed ends, so the setup day is the last seeded day and the confirm day is fetched.
  const E = SEED_THROUGH + 2 * DAY, setup = SEED_THROUGH, confirm = SEED_THROUGH + DAY;
  const fetched: string[] = [];
  let published = true;
  const bars = (through: number, last?: Partial<DayBar>): DayBar[] => {
    const out: DayBar[] = [];
    for (let t = E - 12 * DAY; t <= through; t += DAY) out.push({ t, o: 100, h: 101, l: 99, c: 100 });
    out.find(bar => bar.t === confirm)!.c = 90; // breaks the previous five lows of 99
    out.find(bar => bar.t === confirm)!.l = 89;
    if (last) Object.assign(out[out.length - 1], last);
    return out;
  };
  let barsThrough = E;
  const feed: ForwardFeed = {
    // BTC's crowd is far more long than at any time in the seed and its open interest has jumped: a short setup.
    positioning: async (symbol, d) => { fetched.push(`${symbol} ${isoDay(d)}`); return published ? { oi: 1, ratio: 1 } : null; },
    dailyBars: async symbol => (symbol === 'BTC' ? bars(barsThrough) : []),
    funding: async () => [0.0001, 0.0001, 0.0001],
  };
  // Make the seeded setup day itself the extreme reading for BTC by storing an override row the run reads back.
  tables.forward_positioning = [{ symbol: 'BTC', day: isoDay(setup), open_interest: 1e12, account_ratio: 50 }];

  assert.deepEqual(await runCrowdedBreak(db, E + 60_000, feed), { status: 'waiting' }, 'the opening bar needs a few minutes');
  const first = await runCrowdedBreak(db, E + 10 * 60_000, feed);
  assert.equal(first.status, 'partial', 'the other coins have no bars here');
  assert.equal(first.entered, 1);
  assert.ok(fetched.includes(`BTC ${isoDay(confirm)}`), 'the day after the seed is fetched');
  const [trade] = tables.forward_trades;
  assert.deepEqual([trade.symbol, trade.side, trade.basket, trade.signal_day, trade.entry_day, trade.entry_price, trade.status],
    ['BTC', 'short', 'tested', isoDay(setup), isoDay(E), 100, 'open']);
  near(trade.stop_price as number, 112);
  assert.equal(tables.forward_test_days?.length ?? 0, 0, 'an incomplete morning pass is retried');

  // Later the same day it gives up on the coins with no data and logs the day; after that the day is not reworked.
  await runCrowdedBreak(db, E + 7 * 3_600_000, feed);
  assert.equal(tables.forward_test_days.length, 1);
  assert.equal(tables.forward_trades.length, 1, 'no second entry for the same coin');
  assert.deepEqual(await runCrowdedBreak(db, E + 8 * 3_600_000, feed), { status: 'done' });

  // Three days on the price has squeezed through the stop during the day before: closed at the stop, with funding credited to the short.
  barsThrough = E + 3 * DAY;
  const moved = bars(barsThrough);
  moved.find(bar => bar.t === E + 2 * DAY)!.h = 115;
  feed.dailyBars = async symbol => (symbol === 'BTC' ? moved : []);
  const later = await runCrowdedBreak(db, E + 3 * DAY + 7 * 3_600_000, feed);
  assert.equal(later.closed, 1);
  assert.deepEqual([trade.status, trade.exit_day, trade.exit_reason], ['closed', isoDay(E + 2 * DAY), 'intraday_stop']);
  near(trade.exit_price as number, 112);
  near(trade.gross as number, -0.12);
  near(trade.funding as number, -0.0003);
  near(trade.net as number, -0.12 + 0.0003 - FEE * 2.12);

  // A day whose archive is not published yet is not stored, and is asked for again next time.
  published = false;
  fetched.length = 0;
  await runCrowdedBreak(db, E + 4 * DAY + 7 * 3_600_000, feed);
  assert.ok(fetched.some(item => item.startsWith('ETH ')));
  assert.equal(tables.forward_positioning.filter(row => row.day === isoDay(E + 3 * DAY)).length, 0);
});

test('migration 028 keeps the forward test tables server-only and one trade per coin and entry day', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const sql = readFileSync('supabase/migrations/028_forward_tests.sql', 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // running it twice is harmless
    const can = async (role: string, table: string, privilege: string) => (await pg.query<{ ok: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, privilege])).rows[0].ok;
    for (const table of ['forward_positioning', 'forward_trades', 'forward_test_days']) {
      for (const role of ['anon', 'authenticated']) assert.equal(await can(role, table, 'SELECT'), false, `${role} ${table}`);
      assert.equal(await can('service_role', table, 'INSERT'), true, table);
    }
    assert.equal(await can('service_role', 'forward_trades', 'UPDATE'), true);
    assert.equal(await can('service_role', 'forward_trades', 'DELETE'), false);
    const insert = "INSERT INTO public.forward_trades (strategy, symbol, side, basket, signal_day, entry_day, entry_price, stop_price, last_day) VALUES ('crowded_break', 'BTC', 'short', 'tested', '2026-11-25', '2026-11-27', 100, 112, '2026-11-26')";
    await pg.exec(insert);
    await assert.rejects(pg.exec(insert), /duplicate key/);
    await assert.rejects(pg.exec(insert.replace("'short'", "'flat'").replace('2026-11-27', '2026-11-28')), /check constraint/);
  } finally {
    await pg.close();
  }
});
