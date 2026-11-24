import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_HEDGE, HOUR, projectHedge, type Snapshot } from '../lib/hedge-research/model';

const midnight = Date.parse('2026-11-24T00:00:00Z');
const funding = (hour: number, rate: number) => Array.from({ length: 336 }, (_, n) => ({ time: hour - n * HOUR, rate }));
const book = (time: number, px = 100, sz = 500): Snapshot => ({ time, bids: [{ px: px - .005, sz }], asks: [{ px: px + .005, sz }] });

test('funding hedge measures equal spot and perpetual exposure across both live books and books funding once', () => {
  const time = midnight + 4 * 60_000;
  const opened = projectHedge(EMPTY_HEDGE, book(time), book(time), funding(midnight, .000012), time);
  assert.equal(opened.status, 'opened');
  assert.equal(opened.state.position?.units, 10);
  assert.ok(opened.simulatedNet! < 0);
  const next = time + HOUR;
  const held = projectHedge(opened.state, book(next, 120), book(next, 120), funding(midnight + HOUR, .000012), next);
  assert.equal(held.status, 'holding');
  assert.equal(held.state.position?.paid, .014400000000000001);
  const duplicate = projectHedge(held.state, book(next), book(next), funding(midnight + HOUR, .000012), next);
  assert.equal(duplicate.state.position?.paid, held.state.position?.paid);
  assert.equal(EMPTY_HEDGE.position, null);
});

test('funding hedge rejects stale, shallow or incomplete inputs and closes on a qualifying UTC check', () => {
  const time = midnight + 4 * 60_000;
  assert.equal(projectHedge(EMPTY_HEDGE, book(time - 15_000), book(time), funding(midnight, .000012), time).status, 'unavailable');
  assert.equal(projectHedge(EMPTY_HEDGE, book(time), book(time, 100, 2), funding(midnight, .000012), time).status, 'unavailable');
  assert.equal(projectHedge(EMPTY_HEDGE, book(time), book(time), funding(midnight, .000012).slice(1), time).status, 'unavailable');
  const started = projectHedge(EMPTY_HEDGE, book(time), book(time), funding(midnight, .000012), time);
  const tomorrow = time + 24 * HOUR;
  const closed = projectHedge(started.state, book(tomorrow), book(tomorrow), funding(midnight + 24 * HOUR, 0), tomorrow);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.state.position, null);
  assert.equal(closed.state.completed, 1);
  assert.equal(closed.state.gaps, 23);
});
