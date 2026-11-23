import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignFactorSessions, earningsBeforeOpen, FACTOR_RULES, runFactorRule } from '../lib/stocks/factor-research';
import type { StockSession } from '../lib/stocks/intraday';

function session(day: string, bid: number): StockSession {
  return {
    day,
    bars: Array.from({ length: 13 }, (_, i) => ({ t: Date.parse(`${day}T13:30:00Z`) + i * 1_800_000,
      bidOpen: bid, bidClose: bid, bidHigh: bid, bidLow: bid, askOpen: bid + 0.02, volume: 1000 })),
  };
}

test('earnings events must have been public between prior close and the opening cutoff', () => {
  const previousClose = Date.parse('2026-04-10T20:00:00Z'), opening = Date.parse('2026-04-13T13:30:00Z');
  const event = { time: Date.parse('2026-04-10T20:05:01Z'), reportDate: '2026-04-10' };
  assert.equal(earningsBeforeOpen([event], previousClose, opening), true);
  assert.equal(earningsBeforeOpen([{ ...event, time: opening - 60_000 }], previousClose, opening), false);
  assert.equal(earningsBeforeOpen([{ ...event, reportDate: '2026-03-03' }], previousClose, opening), false);
});

test('earnings rebound uses the market-adjusted gap and next quote, and skips expensive spreads', () => {
  const spy = [session('2026-04-10', 100), session('2026-04-13', 100)];
  const equity = [session('2026-04-10', 100), session('2026-04-13', 98)];
  equity[1].bars.at(-1)!.bidClose = 100;
  const events = { AAPL: [{ time: Date.parse('2026-04-10T20:05:01Z'), reportDate: '2026-04-10' }] };
  const data = alignFactorSessions({ SPY: spy, AAPL: equity }, events);
  const lead = FACTOR_RULES.find(r => r.id === 'event--1-0.01-12')!;
  const result = runFactorRule(data, lead, '2026-04-13', '2026-04-14');
  assert.equal(result.trades, 1);
  assert.equal(result.averageMinutes, 360);
  assert.ok(result.netBps! > 150 && result.stressBps! < result.netBps!);
  assert.equal(runFactorRule(data, lead, '2026-04-13', '2026-04-14', 10, true).trades, 0);
  equity[1].bars[1].askOpen = 98.25;
  assert.equal(runFactorRule(data, lead, '2026-04-13', '2026-04-14').trades, 0);
});
