import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchHistory, searchInputs } from '../lib/strategy-search/engine';
import { pairFromKey, searchKey, searchPair, type SearchBar } from '../lib/strategy-search/model';

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
