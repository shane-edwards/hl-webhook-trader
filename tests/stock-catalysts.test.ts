import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalystComparison, catalystDecision, catalystEntryTime, catalystOpening, replayCatalyst, type CatalystObservation } from '../lib/stocks/catalyst';
import { openingCatalysts } from '../lib/stocks/catalyst-data';
import { CATALYST_UNIVERSE } from '../lib/stocks/catalyst-universe';
import { sizeStockRisk } from '../lib/stocks/dollar-risk';
import type { IntradayBar } from '../lib/stocks/etoro';
import { stockSessionMinute } from '../lib/stocks/session';
import { brokerStockGross, DEFAULT_STOCK_GUARD, stockStrategyScore, type StockScoreOrder } from '../lib/stocks/strategy-guard';

const minute = 60_000;
const day = '2026-11-20';
const open = stockSessionMinute(day, 570);
const row = (t: number, bid = 100, close = bid, volume = 100): IntradayBar => ({ t, bidOpen: bid, askOpen: bid + .03,
  bidClose: close, bidLow: bid - .5, bidHigh: Math.max(bid, close) + .1, volume });

test('filing cutoff excludes news after the opening bell and preserves the public SEC reference', () => {
  const source = {
    form: ['8-K', '8-K', '8-K/A'], items: ['2.02,9.01', '2.02', '2.02'],
    accessionNumber: ['0000320193-26-000100', '0000320193-26-000101', '0000320193-26-000102'],
    acceptanceDateTime: [new Date(open - 30 * minute).toISOString(), new Date(open + minute).toISOString(), new Date(open - minute).toISOString()],
  };
  const market = CATALYST_UNIVERSE.find(item => item.symbol === 'AAPL')!;
  const result = openingCatalysts(source, market, open - 18 * 60 * minute, open);
  assert.equal(result?.accession, source.accessionNumber[0]);
  assert.equal(result?.kind, 'Earnings');
  assert.match(result!.url, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\//);
});

test('opening decision uses exactly three completed bars and past opening volume', () => {
  const prior = Array.from({ length: 18 }, (_, i) => new Date(Date.parse(day) - (i + 1) * 86_400_000).toISOString().slice(0, 10))
    .filter(date => ![0, 6].includes(new Date(date).getUTCDay()))
    .flatMap(date => [0, 1, 2].map(i => row(stockSessionMinute(date, 570) + i * 5 * minute)));
  const today = [row(open, 100, 100.2, 180), row(open + 5 * minute, 100, 100.3, 180), row(open + 10 * minute, 100, 100.6, 180)];
  const history = [...prior, ...today, row(open + 15 * minute, 100, 500, 100_000)];
  const opening = catalystOpening(history, day);
  assert.equal(opening?.relativeVolume, 1.8);
  assert.equal(catalystDecision(opening, 10, { bid: 100.60, ask: 100.63, at: new Date(open).toISOString() }).status, 'Qualified');
  assert.equal(catalystDecision(opening, 10, { bid: 100.60, ask: 101.03, at: new Date(open).toISOString() }).status, 'Skip');
  assert.equal(catalystOpening([...prior, today[0], today[2]], day), null);
});

test('shadow replay respects decision latency, stops and missing quotes without using the signal candle', () => {
  const observed = open + 22 * minute;
  const t = catalystEntryTime(observed);
  assert.equal(t, open + 25 * minute);
  const decision = { status: 'Qualified' as const, reason: 'fixture', relativeBps: 80, relativeVolume: 2, stop: 98 };
  const observation = { eligible_at: new Date(t).toISOString(), decision, quote: { bid: 100, ask: 100.03, at: new Date(observed).toISOString() } };
  const path = Array.from({ length: 19 }, (_, i) => row(t + i * 5 * minute, 100 + i * .1));
  assert.equal(replayCatalyst(observation, [row(t - 5 * minute, 10), ...path])[0].entry, 100.03);
  assert.ok(replayCatalyst(observation, path)[1].stressedBps! < replayCatalyst(observation, path)[1].netBps!);
  assert.equal(replayCatalyst(observation, path.filter((_, i) => i !== 2))[0].state, 'missing');
  assert.equal(replayCatalyst(observation, [row(t, 97), ...path.slice(1)])[0].state, 'unfilled');
  const stopped = replayCatalyst(observation, [path[0], row(t + 5 * minute, 96), ...path.slice(2)]);
  assert.equal(stopped[2].exit, 96);
});

test('shadow lift matches sector peers within the same account and session', () => {
  const base = { session_day: day, for_symbol: 'NVDA', decision: { status: 'Qualified' },
    outcomes: [{ hold: 30, state: 'complete', netBps: 30, stressedBps: 20 }] } as CatalystObservation;
  const catalyst = { ...base, lane: 'catalyst', environment: 'demo' } as CatalystObservation;
  const peer = { ...base, lane: 'control', environment: 'real', outcomes: [{ hold: 30, state: 'complete', netBps: 10, stressedBps: 5 }] } as CatalystObservation;
  assert.equal(catalystComparison([catalyst, peer])[0].paired, 0);
  assert.equal(catalystComparison([catalyst, { ...peer, environment: 'demo' }])[0].liftBps, 15);
});

test('risk sizing rounds down, includes fees and gaps and rejects impossible broker minimums', () => {
  const input = { ask: 100, bid: 99.96, stop: 98, leverage: 5, budget: 25, gapPct: .5, slippageBps: 3,
    roundTripFeesUsd: 2, minimumAmount: 10, maxAmount: 500 };
  const result = sizeStockRisk(input)!;
  assert.ok(result.gapLoss <= 25 && result.gapLoss > result.lossAtStop);
  assert.equal(result.amount, Math.floor(result.amount * 100 + 0.000001) / 100);
  assert.equal(sizeStockRisk({ ...input, minimumAmount: 400 }), null);
  assert.equal(sizeStockRisk({ ...input, maxAmount: 25 })?.amount, 25);
  assert.equal(sizeStockRisk({ ...input, stop: 100 }), null);
});

test('guard measures slippage and net drawdown separately, and a reset excludes older fills', () => {
  const rows: StockScoreOrder[] = Array.from({ length: 10 }, (_, i) => {
    const at = new Date(open + i * minute).toISOString();
    return { state: 'filled', strategy: 'breakout', broker_state: 3, created_at: at, planned_slippage_bps: 3, planned_net_bps: 10,
      request: { amount: 1000, leverage: 1, settlementType: 'real', instrumentId: 1001 },
      fill_metrics: { price: 100.2, units: 2, executionAt: at, feesUsd: 2, taxesUsd: 0 },
      submission_quote: { ask: 100, bid: 99.99, at, observedAt: at },
      statement_result: { netUsd: -12, closedAt: at, confirmedAt: at },
      close_execution: { '1': { complete: true, units: 2, rate: 98, orderId: 9, quote: null } } };
  });
  const settings = { ...DEFAULT_STOCK_GUARD, enabled: true };
  const score = stockStrategyScore(rows, [], settings)[0];
  assert.match(score.reason!, /slippage.*drawdown/);
  assert.equal(score.net, -120);
  assert.equal(score.netVsPlan, -130);
  assert.ok(Math.abs(score.slipDriftBps! - 17) < .001);
  assert.ok(Math.abs(brokerStockGross(rows[0])! + 4.4) < .001);
  assert.equal(brokerStockGross({ ...rows[0], close_execution: { '1': { ...rows[0].close_execution['1'], units: 1 } } }), null);
  const reset = { strategy: 'breakout' as const, reset_at: new Date(open + 20 * minute).toISOString(), halted_at: null, reason: null };
  assert.equal(stockStrategyScore(rows, [reset], settings)[0].reason, null);
});
