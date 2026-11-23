import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeStock } from '../lib/stocks/grade';
import { EtoroClient } from '../lib/stocks/etoro';
import { researchStock, type StockBar } from '../lib/stocks/research';
import { freshStockAsk, previousStockSession, stockMarketClock } from '../lib/stocks/session';
import { dailyTradeSignal, earningsRebound, stockEntryWindow } from '../lib/stocks/trade-signals';
import { type IntradayBar } from '../lib/stocks/etoro';
import { INSIDE_DAY_SYMBOLS, supportsStockTradeRule } from '../lib/stocks/trade-rules';
import { approvedStockStop, prepareStockOrder } from '../lib/stocks/leverage';
import { reconcileStockOrder } from '../lib/stocks/autopilot';
import { earningsReplayFill, earningsReplayWindows, stockBacktest } from '../lib/stocks/backtest';

test('earnings replay uses the qualifying session and the actual 3:50 bid rather than the closing quote', () => {
  const filings = [
    { time: Date.parse('2025-11-26T14:29Z'), reportDate: '2025-11-26' },
    { time: Date.parse('2025-11-28T19:00Z'), reportDate: '2025-11-28' },
    { time: Date.parse('2026-04-30T20:03Z'), reportDate: '2026-04-30' },
  ];
  const [window, extra] = earningsReplayWindows(filings, '2025-11-26', '2026-05-01');
  assert.equal(extra, undefined);
  assert.equal(window.day, '2026-05-01');
  assert.equal(new Date(window.open).toISOString(), '2026-05-01T13:30:00.000Z');
  const at = (hour: string, bid: number, ask = bid + 0.01): IntradayBar => ({
    t: Date.parse(`2026-05-01T${hour}Z`), bidOpen: bid, askOpen: ask, bidHigh: bid, bidLow: bid, bidClose: bid, volume: 10,
  });
  const entry = at('14:00', 100);
  const exit = at('19:50', 101);
  const closing = at('19:55', 97);
  const signal = { validUntil: entry.t + 300_000, exitAt: exit.t, maxSpread: 0.001 };
  assert.deepEqual(earningsReplayFill(signal, [entry, exit, closing], window), { day: window.day, ask: 100.01, bid: 101 });
  assert.equal(earningsReplayFill(signal, [entry, closing], window), null);
  assert.equal(earningsReplayFill(signal, [at('14:00', 100, 100.21), exit], window), null);
});

test('inside-day replay reads the same full regular sessions as the live rule and reports the trade', async () => {
  const now = Date.parse('2026-11-23T15:00Z');
  const dates: string[] = [];
  for (let t = Date.parse('2026-05-01T15:00Z'); t < now; t += 86_400_000) {
    const clock = stockMarketClock(t);
    if (clock.tradingDay && clock.close === 960) dates.push(clock.day);
  }
  const paired = dates.flatMap((day, i) => {
    const anchor = Date.parse(`${day}T15:00Z`);
    const open = anchor + (570 - stockMarketClock(anchor).minutes) * 60_000;
    const high = i < 55 ? 102 : i === 55 ? 101 : 105;
    const low = i === 55 ? 99 : 98;
    const quote = i === 56 ? 102 : 100;
    return Array.from({ length: 13 }, (_, j): IntradayBar => ({
      t: open + j * 30 * 60_000, bidOpen: quote, askOpen: quote + 0.05, bidClose: quote, bidLow: low, bidHigh: high, volume: 100,
    }));
  });
  const broker = { intradayCandles: async (_id: number, from: number, to: number) => paired.filter(bar => bar.t >= from && bar.t < to) } as unknown as EtoroClient;
  const result = await stockBacktest(broker, 'AAPL', 1001, 'inside-day', { slipBps: 0, commission: 0 }, now);
  assert.equal(result?.kind, 'daily');
  assert.equal(result.trades, 1);
});

test('leveraged stock orders translate a margin stop into a price and require a fresh review if risk rises', () => {
  const quote = { ask: 100, bid: 99.95 };
  const options = [{ leverage: 5 as const, minimum: 25, stopMargin: { min: 0, max: 50 } }];
  const size = { amount: 100, leverage: 5 as const, stopMarginPct: 10 };
  const order = prepareStockOrder(1001, quote, options, size);
  assert.equal(order.settlementType, 'cfd');
  assert.equal(order.leverage, 5);
  assert.equal(order.settlementType === 'cfd' && order.stopLossRate, 98);
  assert.equal(approvedStockStop(order, quote, 10), true);
  assert.equal(approvedStockStop(order, { ask: 100.5, bid: 100.45 }, 10), false);
  assert.equal(approvedStockStop(order, { ask: 98.05, bid: 97.99 }, 10), false);
  assert.throws(() => prepareStockOrder(1001, quote, options, { ...size, leverage: 2 }), /does not allow/);
  assert.throws(() => prepareStockOrder(1001, quote, options, { ...size, amount: 20 }), /minimum/);
  assert.throws(() => prepareStockOrder(1001, quote, options, { ...size, stopMarginPct: 0.1 }), /too close/);
  assert.throws(() => prepareStockOrder(1001, quote, options, { ...size, stopMarginPct: undefined }), /stop loss/);
});

test('eToro leverage options require broker approval and an attached stop is verified on the Demo fill', async t => {
  let stop: number | null = null;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/info/demo/eligibility')) return Response.json({ eligibilities: [{
      instrumentId: 1001, allowOpenPosition: true, allowClosePosition: true, minPositionExposure: 50, allowedOrderQuantityType: 'all',
      leverageConfigs: [
        { settlementType: 'real', direction: 'long', leverageValues: [1], minPositionAmount: 10, isPotential: false },
        { settlementType: 'cfd', direction: 'long', leverageValues: [2], minPositionAmount: 10, isPotential: false, allowStopLossTakeProfit: true, minStopLossPercentage: 1, maxStopLossPercentage: 50 },
        { settlementType: 'cfd', direction: 'long', leverageValues: [5], minPositionAmount: 10, isPotential: true },
      ],
    }] });
    if (url.endsWith('/execution/demo/orders')) {
      const payload = JSON.parse(String(init.body));
      assert.equal(init.method, 'POST');
      assert.deepEqual([payload.settlementType, payload.leverage, payload.amount, payload.stopLossRate], ['cfd', 2, 100, 95]);
      return Response.json({ orderId: 77 });
    }
    if (url.includes('/info/demo/orders:lookup')) {
      return Response.json({ orderId: 77, status: { id: 3 }, positionExecutions: [{ positionId: 88, state: 'open', stopLossRate: stop }] });
    }
    throw new Error('Unexpected endpoint');
  });
  const broker = new EtoroClient({ apiKey: 'test-key', userKey: 'test-user', environment: 'demo' });
  const options = await broker.stockOrderOptions(1001);
  assert.deepEqual(options.map(option => [option.leverage, option.minimum]), [[1, 50], [2, 25]]);
  const order = prepareStockOrder(1001, { ask: 100, bid: 99.95 }, options, { leverage: 2, amount: 100, stopMarginPct: 10 });
  const reference = '00000000-0000-4000-8000-000000000001';
  await broker.openStock(order, reference);
  assert.equal((await reconcileStockOrder(broker, reference, order)).protection_state, 'exit_required');
  stop = 95;
  assert.equal((await reconcileStockOrder(broker, reference, order)).protection_state, 'protected');
});

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
