import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchHistory, searchInputs } from '../lib/strategy-search/engine';
import { pairFromKey, scheduledPairs, searchDue, searchKey, searchPair, SEARCH_ASSETS, SEARCH_FRAMES, SEARCH_REFRESH_MS,
  SEARCH_RETRY_MS, SEARCH_REVISION, RECOMMENDATION_FRESH_MS, type SearchBar } from '../lib/strategy-search/model';
import { ideasForPair } from '../lib/automation/ideas';

const sample = Array.from({ length: 800 }, (_, i): SearchBar => {
  const c = 100 + Math.sin(i / 8) * 10 + Math.sin(i / 3) * 3;
  return { t: Date.UTC(2023, 0, 1 + i), o: c, h: c + 1, l: c - 1, c, v: 100 + i % 17 };
});

test('strategy features for past bars are unchanged by future price and volume shocks', () => {
  const baseline = searchInputs(sample.slice(0, 500));
  const extended = searchInputs(sample.map((bar, index) => index < 500 ? bar :
    { ...bar, c: bar.c * 2, o: bar.o * 2, h: bar.h * 2, l: bar.l * 2, v: 20_000 }));
  for (const [rule, indices] of baseline.signals) {
    assert.deepEqual(extended.signals.get(rule)?.filter(index => index < 499), indices);
  }
  assert.deepEqual(extended.atr.slice(0, 500), baseline.atr);
});

test('strategy search abstains on short or missing history and matches the exact asset and timeframe', () => {
  const pair = searchPair('crypto', 'BTC', '1d')!;
  assert.deepEqual(pairFromKey(searchKey(pair)), pair);
  assert.equal(searchPair('crypto', 'BTC', '30m'), null);
  assert.equal(searchPair('crypto', '../../BTC', '1h'), null);
  const report = searchHistory(pair, sample, 'test feed');
  assert.equal(report.verdict, 'insufficient-history');
  assert.equal(report.tried, 0);
  assert.equal(report.rule, null);
});

test('background rotation covers the catalog and includes the default assets without a visit', () => {
  const date = Date.UTC(2026, 10, 1);
  for (const market of ['crypto', 'stocks'] as const) {
    const rotation = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const day = new Date(date + i * 86_400_000).toISOString().slice(0, 10);
      const pairs = scheduledPairs(market, day);
      assert.equal(new Set(pairs.map(searchKey)).size, pairs.length);
      for (const pair of pairs) rotation.add(searchKey(pair));
    }
    assert.equal(rotation.size, SEARCH_ASSETS[market].length * SEARCH_FRAMES[market].length);
  }
});

test('rechecks stale and older-revision tests while keeping active work and retry delays', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const date = (age: number) => new Date(now - age).toISOString();
  const current = { status: 'completed', revision: SEARCH_REVISION };
  assert.equal(searchDue(undefined, now, true), true);
  assert.equal(searchDue({ ...current, as_of: date(SEARCH_REFRESH_MS - 1) }, now, true), false);
  assert.equal(searchDue({ ...current, as_of: date(SEARCH_REFRESH_MS) }, now, true), true);
  assert.equal(searchDue({ ...current, as_of: date(0), revision: SEARCH_REVISION - 1 }, now, true), true);
  assert.equal(searchDue({ status: 'running', as_of: date(SEARCH_REFRESH_MS) }, now, true), false);
  assert.equal(searchDue({ status: 'failed', as_of: date(SEARCH_RETRY_MS - 1) }, now, true), false);
  assert.equal(searchDue({ status: 'failed', as_of: date(SEARCH_RETRY_MS) }, now, true), true);
  assert.equal(searchDue({ status: 'completed', as_of: date(RECOMMENDATION_FRESH_MS) }, now, false), true);
});

test('built-in tests are scoped to the asset and the signal bar timeframe', () => {
  assert.deepEqual(ideasForPair(searchPair('crypto', 'BTC', '1h')!).map(rule => rule.rule).sort(),
    ['momentum_burst', 'trend_breakout', 'trend_pullback']);
  assert.deepEqual(ideasForPair(searchPair('crypto', 'BTC', '4h')!), []);
  assert.deepEqual(ideasForPair(searchPair('stocks', 'SPY', '30m')!).map(rule => rule.rule), ['close', 'close-volume']);
  assert.deepEqual(ideasForPair(searchPair('stocks', 'JPM', '5m')!), []);
});
