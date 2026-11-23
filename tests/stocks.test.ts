import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeStock } from '../lib/stocks/grade';
import { EtoroClient } from '../lib/stocks/etoro';
import { researchStock, type StockBar } from '../lib/stocks/research';
import { freshStockAsk, previousStockSession, stockMarketClock } from '../lib/stocks/session';
import { dailyTradeSignal, earningsRebound, stockEntryWindow } from '../lib/stocks/trade-signals';
import { type IntradayBar } from '../lib/stocks/etoro';
import { INSIDE_DAY_SYMBOLS, supportsStockTradeRule } from '../lib/stocks/trade-rules';

test('inside-day breakout checks only the completed pattern, enforces the opening window, and exits after five sessions', () => {
  const bars: StockBar[] = Array.from({ length: 52 }, (_, i) => ({ day: String(i), bidOpen: 100, askOpen: 100.05, bidClose: 100, high: 102, low: 98 }));
  bars[50].high = 101;
  bars[50].low = 99;
  bars[51].bidClose = 101.2;
  assert.equal(dailyTradeSignal(bars.slice(0, -1), 'inside-day', null), false);
  assert.equal(dailyTradeSignal(bars, 'inside-day', null), true);
  assert.equal(dailyTradeSignal(bars, 'inside-day', 4), false);
  assert.equal(dailyTradeSignal(bars, 'inside-day', 5), true);
  assert.equal(stockEntryWindow('inside-day', Date.parse('2026-11-23T14:45Z'), false), true);
  assert.equal(stockEntryWindow('inside-day', Date.parse('2026-11-23T15:00Z'), false), false);
  assert.equal(INSIDE_DAY_SYMBOLS.length, 17);
  assert.equal(supportsStockTradeRule('inside-day', 'COST'), false);
});

test('earnings rebound needs public earnings, complete paired sessions and an eligible market-adjusted gap', () => {
  const make = (t: number, price: number): IntradayBar => ({ t, bidOpen: price, bidHigh: price, bidLow: price, bidClose: price, askOpen: price + 0.02, volume: 100 });
  const priorStart = Date.parse('2026-11-20T14:30Z');
  const todayStart = Date.parse('2026-11-23T14:30Z');
  const prior = Array.from({ length: 13 }, (_, i) => make(priorStart + i * 30 * 60_000, 100));
  const stock = [...prior, make(todayStart, 97)], market = [...prior, make(todayStart, 99)];
  const at = Date.parse('2026-11-23T15:02Z');
  const filed = [{ time: Date.parse('2026-11-23T12:00Z'), reportDate: '2026-11-23' }];
  const signal = earningsRebound(stock, market, filed, at);
  assert.ok(signal);
  assert.equal(new Date(signal.exitAt!).toISOString(), '2026-11-23T20:50:00.000Z');
  assert.equal(earningsRebound(stock, market, filed, signal.validUntil), null);
  assert.equal(earningsRebound(stock, market, [{ ...filed[0], time: at }], at), null);
  assert.equal(earningsRebound(stock.slice(1), market, filed, at), null);
  assert.equal(earningsRebound(stock, [...prior, make(todayStart, 97.4)], filed, at), null);
  assert.equal(supportsStockTradeRule('earnings-rebound', 'SPY'), false);
});

test('stock execution rejects delayed quotes and quotes after an early NYSE close', () => {
  const open = Date.parse('2026-11-27T17:59:35Z');
  const quote = { bid: 100, ask: 100.05, date: new Date(open - 1000).toISOString(), quoteType: 'realtime' };
  assert.equal(freshStockAsk(quote, open), 100.05);
  assert.equal(freshStockAsk({ ...quote, quoteType: 'delayed' }, open), null);
  assert.equal(freshStockAsk(quote, open + 25_000), null);
  assert.equal(stockMarketClock(Date.parse('2026-11-26T15:30:00Z')).open, false);
  assert.equal(previousStockSession(open), '2026-11-25');
});

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
    if (url.includes('/rates?')) {
      assert.deepEqual(new URL(url).searchParams.getAll('instrumentIds'), ['1001,1002']);
      return Response.json({ results: [1001, 1002].map(instrumentId => ({ instrumentId, bid: 100, ask: 101, date: '2026-11-23T02:54:18.97', quoteType: 'realtime' })) });
    }
    if (url.includes('/candles?')) return Response.json({ results: ['2026-11-20', '2026-11-23'].map(day => ({ time: `${day}T00:00:00Z`, open: url.endsWith('side=ask') ? '101' : '100', high: '103', low: '97', close: '102' })) });
    throw new Error('Unexpected endpoint');
  });
  const broker = new EtoroClient({ apiKey: 'test-public-key', userKey: 'test-user-key', environment: 'demo' });
  assert.equal((await broker.portfolio()).credit, 123);
  const bars = await broker.candles(1001, 10, Date.parse('2026-11-23T16:00:00Z'));
  assert.deepEqual(bars, [{ day: '2026-11-20', bidOpen: 100, askOpen: 101, bidClose: 102, high: 103, low: 97 }]);
  const quotes = await broker.quotes([1001, 1002]);
  assert.deepEqual(quotes.map(q => q.instrumentId), [1001, 1002]);
  assert.equal(quotes[0].date, '2026-11-23T02:54:18.97Z');
  assert.equal(requests.length, 4);
});

test('eToro resolves a US-suffixed ticker without substituting an overseas listing', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [
    { instrumentId: 10, symbol: 'CVX.PA', type: 'Stocks' },
    { instrumentId: 20, symbol: 'CVX.US', type: 'Stocks' },
  ] }));
  const broker = new EtoroClient({ apiKey: 'test-key', userKey: 'test-user', environment: 'real' });
  assert.equal((await broker.instrument('CVX'))?.instrumentId, 20);
  assert.equal(await broker.instrument('XYZ'), null);
});
