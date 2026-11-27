import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { DAY, isoDay, type DayBar } from '../lib/forward-tests/crowded-break';
import { BASKET_COINS, BASKET_FEE, BASKET_START, dailyFunding, pickBasket, rankingRate, rebalanceCost, summariseBasket, WEEK, weekFunding, weekResult,
  weights, type BasketWeek, type FundingPrint } from '../lib/forward-tests/funding-basket';
import { readFundingBasket, runFundingBasket, type BasketFeed } from '../lib/forward-tests/basket-run';
import { memoryDb } from './helpers';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);
const HOUR = 3_600_000;
/** 24 prints a day at a constant hourly rate, stamped just after each hour like the venue's. */
const prints = (from: number, to: number, hourly: number): FundingPrint[] => {
  const out: FundingPrint[] = [];
  for (let t = from; t < to; t += HOUR) out.push({ time: t + 61, rate: hourly });
  return out;
};

test('hourly funding is grouped into whole UTC days, and the ranking uses the 30 days before the Monday', () => {
  const monday = BASKET_START;
  const days = dailyFunding([...prints(monday - 31 * DAY, monday - 2 * DAY, 0.00001), ...prints(monday - DAY, monday + DAY, 0.00005)], monday - 30 * DAY, monday);
  assert.equal(days.length, 30);
  near(days[0].sum, 24 * 0.00001); assert.equal(days[0].prints, 24);
  assert.deepEqual([days[28].sum, days[28].prints], [0, 0], 'a day with no prints is kept as a gap');
  near(days[29].sum, 24 * 0.00005);
  // Prints on or after the Monday are never part of the ranking.
  const ranked = rankingRate(days, monday);
  assert.equal(ranked.days, 29);
  near(ranked.mean!, (28 * 24 * 0.00001 + 24 * 0.00005) / 29);
  assert.equal(rankingRate([], monday).mean, null);

  // The held week is the seven days before the Monday, and needs all seven.
  assert.equal(weekFunding(days, monday), null, 'one of the seven days has no prints');
  const full = dailyFunding(prints(monday - 8 * DAY, monday + DAY, 0.00002), monday - 30 * DAY, monday);
  near(weekFunding(full, monday)!, 7 * 24 * 0.00002);
});

test('the basket shorts the quarter paying the most funding and goes long the quarter paying the least', () => {
  const ranking = BASKET_COINS.map((symbol, i) => ({ symbol, mean: (i - 7) * 0.0001 }));
  const basket = pickBasket(ranking)!;
  assert.deepEqual(basket.shorts, ['XRP', 'XLM', 'TRX', 'SOL']);
  assert.deepEqual(basket.longs, ['AAVE', 'ADA', 'ATOM', 'AVAX']);
  // Ten coins: floor(10 / 4) = 2 a side. Seven: too few to rank.
  assert.equal(pickBasket(ranking.slice(0, 10))!.shorts.length, 2);
  assert.equal(pickBasket(ranking.slice(0, 7)), null);
  // Ties are broken by name, so the same data always gives the same basket.
  const tied = pickBasket(BASKET_COINS.slice(0, 8).map(symbol => ({ symbol, mean: 0 })))!;
  assert.deepEqual(tied, { shorts: ['AAVE', 'ADA'], longs: ['DOGE', 'BTC'] });

  const w = weights(basket);
  near(w.get('XRP')!, -0.125); near(w.get('AAVE')!, 0.125);
  near([...w.values()].reduce((sum, v) => sum + Math.abs(v), 0), 1);
});

test('fees are paid only on the weight that changes hands', () => {
  const a = { longs: ['A', 'B'], shorts: ['C', 'D'] };
  near(rebalanceCost(null, a).traded, 1);
  near(rebalanceCost(null, a).cost, BASKET_FEE);
  near(rebalanceCost(a, a).cost, 0);
  // One long swapped: a quarter sold and a quarter bought.
  near(rebalanceCost(a, { longs: ['A', 'E'], shorts: ['C', 'D'] }).traded, 0.5);
  // A coin moving from long to short trades its weight twice.
  near(rebalanceCost(a, { longs: ['A', 'E'], shorts: ['C', 'B'] }).traded, 0.25 + 0.5 + 0.25);
  near(rebalanceCost(a, null).traded, 1);
});

test('a held week nets the price move of both sides and the funding each side pays or receives', () => {
  const basket = { longs: ['A', 'B'], shorts: ['C', 'D'] };
  const entry = { A: 100, B: 10, C: 50, D: 5 }, exit = { A: 110, B: 10, C: 45, D: 5 };
  const result = weekResult(basket, entry, exit, { A: -0.002, B: 0.001, C: 0.004, D: 0 })!;
  near(result.price, 0.25 * 0.1 + 0.25 * 0.1);       // long A up 10%, short C down 10%
  near(result.funding, 0.25 * 0.002 - 0.25 * 0.001 + 0.25 * 0.004); // long A is paid, long B pays, short C receives
  assert.equal(weekResult(basket, entry, { A: 110, B: 10, C: 45 }, { A: 0, B: 0, C: 0, D: 0 }), null, 'a leg with no exit price');
  assert.equal(weekResult(basket, entry, exit, { A: 0, B: 0, C: 0 }), null, 'a leg with no funding');
});

