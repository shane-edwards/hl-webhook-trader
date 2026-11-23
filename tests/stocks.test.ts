import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeStock } from '../lib/stocks/grade';
import { EtoroClient } from '../lib/stocks/etoro';
import { researchStock, type StockBar } from '../lib/stocks/research';

function trend(growth: number): StockBar[] {
  return Array.from({ length: 280 }, (_, i) => {
    const p = 100 * growth ** i;
    return { day: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), bidOpen: p, askOpen: p * 1.001, bidClose: p, high: p * 1.001, low: p * 0.999 };
  });
}

test('stock grading requires benchmark, fresh data, spread, and fundamentals for a Strong buy', () => {
  const bars = trend(1.003), benchmark = trend(1.001);
  const now = Date.parse(bars.at(-1)!.day) + 86_400_000;
  const fundamentals = { fiscalEnd: '2024-12-31', revenueGrowth: 0.2, operatingMargin: 0.3, netMargin: 0.2, freeCashFlowMargin: 0.1, annualPE: 25 };
  const strong = gradeStock(bars, benchmark, fundamentals, 0.001, now);
  assert.equal(strong?.coverage, 100);
  assert.equal(strong?.label, 'Strong buy');
  assert.notEqual(gradeStock(bars, [], fundamentals, 0.001, now)?.label, 'Strong buy');
  assert.notEqual(gradeStock(bars, benchmark, null, 0.001, now)?.label, 'Strong buy');
  assert.notEqual(gradeStock(bars, benchmark, fundamentals, null, now)?.label, 'Strong buy');
  assert.equal(gradeStock(bars, benchmark, fundamentals, 0.001, now + 7 * 86_400_000)?.label, 'Stale data');
});

test('stock simulation enters at the next opening ask and subtracts both commissions', () => {
  const bars = trend(1.003);
  const result = researchStock(bars, 'breakout', { slipBps: 0, commission: 2 })!;
  assert.equal(result.trades, 1);
  assert.equal(result.series[0].equity, 10_000);
  const expected = (10_000 - 2) / bars[101].askOpen * bars.at(-1)!.bidClose - 2;
  assert.ok(Math.abs(result.series.at(-1)!.equity - expected) < 1e-9);
  assert.ok(result.stressReturn < result.holdoutReturn);
});

test('eToro uses the selected read endpoint and pairs bid and ask candles without today', async t => {
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(url);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('x-api-key'), 'test-public-key');
    assert.equal(headers.get('x-user-key'), 'test-user-key');
    assert.match(headers.get('x-request-id')!, /^[0-9a-f-]{36}$/);
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/trading/info/demo/pnl')) return Response.json({ clientPortfolio: { credit: 123, positions: [] } });
    if (url.includes('/candles?')) return Response.json({ results: ['2026-11-20', '2026-11-23'].map(day => ({ time: `${day}T00:00:00Z`, open: url.endsWith('side=ask') ? '101' : '100', high: '103', low: '97', close: '102' })) });
    throw new Error('Unexpected endpoint');
  });
  const broker = new EtoroClient({ apiKey: 'test-public-key', userKey: 'test-user-key', environment: 'demo' });
  assert.equal((await broker.portfolio()).credit, 123);
  const bars = await broker.candles(1001, 10, Date.parse('2026-11-23T16:00:00Z'));
  assert.deepEqual(bars, [{ day: '2026-11-20', bidOpen: 100, askOpen: 101, bidClose: 102, high: 103, low: 97 }]);
  assert.equal(requests.length, 3);
});
