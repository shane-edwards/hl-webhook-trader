import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice, formatSize } from '../lib/hyperliquid/format';
import { computePnl } from '../lib/trades';
import { normalizeSymbol, parseWebhookPayload, planSignal, redactPayload } from '../lib/webhook';
import { DEFAULT_TREND_CONFIG, realizedVol, sma, targetExposure, warmupBars } from '../lib/strategy/trend';
import { decideRebalance } from '../lib/strategy/rebalance';
import { runStrategyOnce, strategyConfigFromSettings } from '../lib/strategy/run';
import { runBacktest, computeStats, type Candle, type CostModel } from '../backtest/engine';
import type { HyperliquidClient } from '../lib/hyperliquid/client';

test('formatPrice follows the 5 significant figure / 6 - szDecimals rule', () => {
  assert.equal(formatPrice(61234.56, 5), '61235');
  assert.equal(formatPrice(123456.7, 5), '123457'); // integers are always allowed
  assert.equal(formatPrice(3456.789, 4), '3456.8');
  assert.equal(formatPrice(152.3456, 2), '152.35');
  assert.equal(formatPrice(1.234567, 2), '1.2346');
  assert.equal(formatPrice(0.0123456, 0), '0.012346');
  assert.equal(formatPrice(0.0000123456, 0), '0.000012'); // capped at 6 decimals, never exponent form
  assert.equal(formatPrice(2000, 4), '2000');
});

test('formatSize rounds down and never uses exponent form', () => {
  assert.equal(formatSize(0.123456789, 5), '0.12345');
  assert.equal(formatSize(0.00001, 5), '0.00001');
  assert.equal(formatSize(0.000004, 5), '0');
  assert.equal(formatSize(12.5, 0), '12');
  assert.equal(formatSize(0.3, 1), '0.3');
});

test('computePnl is price move x coins and does not multiply dollars by leverage', () => {
  const long = computePnl({ side: 'long', entryPrice: 100, exitPrice: 110, size: 2, leverage: 5 });
  assert.equal(long.pnl, 20);
  assert.ok(Math.abs(long.pnlPercentage - 50) < 1e-9);
  const short = computePnl({ side: 'short', entryPrice: 100, exitPrice: 110, size: 2, leverage: 5 });
  assert.equal(short.pnl, -20);
});

test('normalizeSymbol strips exchange prefixes and quote suffixes', () => {
  for (const s of ['BITSTAMP:BTCUSD', 'BTCUSDT', 'btc-perp', 'BTCUSDT.P', 'BINANCE:BTCUSDT.P', 'BTC', 'BTC/USD']) {
    assert.equal(normalizeSymbol(s), 'BTC', s);
  }
  assert.equal(normalizeSymbol('ETHUSDC'), 'ETH');
});

test('parseWebhookPayload rejects unknown actions instead of treating them as short', () => {
  const base = { secret: 's'.repeat(32), symbol: 'BTCUSD' };
  assert.deepEqual(parseWebhookPayload({ ...base, action: 'hodl' }), { ok: false, error: 'Unknown action: hodl' });
  assert.equal(parseWebhookPayload({ ...base }).ok, false);
  assert.equal(parseWebhookPayload({ ...base, action: 'buy', leverage: -3 }).ok, false);
  assert.equal(parseWebhookPayload({ ...base, action: 'buy', leverage: 2.5 }).ok, false);
  assert.equal(parseWebhookPayload({ ...base, action: 'buy', size_usd: 'abc' }).ok, false);
  assert.equal(parseWebhookPayload([1, 2]).ok, false);

  const ok = parseWebhookPayload({ ...base, action: 'SELL', size_usd: '250' });
  assert.ok(ok.ok);
  assert.equal(ok.signal.direction, 'short');
  assert.equal(ok.signal.symbol, 'BTC');
  assert.equal(ok.signal.sizeUsd, 250);
  assert.equal(ok.signal.isTargetPosition, false);

  const pos = parseWebhookPayload({ ...base, action: 'sell', position: 'flat' });
  assert.ok(pos.ok);
  assert.equal(pos.signal.direction, 'flat');
  assert.equal(pos.signal.isTargetPosition, true);
});

