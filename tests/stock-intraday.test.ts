import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EtoroClient, type IntradayBar } from '../lib/stocks/etoro';
import { regularStockSessions, replayStockIntraday } from '../lib/stocks/intraday';

function bars(start: string): IntradayBar[] {
  return Array.from({ length: 78 }, (_, i) => ({
    t: Date.parse(start) + i * 300_000, bidOpen: 100, bidHigh: 101, bidLow: 99, bidClose: 100, askOpen: 100.1, volume: 1000,
  }));
}

test('regular stock session recognizes both UTC offsets and rejects incomplete and early-close sessions', () => {
  const input = [
    ...bars('2026-03-06T14:30:00Z'),
    ...bars('2026-03-09T13:30:00Z'),
    ...bars('2026-03-10T13:30:00Z').slice(1),
    ...bars('2026-11-27T14:30:00Z'),
  ];
  const result = regularStockSessions(input);
  assert.deepEqual(result.sessions.map(s => s.day), ['2026-03-06', '2026-03-09']);
  assert.equal(result.incomplete, 1);
  // The live daily-bar path asks for early closes: only the 9:30 a.m. to 1:00 p.m. bars form that session.
  const live = regularStockSessions(input, 5, 'include');
  assert.deepEqual(live.sessions.map(s => [s.day, s.bars.length]), [['2026-03-06', 78], ['2026-03-09', 78], ['2026-11-27', 42]]);
  assert.equal(live.sessions[2].bars.at(-1)!.t, Date.parse('2026-11-27T17:55:00Z'));
  assert.equal(live.incomplete, 1);
  assert.equal(regularStockSessions(bars('2026-11-27T14:30:00Z').slice(0, 41), 5, 'include').sessions.length, 0);
});

test('intraday breakout fills at next ask and takes a gap stop before an ambiguous target', () => {
  const data = bars('2026-03-09T13:30:00Z');
  Object.assign(data[1], { bidClose: 102, bidHigh: 102 });
  Object.assign(data[2], { bidOpen: 101.8, askOpen: 102.2, bidHigh: 102.5, bidLow: 100 });
  Object.assign(data[3], { bidOpen: 98, askOpen: 98.2, bidHigh: 110, bidLow: 97 });
  const session = regularStockSessions(data).sessions;
  const trades = replayStockIntraday(session, 'orb', '2026-03-09', '2026-03-10');
  assert.equal(trades.length, 1);
  const units = 9999 / (102.2 * 1.0002);
  const expected = units * 98 * 0.9998 - 1 - 10_000;
  assert.ok(Math.abs(trades[0].netBps - expected) < 1e-8);
  assert.equal(trades[0].minutes, 10);
  assert.ok(trades[0].stressBps < trades[0].netBps);
  assert.equal(replayStockIntraday(session, 'orb-rvol', '2026-03-09', '2026-03-10').length, 0);
});

test('intraday broker data pages each quote side and drops unmatched candles', async t => {
  const start = Date.parse('2026-03-09T13:30:00Z');
  const c = (offset: number, open: string) => ({ time: new Date(start + offset * 300_000).toISOString(), open, high: '103', low: '98', close: '101', volume: '1000' });
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const side = parsed.searchParams.get('side');
    if (side === 'ask') return Response.json({ results: [c(2, '102'), c(0, '102')], pagination: { hasNext: false } });
    if (parsed.searchParams.get('cursor') === 'next') return Response.json({ results: [c(0, '100')], pagination: { hasNext: false } });
    return Response.json({ results: [c(2, '101'), c(1, '101')], pagination: { hasNext: true, nextCursor: 'next' } });
  });
  const broker = new EtoroClient({ apiKey: 'test-key', userKey: 'test-user', environment: 'real' });
  const result = await broker.intradayCandles(1001, start, start + 900_000);
  assert.deepEqual(result.map(x => [x.t, x.askOpen]), [[start, 102], [start + 600_000, 102]]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].searchParams.get('from'), new Date(start).toISOString());
});
