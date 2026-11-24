import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPerpVenue, searchHistory, searchInputs } from '../lib/strategy-search/engine';
import { marketSearchPairs, pairFromKey, searchDue, searchKey, searchPair, searchRevision, SEARCH_ASSETS, SEARCH_FRAMES, SEARCH_REFRESH_MS,
  SEARCH_RETRY_MS, SEARCH_REVISION, RECOMMENDATION_FRESH_MS, type SearchBar, type SearchReport } from '../lib/strategy-search/model';
import { ideasForPair } from '../lib/automation/ideas';
import { automationVersion, type Evidence } from '../lib/automation/model';
import { summarizeMarketResearch, type SearchRecord } from '../lib/strategy-search/recommendations';

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

test('crypto and paired stock history support both directions', () => {
  const history = Array.from({ length: 1100 }, (_, i): SearchBar =>
    ({ ...sample[i % sample.length], t: Date.UTC(2023, 0, 1 + i) }));
  const crypto = searchHistory(searchPair('crypto', 'BTC', '1d')!, history, 'sample');
  const stocks = searchHistory(searchPair('stocks', 'SPY', '1d')!, history, 'sample');
  const paired = searchHistory(searchPair('stocks', 'SPY', '1d')!, history.map(bar => ({ ...bar, ask: bar.o * 1.001,
    askHigh: bar.h * 1.001, askLow: bar.l * 1.001, askClose: bar.c * 1.001 })), 'sample');
  assert.equal(crypto.tried, 2 * stocks.tried);
  assert.equal(paired.tried, crypto.tried);
  assert.equal(crypto.revision, searchRevision('crypto'));
  assert.equal(stocks.revision, SEARCH_REVISION);
});

test('the perpetual short replay triggers on breakdowns and charges adverse short funding', () => {
  const history = Array.from({ length: 800 }, (_, i): SearchBar => {
    const o = 120 - (i % 29) * .85;
    return { t: Date.UTC(2026, 4, 1) + i * 3_600_000, o, h: o + .3, l: o - .9, c: o - .5, v: 50 };
  });
  const pair = searchPair('crypto', 'BTC', '1h')!;
  const report: SearchReport = { revision: searchRevision('crypto'), pair, source: 'sample', bars: 800, from: '', through: '',
    tried: 0, validationPassed: 0, testedOnLaterData: 0, holdoutFrom: '', verdict: 'paper-candidate',
    rule: { family: 'range', setting: 8, trend: 0, volume: 0, stop: 1.75, reward: 1.2, maxBars: 4, side: 'short' },
    holdout: null, stress: null, venue: null, benchmark: null };
  const free = checkPerpVenue(report, history).venue!;
  const charged = checkPerpVenue(report, history.map(bar => ({ ...bar, shortFunding: .0002 }))).venue!;
  const longOnlyCosts = checkPerpVenue(report, history.map(bar => ({ ...bar, funding: .05 }))).venue!;
  assert.ok(free.trades > 0);
  assert.equal(free.trades, charged.trades);
  assert.ok(charged.average < free.average);
  assert.equal(longOnlyCosts.average, free.average);
});

test('the background catalog covers every supported asset and timeframe without a visit', () => {
  for (const market of ['crypto', 'stocks'] as const) {
    const pairs = marketSearchPairs(market);
    assert.equal(new Set(pairs.map(searchKey)).size, SEARCH_ASSETS[market].length * SEARCH_FRAMES[market].length);
    assert.deepEqual(new Set(pairs.map(({ symbol }) => symbol)), new Set(SEARCH_ASSETS[market]));
    assert.deepEqual(new Set(pairs.map(({ frame }) => frame)), new Set(SEARCH_FRAMES[market]));
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

test('market recommendations list every current pass across assets and frames, without copying hidden or old results', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const time = (ageDays: number) => new Date(now - ageDays * 86_400_000).toISOString();
  const metric = { trades: 51, groups: 20, net: .25, average: .005, drawdown: .09, score: 4 };
  const rule = { family: 'range', setting: 20, trend: 80, volume: 1, stop: 1.75, reward: 1.8, maxBars: 18 } as const;
  const record = (pair: NonNullable<ReturnType<typeof searchPair>>, ageDays = 1,
    verdict: SearchReport['verdict'] = 'paper-candidate'): SearchRecord => ({
    id: searchKey(pair), asOf: time(ageDays), completedAt: time(ageDays), status: 'completed',
    report: { pair, revision: searchRevision(pair.market), source: 'sample', bars: 10000, from: '2023-10-01', through: '2026-11-23',
      tried: 3024, validationPassed: 1, testedOnLaterData: 1, holdoutFrom: '2025-10-01',
      verdict, rule, stress: metric, holdout: metric, venue: metric, benchmark: .01 },
  });
  const btc = searchPair('crypto', 'BTC', '4h')!;
  const eth = searchPair('crypto', 'ETH', '15m')!;
  const sol = searchPair('crypto', 'SOL', '1d')!;
  const link = searchPair('crypto', 'LINK', '5m')!;
  const doge = searchPair('crypto', 'DOGE', '5m')!;
  const spy = searchPair('stocks', 'SPY', '30m')!;
  const assetRule = (symbol: string, rule: string, stress: number): Evidence => ({ market: 'crypto', symbol, rule,
    name: rule, version: automationVersion('crypto', symbol, rule), trades: 90, holdoutTrades: 35, early: .1, later: .2,
    stress, benchmark: .02, drawdown: .08, from: '2026-06-01', through: '2026-11-23', qualified: true, reason: 'Passed' });
  const named = assetRule('BTC', 'trend_breakout', .15);
  const namedOther = assetRule('ETH', 'trend_pullback', .19);
  const equityPair = record(spy);
  equityPair.report!.alternatives = [{ verdict: 'paper-candidate', rule: { ...rule, side: 'short' }, holdout: metric, stress: metric, venue: null, benchmark: .01 }];
  const records = [record(btc), record(eth), record(sol, 9), equityPair,
    record(link, 1, 'holdout-failed'), record(link, 2), record(doge, 1, 'insufficient-history'),
    { ...record(searchPair('crypto', 'ADA', '1h')!), status: 'running', report: null }];
  const result = summarizeMarketResearch('crypto', records, [
    { evidence: named, asOf: time(1) }, { evidence: namedOther, asOf: time(1) },
    { evidence: { ...namedOther, rule: 'trend_breakout', version: 'old' }, asOf: time(1) },
    { evidence: { ...named, stress: .99 }, asOf: time(6) },
  ], now);
  assert.deepEqual(result.setups.map(setup => [setup.pair.symbol, setup.pair.frame, setup.kind]),
    [['ETH', '1h', 'trade'], ['BTC', '1h', 'trade'], ['BTC', '4h', 'research'], ['ETH', '15m', 'research']]);
  assert.deepEqual(result.coverage, { symbols: 18, timeframes: 5, total: 90, scanned: 3, queued: 1, limited: 1, lastChecked: time(1) });
  assert.deepEqual(summarizeMarketResearch('stocks', records, [], now).setups.map(setup => [setup.pair, setup.side]),
    [[spy, 'long'], [spy, 'short']]);
});