test('planSignal', () => {
  const p = (o: Partial<Parameters<typeof planSignal>[0]>) =>
    planSignal({ direction: 'long', isTargetPosition: false, current: null, orderSizeUsd: 100, maxPositionSizeUsd: 1000, ...o });
  const long = { side: 'long' as const, notionalUsd: 950 };

  assert.deepEqual(p({}), { type: 'open', side: 'long' });
  assert.equal(p({ orderSizeUsd: 5000 }).type, 'none'); // over the cap
  assert.equal(p({ current: long }).type, 'none'); // adding would exceed the cap
  assert.deepEqual(p({ current: { side: 'long', notionalUsd: 100 } }), { type: 'open', side: 'long' });
  // "sell" while long is an exit, not a flip
  assert.deepEqual(p({ direction: 'short', current: long }), { type: 'close' });
  // explicit target position reverses
  assert.deepEqual(p({ direction: 'short', current: long, isTargetPosition: true }), { type: 'reverse', side: 'short' });
  assert.equal(p({ direction: 'long', current: long, isTargetPosition: true }).type, 'none');
  assert.deepEqual(p({ direction: 'flat', current: long }), { type: 'close' });
  assert.equal(p({ direction: 'flat' }).type, 'none');
});

test('redactPayload never keeps the secret', () => {
  const out = redactPayload({ secret: 'abc', action: 'buy', nested: { secret: 'x' }, price: 1 });
  assert.deepEqual(out, { action: 'buy', nested: '[omitted]', price: 1 });
});

// ---------- strategy ----------

function series(n: number, dailyReturn: (i: number) => number, start = 100): number[] {
  const out = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + dailyReturn(i)));
  return out;
}
const wiggle = (i: number) => (i % 2 === 0 ? 0.02 : -0.02);

test('sma and realizedVol', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.ok(Number.isNaN(sma([1, 2], 3)));
  const flat = series(40, () => 0);
  assert.equal(realizedVol(flat, 30), 0);
});

test('targetExposure: flat during warm-up and in a downtrend, long and capped in a calm uptrend', () => {
  const cfg = DEFAULT_TREND_CONFIG;
  assert.equal(targetExposure(series(warmupBars(cfg) - 1, () => 0.01), cfg).exposure, 0);

  const down = series(300, i => -0.003 + wiggle(i));
  assert.equal(targetExposure(down, cfg).exposure, 0);

  const calmUp = series(300, i => 0.004 + wiggle(i) / 20);
  const s = targetExposure(calmUp, cfg);
  assert.equal(s.trendScore, 1);
  assert.equal(s.exposure, cfg.maxLeverage); // low vol wants more than the cap allows

  const wildUp = series(300, i => 0.004 + wiggle(i) * 3);
  const w = targetExposure(wildUp, cfg);
  assert.ok(w.exposure > 0 && w.exposure < 1, `high vol scales below 1x, got ${w.exposure}`);
  assert.ok(Math.abs(w.exposure - cfg.targetVol / w.vol) < 1e-9);
});

test('targetExposure does not read past endIndex', () => {
  const closes = series(400, i => 0.001 + wiggle(i));
  const before = targetExposure(closes, DEFAULT_TREND_CONFIG, 299);
  const tampered = closes.map((c, i) => (i > 299 ? c * 0.01 : c));
  assert.deepEqual(targetExposure(tampered, DEFAULT_TREND_CONFIG, 299), before);
});

test('decideRebalance', () => {
  const base = { equity: 10_000, price: 50_000 };
  assert.equal(decideRebalance({ ...base, targetExposure: 1, positionSize: 0.19 }).action, 'hold'); // 0.95x vs 1x
  const buy = decideRebalance({ ...base, targetExposure: 1.5, positionSize: 0.2 });
  assert.equal(buy.action, 'trade');
  assert.ok(Math.abs(buy.deltaSize - 0.1) < 1e-12);
  assert.equal(buy.reduceOnly, false);
  const trim = decideRebalance({ ...base, targetExposure: 0.5, positionSize: 0.2 });
  assert.ok(Math.abs(trim.deltaSize + 0.1) < 1e-12);
  assert.equal(trim.reduceOnly, true);
  // going flat ignores the band
  const flat = decideRebalance({ ...base, targetExposure: 0, positionSize: 0.01 });
  assert.equal(flat.action, 'trade');
  assert.equal(flat.reduceOnly, true);
  assert.equal(decideRebalance({ ...base, targetExposure: 0, positionSize: 0 }).action, 'hold');
  assert.equal(decideRebalance({ ...base, equity: 0, targetExposure: 1, positionSize: 0 }).action, 'hold');
});

// ---------- backtest engine ----------