test('the summary charges each week the fee that set its basket and keeps price, funding and costs apart', () => {
  const row = (week: BasketWeek['week'], cost: number): BasketWeek => ({ basket: { longs: ['A', 'B'], shorts: ['C', 'D'] }, prices: {}, rates: {}, week, traded: cost / BASKET_FEE, cost });
  const s = summariseBasket([row(null, 0.001), row({ price: 0.02, funding: 0.001 }, 0.0005), row({ price: -0.01, funding: 0.002 }, 0)]);
  assert.equal(s.weeks, 2);
  near(s.price, 0.01); near(s.funding, 0.003); near(s.costs, 0.0015); near(s.net, 0.0115);
  assert.equal(s.positive, 1, 'week one nets +0.020, week two nets -0.0085');
  const nets = [0.02 + 0.001 - 0.001, -0.01 + 0.002 - 0.0005], mean = (nets[0] + nets[1]) / 2;
  near(s.tStat!, mean / (Math.sqrt(((nets[0] - mean) ** 2 + (nets[1] - mean) ** 2) / 1) / Math.sqrt(2)));
  assert.deepEqual(summariseBasket([]), { weeks: 0, price: 0, funding: 0, costs: 0, net: 0, positive: 0, tStat: null });
});

test('the weekly pass fills funding gradually, sets a basket, scores the held week and never logs from a failed read', async () => {
  const { db, tables } = memoryDb();
  // Coin i pays an hourly rate that rises with i, so the last four are shorted and the first four held long.
  const hourly = (symbol: string) => (BASKET_COINS.indexOf(symbol as never) - 7.5) * 1e-6;
  let calls = 0, failing = false, priceStep = 0;
  const feed: BasketFeed = {
    fundingPrints: async (symbol, from, to) => { calls += 1; if (failing) throw new Error('HTTP 429'); return prints(Math.floor(from / HOUR) * HOUR, to, hourly(symbol)); },
    dailyBars: async (symbol, from): Promise<DayBar[]> => {
      // Every coin opens at 100 on the first Monday; a week later the longs are up 2% and the shorts down 1%.
      const i = BASKET_COINS.indexOf(symbol as never), weeks = Math.round((from - BASKET_START) / WEEK);
      const move = weeks * priceStep * (i < 4 ? 0.02 : i >= 12 ? -0.01 : 0);
      return [{ t: from, o: 100 * (1 + move), h: 101, l: 99, c: 100 }];
    },
  };
  const at = BASKET_START + 30 * DAY; // well after the first two Mondays, so both are worked from history

  assert.deepEqual(await runFundingBasket(db, BASKET_START + 60_000, feed, 0), { status: 'waiting' });

  // 30 days is two pages a coin and the budget is eight pages: four coins a run.
  assert.equal((await runFundingBasket(db, at, feed, 0)).status, 'filling');
  assert.equal(calls, 4);
  assert.equal(tables.forward_funding_daily.length, 4 * 30);
  assert.equal(tables.forward_test_days?.length ?? 0, 0);

  // A rate-limited run keeps what it has and logs nothing.
  failing = true;
  const blocked = await runFundingBasket(db, at, feed, 0);
  assert.equal(blocked.status, 'filling');
  assert.equal(tables.forward_funding_daily.length, 4 * 30);
  failing = false;

  for (let run = 0; run < 3; run++) await runFundingBasket(db, at, feed, 0);
  const [first] = tables.forward_test_days;
  assert.equal(first.day, isoDay(BASKET_START));
  const detail = first.detail as BasketWeek;
  assert.deepEqual(detail.basket, { shorts: ['XRP', 'XLM', 'TRX', 'SOL'], longs: ['AAVE', 'ADA', 'ATOM', 'AVAX'] });
  assert.equal(detail.week, null, 'nothing was held before the first Monday');
  near(detail.cost, BASKET_FEE);
  assert.equal(Object.keys(detail.prices).length, 16);

  // The next Monday needs only seven more days a coin: one page each, eight coins a run.
  priceStep = 1;
  calls = 0;
  assert.equal((await runFundingBasket(db, at, feed, 0)).status, 'filling');
  assert.equal(calls, 8);
  const second = await runFundingBasket(db, at, feed, 0);
  assert.equal(second.status, 'logged');
  assert.equal(second.day, isoDay(BASKET_START + WEEK));
  near(second.week!.price, 0.5 * 0.02 + 0.5 * 0.01);
  // Shorts receive their positive funding and longs are paid on their negative rate, for 168 hours.
  const expected = [12, 13, 14, 15].reduce((sum, i) => sum + 0.125 * (i - 7.5) * 1e-6 * 168, 0) - [0, 1, 2, 3].reduce((sum, i) => sum + 0.125 * (i - 7.5) * 1e-6 * 168, 0);
  near(second.week!.funding, expected);
  near((tables.forward_test_days[1].detail as BasketWeek).cost, 0); // the same basket again costs nothing

  const report = await readFundingBasket(db);
  assert.equal(report.summary.weeks, 1);
  near(report.summary.net, 0.015 + expected - BASKET_FEE);
  assert.deepEqual(report.current!.shorts.map(leg => leg.symbol), ['XRP', 'XLM', 'TRX', 'SOL']);
  assert.equal(report.weeks.length, 1);
  near(report.weeks[0].cost, BASKET_FEE);
  assert.equal(report.lastRebalance, isoDay(BASKET_START + WEEK));
});

test('migration 029 keeps the funding cache server-only', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const sql = readFileSync('supabase/migrations/029_forward_funding_daily.sql', 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // running it twice is harmless
    const can = async (role: string, privilege: string) => (await pg.query<{ ok: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.forward_funding_daily', privilege])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) assert.equal(await can(role, 'SELECT'), false, role);
    assert.equal(await can('service_role', 'INSERT'), true);
    await pg.exec("INSERT INTO public.forward_funding_daily VALUES ('BTC', '2026-11-01', 0.00024, 24)");
    await assert.rejects(pg.exec("INSERT INTO public.forward_funding_daily VALUES ('BTC', '2026-11-01', 0.0001, 24)"), /duplicate key/);
  } finally {
    await pg.close();
  }
});
