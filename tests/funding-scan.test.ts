import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { buildScanRows, parsePredictedFundings, roundTripCost, summariseGaps, KEEP_DAYS, TAKER_FEE, type SummaryRow } from '../lib/funding-scan/model';
import { scanFundingGaps } from '../lib/funding-scan/scan';
import { memoryDb } from './helpers';

const close = (actual: number, expected: number, label?: string) =>
  assert.ok(Math.abs(actual - expected) <= 1e-12 + Math.abs(expected) * 1e-9, `${label ?? ''} ${actual} vs ${expected}`);

const quote = (rate: string, hours: number | null) => ({ fundingRate: rate, nextFundingTime: 1, fundingIntervalHours: hours });
// The shape Hyperliquid returns: [coin, [[venue, quote | null], ...]].
const PREDICTED = [
  ['BTC', [['BinPerp', quote('0.00008', 8)], ['HlPerp', quote('0.00002', 1)], ['BybitPerp', quote('0.00004', 4)]]],
  ['ETH', [['BinPerp', quote('0.0001', null)], ['HlPerp', quote('-0.00001', 1)], ['BybitPerp', null]]],
  ['SOL', [['HlPerp', quote('0.00003', 1)], ['BybitPerp', quote('-0.00008', 8)]]],
  ['QUIET', [['HlPerp', quote('0.0005', 1)], ['BinPerp', quote('0.0001', 4)]]],
  ['GONE', [['HlPerp', quote('0.0005', 1)], ['BinPerp', quote('0.0001', 4)]]],
  ['ODD', [['HlPerp', quote('not a number', 1)], ['BinPerp', quote('0.0001', 4)]]],
];
const ctx = (volume: string, impact?: [string, string]) => ({ funding: '0', dayNtlVlm: volume, impactPxs: impact });
const CONTEXTS = [
  { universe: [{ name: 'BTC' }, { name: 'ETH' }, { name: 'SOL' }, { name: 'QUIET' }, { name: 'GONE', isDelisted: true }, { name: 'ODD' }] },
  [ctx('2000000000', ['99990', '100010']), ctx('900000000', ['2000', '2001']), ctx('50000000'), ctx('999999', ['1', '1.01']),
    ctx('50000000', ['1', '1.01']), ctx('50000000', ['1', '1.01'])],
];

test('each venue is converted to funding per hour, and a venue with no interval is left out', () => {
  const rates = parsePredictedFundings(PREDICTED);
  close(rates.get('BTC')!.binance!, 0.00001);
  close(rates.get('BTC')!.hl!, 0.00002);
  close(rates.get('BTC')!.bybit!, 0.00001);
  assert.deepEqual(Object.keys(rates.get('ETH')!), ['hl'], 'Binance had no interval and Bybit had no quote');
  assert.equal(rates.get('ODD')!.hl, undefined);
  assert.equal(parsePredictedFundings(null).size, 0);
  assert.equal(parsePredictedFundings({ error: 'rate limited' }).size, 0);
});

test('a scan keeps busy markets that a second venue also quotes, busiest first', () => {
  const rows = buildScanRows(PREDICTED, CONTEXTS);
  // ETH has only Hyperliquid, QUIET is under the volume floor, GONE is delisted, ODD has no Hyperliquid rate.
  assert.deepEqual(rows.map(row => row.symbol), ['BTC', 'SOL']);
  close(rows[0].hl_spread!, 20 / 100_000);
  assert.equal(rows[1].hl_spread, null, 'no impact prices means the spread is unknown, not zero');
  assert.equal(rows[1].binance_rate, null);
  close(rows[1].bybit_rate!, -0.00001);
  assert.deepEqual(buildScanRows(PREDICTED, CONTEXTS, 1).map(row => row.symbol), ['BTC']);
  assert.deepEqual(buildScanRows(PREDICTED, null), []);
});

test('the round trip charges a taker fee on all four fills and one spread per leg', () => {
  close(roundTripCost('hl', 'bybit', 0.0002), 2 * (TAKER_FEE.hl + TAKER_FEE.bybit) + 0.0004);
  close(roundTripCost('binance', 'bybit', null), 2 * (TAKER_FEE.binance + TAKER_FEE.bybit));
});

const summaryRow = (over: Partial<SummaryRow>): SummaryRow => ({ symbol: 'BTC', scans: 288, hl_spread: 0.0001, hl_volume: 1e9,
  hl_binance_n: 0, hl_binance_gap: null, hl_binance_above: null, hl_bybit_n: 0, hl_bybit_gap: null, hl_bybit_above: null,
  binance_bybit_n: 0, binance_bybit_gap: null, binance_bybit_above: null, ...over });

test('the summary picks the pair with the best net result and holds its direction fixed', () => {
  const [gap] = summariseGaps([summaryRow({
    hl_binance_n: 288, hl_binance_gap: 0.00001, hl_binance_above: 0.9,
    hl_bybit_n: 288, hl_bybit_gap: -0.00003, hl_bybit_above: 0.2,
    binance_bybit_n: 288, binance_bybit_gap: -0.00004, binance_bybit_above: 0.25,
  })], [{ symbol: 'BTC', hl_rate: 0.00001, binance_rate: 0.00002, bybit_rate: 0.00001, hl_spread: 0.0001, hl_volume: 1e9 }]);
  // Bybit pays more than Binance on average: receive on Bybit (short), pay on Binance (long).
  assert.equal(gap.short, 'bybit');
  assert.equal(gap.long, 'binance');
  close(gap.gapHourly, 0.00004);
  close(gap.consistency, 0.75);
  assert.equal(gap.hoursObserved, 24);
  const cost = 2 * (TAKER_FEE.binance + TAKER_FEE.bybit) + 0.0002;
  close(gap.cost, cost);
  close(gap.breakEvenHours, cost / 0.00004);
  close(gap.netOverWindow, 0.00004 * 24 - cost);
  close(gap.annualPct, 0.00004 * 24 * 365 * 100);
  // Right now Binance pays more than Bybit, so the held direction is losing.
  close(gap.nowHourly!, -0.00001);
});