const freeCosts: CostModel = { takerFee: 0, slippage: 0, fundingForDate: () => 0, maintenanceMargin: 0.0125 };
function bars(closes: number[], lowFactor = 1): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { date: `2020-01-${String(i + 1).padStart(2, '0')}`, open, high: Math.max(open, close), low: Math.min(open, close) * lowFactor, close };
  });
}

test('engine: unlevered hold tracks the price exactly when costs are zero', () => {
  const candles = bars([100, 110, 99, 120]);
  const r = runBacktest(candles, () => 1, { startDate: '2020-01-02', rebalanceBand: 0.9, costs: freeCosts, initialEquity: 1000 });
  assert.ok(Math.abs(r.equity[r.equity.length - 1] - 1200) < 1e-9);
  assert.equal(r.trades, 1);
});

test('engine: fees, slippage and funding reduce equity', () => {
  const candles = bars([100, 100, 100]);
  const costs: CostModel = { takerFee: 0.001, slippage: 0.001, fundingForDate: () => 0.01, maintenanceMargin: 0.0125 };
  const r = runBacktest(candles, () => 1, { startDate: '2020-01-02', rebalanceBand: 0.9, costs, initialEquity: 1000 });
  // entry cost 1000 * 0.002 = 2, then 1% funding on the 1000 notional for two days
  assert.ok(Math.abs(r.feesPaid - 2) < 1e-9);
  assert.ok(Math.abs(r.fundingPaid - 20) < 1e-9);
  assert.ok(Math.abs(r.equity[1] - (1000 - r.feesPaid - r.fundingPaid)) < 1e-9);
});

test('engine: an intraday wick liquidates a 5x long even if the close recovers', () => {
  const candles = bars([100, 100, 100, 100], 0.79); // each day wicks 21% below, closes flat
  const r = runBacktest(candles, () => 5, { startDate: '2020-01-02', rebalanceBand: 0.25, costs: freeCosts });
  assert.equal(r.liquidated, '2020-01-02');
  assert.equal(r.equity[r.equity.length - 1], 0);
  const safe = runBacktest(candles, () => 2, { startDate: '2020-01-02', rebalanceBand: 0.25, costs: freeCosts });
  assert.equal(safe.liquidated, null);
  assert.equal(computeStats(safe).maxDrawdown, 0);
});

// ---------- live runner against a fake exchange ----------

function fakeExchange(opts: { closes: number[]; accountValue: number; position?: { side: 'long' | 'short'; size: number }; lastCandleAgeDays?: number }) {
  const now = Date.UTC(2026, 0, 10, 0, 10);
  const calls: string[] = [];
  const dayStart = Date.UTC(2026, 0, 10) - (opts.lastCandleAgeDays ?? 1) * 86_400_000;
  const price = opts.closes[opts.closes.length - 1];
  const hl = {
    getDailyCandles: async () => opts.closes.map((close, i) => ({ time: dayStart - (opts.closes.length - 1 - i) * 86_400_000, close })),
    getAccountSummary: async () => ({ totalValue: opts.accountValue, unrealizedPnl: 0, marginUsed: 0, withdrawable: opts.accountValue }),
    getPosition: async () => (opts.position ? { ...opts.position, symbol: 'BTC', markPrice: price } : null),
    getMarkPrice: async () => price,
    getAsset: async () => ({ index: 0, meta: { name: 'BTC', szDecimals: 5, maxLeverage: 40 } }),
    setLeverage: async (_c: string, lev: number) => { calls.push(`leverage:${lev}`); },
    placeIocOrder: async (o: { isBuy: boolean; size: number; reduceOnly: boolean }) => {
      calls.push(`order:${o.isBuy ? 'buy' : 'sell'}:${o.size.toFixed(5)}:${o.reduceOnly}`);
      return { orderId: '1', fillPrice: price, sizeInContracts: o.size };
    },
    closePosition: async () => {
      calls.push('close');
      return { fillPrice: price, filledSize: opts.position!.size, side: opts.position!.side, fullyClosed: true };
    },
  } as unknown as HyperliquidClient;
  return { hl, calls, now, price };
}
const cfg = (dryRun: boolean) => ({ symbol: 'BTC', targetVol: 0.4, maxLeverage: 2, capitalUsd: null, dryRun, slippagePercent: 1 });
const calmUp = series(260, i => 0.004 + wiggle(i) / 20, 50_000);
const down = series(260, i => -0.003 + wiggle(i), 50_000);

