import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regularStockSessions, type StockSession } from '../lib/stocks/intraday';
import { openingCandidate, OPENING_RULES, prepareOpening, replayOpening, selectOpening } from '../lib/stocks/opening-research';

function session(day: string, volume = 100_000): StockSession {
  return {
    day,
    bars: Array.from({ length: 13 }, (_, i) => ({
      t: Date.parse(`${day}T14:30:00Z`) + i * 1_800_000,
      bidOpen: 100, bidClose: 100.5, bidHigh: 101, bidLow: 99, askOpen: 100.08,
      volume: i === 0 ? volume : 100_000,
    })),
  };
}

const prior = Array.from({ length: 15 }, (_, i) => session(`2026-01-${String(i + 1).padStart(2, '0')}`));

test('opening rank uses past sessions and the first bar, independent of later volume', () => {
  const a = session('2026-01-16', 180_000), b = session('2026-01-16', 300_000);
  a.bars[7].volume = 10_000_000;
  const fast = OPENING_RULES.find(r => r.id === 'fast')!;
  const first = openingCandidate('AAPL', a, prior)!, second = openingCandidate('NVDA', b, prior)!;
  assert.equal(first.relativeVolume, 1.8);
  assert.equal(second.relativeVolume, 3);
  assert.deepEqual(selectOpening([first, second], fast).map(x => x.symbol), ['NVDA']);
  assert.equal(openingCandidate('AAPL', a, prior.slice(1)), null);
});

test('opening breakout models worst-case same-bar stop and distinguishes broker costs', () => {
  const today = session('2026-01-16', 180_000);
  const data = prepareOpening({ AAPL: [...prior, today] });
  const rule = OPENING_RULES.find(r => r.id === 'ranked-90')!;
  const result = replayOpening(data, rule, today.day, '2026-01-17');
  assert.equal(result.setups, 1);
  assert.equal(result.trades.length, 1);
  const trade = result.trades[0];
  // Previous ATR is $2. The stock triggered at $101 and the stop at $100.80
  // was touched in the same bar. The $100 opening bid was before the trigger.
  assert.ok(Math.abs(trade.grossBps - (100.8 / 101 - 1) * 10_000) < 1e-8);
  assert.equal(trade.minutes, 30);
  assert.ok(trade.stressBps < trade.netBps && trade.cfdBps < trade.netBps);
});

test('30-minute session grouping keeps exactly the New York regular hours', () => {
  const s = session('2026-01-16');
  const ahead = { ...s.bars[0], t: s.bars[0].t - 1_800_000 };
  assert.equal(regularStockSessions([ahead, ...s.bars], 30).sessions[0].bars.length, 13);
  assert.equal(regularStockSessions(s.bars.slice(1), 30).incomplete, 1);
});

test('next-open momentum uses observed quotes and exits after 90 minutes', () => {
  const today = session('2026-01-16', 210_000);
  today.bars[1].bidLow = 90;
  today.bars[4].bidOpen = 103;
  const rule = OPENING_RULES.find(r => r.id === 'market-90')!;
  const result = replayOpening(prepareOpening({ AAPL: [...prior, today] }), rule, today.day, '2026-01-17');
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].minutes, 90);
  assert.ok(Math.abs(result.trades[0].grossBps - 300) < 1e-8);
});