test('a pair seen in too few scans is ignored and results are ordered by net result', () => {
  const rows = [
    summaryRow({ symbol: 'THIN', hl_binance_n: 11, hl_binance_gap: 0.01, hl_binance_above: 1 }),
    summaryRow({ symbol: 'SMALL', hl_binance_n: 288, hl_binance_gap: 0.000001, hl_binance_above: 0.6 }),
    summaryRow({ symbol: 'WIDE', hl_bybit_n: 288, hl_bybit_gap: 0.0002, hl_bybit_above: 1 }),
  ];
  const gaps = summariseGaps(rows);
  assert.deepEqual(gaps.map(gap => gap.symbol), ['WIDE', 'SMALL']);
  assert.ok(gaps[0].netOverWindow > 0);
  assert.ok(gaps[1].netOverWindow < 0, 'a gap smaller than the fees is reported as a loss');
  assert.equal(gaps[0].nowHourly, null, 'no latest reading for this market');
});

test('one scan records one row per market for its five-minute slot and prunes old readings on the hour', async () => {
  const { db, tables } = memoryDb({ funding_gap_scans: [
    { scanned_at: new Date(Date.UTC(2026, 10, 1) - (KEEP_DAYS + 1) * 86_400_000).toISOString(), symbol: 'OLD', hl_volume: 1 },
  ] });
  const feed = { getPredictedFundings: async () => PREDICTED, getAssetContexts: async () => CONTEXTS as never };
  const at = Date.UTC(2026, 10, 1, 12, 7, 31);
  assert.equal(await scanFundingGaps(db, at, feed), 2);
  const slot = new Date(Date.UTC(2026, 10, 1, 12, 5)).toISOString();
  assert.deepEqual(tables.funding_gap_scans.filter(row => row.symbol !== 'OLD').map(row => [row.scanned_at, row.symbol]), [[slot, 'BTC'], [slot, 'SOL']]);
  assert.equal(tables.funding_gap_scans.length, 3, 'nothing is pruned mid-hour');

  await scanFundingGaps(db, Date.UTC(2026, 10, 1, 13, 2), feed);
  assert.equal(tables.funding_gap_scans.some(row => row.symbol === 'OLD'), false);

  await assert.rejects(scanFundingGaps(db, at, { getPredictedFundings: async () => [], getAssetContexts: async () => CONTEXTS as never }),
    /no comparable markets/);
});

test('migration 026 keeps the scans server-only and its summary feeds the report', async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
    const sql = readFileSync('supabase/migrations/026_funding_gap_scans.sql', 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // running it twice is harmless
    const can = async (role: string, privilege: string) => (await pg.query<{ ok: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS ok', [role, 'public.funding_gap_scans', privilege])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await can(role, 'SELECT'), false, role);
      assert.equal((await pg.query<{ ok: boolean }>("SELECT has_function_privilege($1, 'public.funding_gap_summary(timestamptz)', 'EXECUTE') AS ok", [role])).rows[0].ok, false, role);
    }
    assert.equal(await can('service_role', 'INSERT'), true);

    // Hyperliquid pays 3 above Bybit in three scans and 1 below in one; Binance is quoted in only two of them.
    const start = Date.UTC(2026, 10, 1);
    const scans: Array<[number, number, number | null, number]> = [[5, 5, 4, 2], [10, 5, null, 2], [15, 5, 3, 2], [20, 1, null, 2]];
    for (const [minute, hl, binance, bybit] of scans) {
      await pg.query('INSERT INTO public.funding_gap_scans VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [new Date(start + minute * 60_000).toISOString(), 'BTC', hl * 1e-5, binance == null ? null : binance * 1e-5, bybit * 1e-5, 0.0001, 1e9]);
    }
    await pg.query('INSERT INTO public.funding_gap_scans VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [new Date(start - 60_000).toISOString(), 'BTC', 1, 1, -1, 0.5, 1]);

    const { rows } = await pg.query<SummaryRow>('SELECT * FROM public.funding_gap_summary($1)', [new Date(start).toISOString()]);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.scans, 4, 'the reading before the window is excluded');
    assert.equal(row.hl_binance_n, 2);
    assert.equal(row.hl_bybit_n, 4);
    close(row.hl_binance_gap!, 1.5e-5);
    close(row.hl_bybit_gap!, 2e-5);
    close(row.hl_bybit_above!, 0.75);
    close(row.binance_bybit_gap!, 1.5e-5);
    close(row.binance_bybit_above!, 1);

    const [gap] = summariseGaps(rows, [], 2);
    assert.equal(gap.short, 'hl');
    // Over twenty minutes the fees outweigh the funding, so the cheaper Binance leg gives the better net result.
    assert.equal(gap.long, 'binance');
    close(gap.consistency, 1);
    assert.equal(gap.scans, 2);
  } finally {
    await pg.close();
  }
});