test('runner: dry run reports the trade and sends nothing', async () => {
  const { hl, calls, now } = fakeExchange({ closes: calmUp, accountValue: 10_000 });
  const r = await runStrategyOnce(hl, cfg(true), now);
  assert.equal(r.status, 'dry_run');
  assert.equal(r.targetExposure, 2);
  assert.deepEqual(calls, []);
});

test('runner: live run buys up to target with headroom leverage', async () => {
  const { hl, calls, now, price } = fakeExchange({ closes: calmUp, accountValue: 10_000 });
  const r = await runStrategyOnce(hl, cfg(false), now);
  assert.equal(r.status, 'traded');
  assert.deepEqual(calls, ['leverage:3', `order:buy:${(20_000 / price).toFixed(5)}:false`]);
});

test('runner: closes the position when the trend is down, holds when already at target', async () => {
  const a = fakeExchange({ closes: down, accountValue: 10_000, position: { side: 'long', size: 0.1 } });
  const r = await runStrategyOnce(a.hl, cfg(false), a.now);
  assert.equal(r.status, 'traded');
  assert.deepEqual(a.calls, ['close']);
  assert.equal(r.tradedSize, -0.1);

  const b = fakeExchange({ closes: down, accountValue: 10_000 });
  assert.equal((await runStrategyOnce(b.hl, cfg(false), b.now)).status, 'held');
  assert.deepEqual(b.calls, []);
});

test('runner: refuses to trade on stale candles', async () => {
  const { hl, calls, now } = fakeExchange({ closes: calmUp, accountValue: 10_000, lastCandleAgeDays: 4 });
  const r = await runStrategyOnce(hl, cfg(false), now);
  assert.equal(r.status, 'error');
  assert.match(r.message, /stale/);
  assert.deepEqual(calls, []);
});

test('strategyConfigFromSettings defaults to dry run unless explicitly disabled', () => {
  assert.equal(strategyConfigFromSettings({}).dryRun, true);
  assert.equal(strategyConfigFromSettings({ strategy_dry_run: null }).dryRun, true);
  assert.equal(strategyConfigFromSettings({ strategy_dry_run: false }).dryRun, false);
  assert.equal(strategyConfigFromSettings({ strategy_dry_run: false }, true).dryRun, true);
});

// ---------- research studies (run on the cached datasets) ----------

import { runCarry, runBasketTrend, runTrend } from '../backtest/research';

test('research: funding capture is low-volatility and the basket averages its sleeves', () => {
  const carry = runCarry({ coin: 'BTC' });
  assert.ok(carry.dates.length > 1000);
  assert.ok(carry.stats.vol < 0.05, `delta-neutral carry should be quiet, got vol ${carry.stats.vol}`);
  assert.ok(carry.shareOfDaysPositive > 0.5 && carry.shareOfDaysPositive <= 1);
  // Sitting out when funding is low can only reduce time in the trade.
  assert.ok(runCarry({ coin: 'BTC', minAnnualFunding: 0.05 }).shareOfDaysInTrade < 1);

  const basket = runBasketTrend(['BTC', 'ETH'], '2022-01-01');
  assert.equal(basket.perCoin.length, 2);
  assert.ok(basket.stats.avgExposure >= 0 && basket.stats.avgExposure <= 2);
});

test('research: spot-first pays less funding than perp-only for the same signal', () => {
  const perp = runTrend({ source: 'bitstamp', startDate: '2020-01-01' });
  const spot = runTrend({ source: 'bitstamp', startDate: '2020-01-01', spotFirst: true });
  assert.ok(spot.fundingPaid < perp.fundingPaid);
});

// ---------- stops and targets ----------

import { protectionPercent, protectionPrices } from '../lib/execution';

test('protection: percent validation and trigger prices on the correct side of entry', () => {
  assert.equal(protectionPercent(''), null);
  assert.equal(protectionPercent(null), null);
  assert.equal(protectionPercent('1.5'), 1.5);
  assert.equal(protectionPercent(0), null);
  assert.equal(protectionPercent(80), null);
  assert.equal(protectionPercent('abc'), null);

  const long = protectionPrices('long', 100, 2, 5);
  assert.ok(Math.abs(long.stopLossPx! - 98) < 1e-9 && Math.abs(long.takeProfitPx! - 105) < 1e-9);
  const short = protectionPrices('short', 100, 2, 5);
  assert.ok(Math.abs(short.stopLossPx! - 102) < 1e-9 && Math.abs(short.takeProfitPx! - 95) < 1e-9);
  assert.deepEqual(protectionPrices('long', 100, null, null), { stopLossPx: undefined, takeProfitPx: undefined });
});
