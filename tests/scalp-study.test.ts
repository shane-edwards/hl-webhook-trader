import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayScalp, SCALP_INTERVALS, type ScalpBar } from '../lib/scalp-study';

const ms = SCALP_INTERVALS['5m'];
const start = Date.UTC(2026, 0, 1);

function sweepFixture(): ScalpBar[] {
  return [
    ...Array.from({ length: 48 }, (_, i) => ({ t: start + i * ms, o: 100, h: 101, l: 99, c: 100, v: 10 })),
    { t: start + 48 * ms, o: 100, h: 101, l: 98, c: 100, v: 20 },
    { t: start + 49 * ms, o: 120, h: 130, l: 110, c: 122, v: 10 },
  ];
}

test('sweep enters at next open and takes the stop when both levels are touched', () => {
  const trades = replayScalp(sweepFixture(), '5m', 'sweep', start, start + 50 * ms);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].t, start + 49 * ms);
  const stopDistance = 1.5 * (13 * 2 + 3) / 14;
  assert.ok(Math.abs(trades[0].grossBps + stopDistance / 120 * 10_000) < 1e-8);
  assert.ok(trades[0].stressBps < trades[0].netBps && trades[0].netBps < trades[0].grossBps);
});

test('does not execute a signal across a missing candle or an evaluation boundary', () => {
  const bars = sweepFixture();
  assert.deepEqual(replayScalp(bars, '5m', 'sweep', start + 49 * ms, start + 50 * ms), []);
  assert.deepEqual(replayScalp(bars, '5m', 'sweep', start, start + 49 * ms), []);
  bars[49].t += ms;
  assert.deepEqual(replayScalp(bars, '5m', 'sweep', start, start + 51 * ms), []);
});
