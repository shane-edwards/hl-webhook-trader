import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceForward, blockLowerBound, checkPerpVenue, searchHistory, searchInputs } from '../lib/strategy-search/engine';
import { evolve, seedRecipes } from '../lib/strategy-search/evolution';
import type { Experiment } from '../lib/strategy-search/model';
import { marketSearchPairs, pairFromKey, paperTradingStatus, ruleKey, ruleName, RULE_INTERPRETER_VERSION, searchDue, searchKey, searchPair, searchRevision, SEARCH_ASSETS, SEARCH_FRAMES, SEARCH_REFRESH_MS,
  SEARCH_RETRY_MS, SEARCH_REVISION, RECOMMENDATION_FRESH_MS, type SearchBar, type SearchReport } from '../lib/strategy-search/model';
import { ideasForPair } from '../lib/automation/ideas';
import { nextDiscoveryPair } from '../lib/automation/pair-research';
import { automationVersion, type Evidence } from '../lib/automation/model';
import { summarizeMarketResearch, type SearchRecord } from '../lib/strategy-search/recommendations';
import { paperVersionsInUse } from '../lib/automation/policy';
import { memoryDb } from './helpers';

test('paper status distinguishes an empty paper book from a backtest and respects stock Demo and pause controls', async () => {
  assert.equal(paperTradingStatus(), 'Passed backtest');
  assert.equal(paperTradingStatus(0), 'Paper trading · 0 trades closed');
  assert.equal(paperTradingStatus(1, 'paused'), 'Paper trading paused · 1 trade closed');
  assert.equal(paperTradingStatus(30, 'completed'), 'Paper trading complete · 30 trades closed');
  assert.equal(paperTradingStatus(30, 'tracking', true), 'Paper trading · 30+ trades closed');
  const { db, tables } = memoryDb({ automation_profiles: [{ user_id: 'u', market: 'stocks', mode: 'paper', enabled: true, paper_version: 'v' }],
    etoro_connections: [{ user_id: 'u', environment: 'real' }] });
  const active = () => paperVersionsInUse(db, 'u', 'stocks');
  assert.equal((await active()).size, 0);
  tables.etoro_connections.push({ user_id: 'u', environment: 'demo' });
  assert.deepEqual([...(await active())], ['v']);
  tables.automation_profiles[0].entries_paused = true;
  assert.equal((await active()).size, 0);
});

const sample = Array.from({ length: 800 }, (_, i): SearchBar => {
  const c = 100 + Math.sin(i / 8) * 10 + Math.sin(i / 3) * 3;
  return { t: Date.UTC(2023, 0, 1 + i), o: c, h: c + 1, l: c - 1, c, v: 100 + i % 17 };
});

test('idle discovery revisits the oldest usable pair and respects work already pending or in backoff', () => {
  const now = Date.UTC(2026, 10, 25);
  const jobs = ['failed', 'running', 'queued', 'completed', 'completed', 'completed', 'completed'].map((status, i) => {
    const id = searchKey(marketSearchPairs('crypto')[i]);
    return { idea_id: id, status, verdict: i === 3 ? 'insufficient-history' : 'no-candidate',
      as_of: new Date(now - (6 - i) * 3_600_000).toISOString() };
  });
  const latest = new Map(jobs.map(job => [job.idea_id, job]));
  assert.equal(nextDiscoveryPair('crypto', latest, now)?.last.idea_id, jobs[4].idea_id);
  latest.delete(jobs[4].idea_id);
  assert.equal(nextDiscoveryPair('crypto', latest, now)?.last.idea_id, jobs[5].idea_id);
  latest.delete(jobs[5].idea_id);
  assert.equal(nextDiscoveryPair('crypto', latest, now), undefined);
});

test('generation rotates distinct temporal compositions, breeds deterministically and uses causal inputs', () => {
  const seeds = seedRecipes('long', 23);
  assert.equal(new Set(seeds.map(s => s.recipe.setup + s.recipe.trigger)).size, 20);
  assert.notDeepEqual(seedRecipes('long', 24), seeds);
  assert.notDeepEqual(seedRecipes('long', 23 + 64), seeds);
  const prefix = searchInputs(sample.slice(0, 500));
  const full = searchInputs(sample);
  for (const seed of seedRecipes('long', 0, 64)) {
    assert.deepEqual(prefix.entries(seed), full.entries(seed).filter(i => i < 499));
  }
  const score = (rule: typeof seeds[number]) => ({ fitness: rule.reward, signature: new Set(full.entries(rule).filter(i => i < 400)) });
  const result = evolve('long', 23, score);
  assert.ok(result.tried > seeds.length && result.tried <= 64);
  assert.deepEqual(evolve('long', 23, score), result);
  assert.equal(evolve('long', 23, () => ({fitness: -Infinity, signature:new Set()})).finalists.length,0);
});

test('only a passing rule enrolls; forward fills start after enrollment and checkpoint without duplicates', () => {
  const history = Array.from({length: 450}, (_, i) => {
    const o = 100 + i * .1;
    return { t:Date.UTC(2025,0,1+i), o, h:o+.22, l:o-.15, c:o+.18, v:10 };
  });
  // Regular breakouts during the forward period.
  for (let i=1;i<history.length;i++) history[i].c = history[i].h;
  const pair = searchPair('stocks','SPY','1d')!;
  const metric = { trades:40,groups:15,net:.2,average:.005,drawdown:.06,score:4 };
  const report: SearchReport = {pair, revision:searchRevision('stocks'),source:'fixture',from:'',through:'',bars:450,tried:1,
    validationPassed:1,testedOnLaterData:1,holdoutFrom:'',verdict:'paper-candidate',
    rule:{family:'sequence',recipe:{setup:'shelf',trigger:'channel',within:4},side:'long',setting:10,trend:0,volume:0,stop:1.75,reward:2.5,maxBars:6},
    holdout:metric,stress:metric,venue:null,benchmark:0};
  const start=history[250].t;
  assert.deepEqual(advanceForward({...report,verdict:'holdout-failed'},[],history,start),[]);
  assert.deepEqual(advanceForward({...report,pair:{...pair,market:'crypto'}},[],history,start),[]);
  const justStarted=advanceForward(report,[],history,start);
  assert.equal(justStarted[0].count,0);
  const partial=advanceForward(report,justStarted,history.slice(0,254),history[254].t);
  assert.equal(partial[0].count,0);
  assert.ok(partial[0].pending);
  const later=advanceForward(report,partial,history.slice(0,300),history[300].t);
  assert.ok(later[0].count>0 && later[0].recent.every(fill=>fill.entry>start));
  assert.deepEqual(later,advanceForward(report,justStarted,history.slice(0,300),history[300].t));
  assert.deepEqual(later,advanceForward(report,later,history.slice(0,300),history[300].t));
  assert.equal(advanceForward(report,justStarted,history.slice(320),history[400].t)[0].state,'data-gap');
  const finish = advanceForward(report,[{...justStarted[0],count:29}],history.slice(0,300),history[300].t);
  assert.equal(finish[0].state,'tracking');
  assert.ok(finish[0].count > 30);
  assert.ok(advanceForward(report,finish,history,history.at(-1)!.t)[0].count >= finish[0].count);
});

test('a concentrated stressed gain can have a nonpositive lower block-bootstrap bound',()=>{
  assert.ok(blockLowerBound(Array(30).fill(.002)) > 0);
  assert.ok(blockLowerBound([.5,...Array(29).fill(-.001)]) < 0);
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
  // The fixed grid is symmetric. The number of distinct offspring depends on the discovery trades.
  const classic = (r: SearchReport) => r.tried - r.generation!.tried;
  assert.equal(classic(crypto), 2 * classic(stocks));
  assert.equal(classic(paired), classic(crypto));
  assert.ok(paired.generation!.tried >= 40 && stocks.generation!.uniquePairs >= 20);
  assert.equal(crypto.revision, searchRevision('crypto'));
  assert.equal(stocks.revision, SEARCH_REVISION);
});

test('successive discovery rounds produce fresh rule keys on identical bars and retries are deterministic', () => {
  const bars = Array.from({length: 1100}, (_, i) => ({...sample[i % sample.length], t: Date.UTC(2023, 0, 1 + i)}));
  const run = (round: number, previous: Experiment[]) => {
    const record: Experiment[] = [];
    const report = searchHistory(searchPair('stocks', 'SPY', '1d')!, bars, 'test', { round, previous, record });
    assert.equal(report.round, round);
    return record;
  };
  const first = run(1, []);
  const next = run(2, first);
  const seen = new Set(first.map(e => e.key));
  assert.ok(next.some(e => !seen.has(e.key)));
  assert.deepEqual(next, run(2, first));
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
    [['BTC', '4h', 'research'], ['ETH', '15m', 'research'], ['ETH', '1h', 'trade'], ['BTC', '1h', 'trade']]);
  assert.deepEqual(result.coverage, { symbols: 18, timeframes: 5, total: 90, scanned: 3, queued: 1, limited: 1, lastChecked: time(1) });
  assert.deepEqual(summarizeMarketResearch('stocks', records, [], now).setups.map(setup => [setup.pair, setup.side]),
    [[spy, 'long'], [spy, 'short']]);
  const book = { version: RULE_INTERPRETER_VERSION, rule, started: now, cursor: now, lastExit: 0, count: 3,
    equity: 1.03, peak: 1.03, drawdown: 0, recent: [] };
  equityPair.report!.forward = [{ ...book, state: 'stopped', rule: { ...rule, side: 'short' } },
    { ...book, state: 'tracking', rule: { ...rule, stop: 2 } }, { ...book, state: 'tracking' }];
  const [tracked, ...rest] = summarizeMarketResearch('stocks', records, [], now).setups;
  assert.equal(rest.length, 0);
  assert.equal(tracked.ruleKey, ruleKey(rule));
  assert.equal(tracked.trial?.count, 3);
  equityPair.report!.forward[2] = { ...book, state: 'completed', equity: .99 };
  assert.deepEqual(summarizeMarketResearch('stocks', records, [], now).setups, []);
});

test('generated short recommendations describe their actual mirrored signals', () => {
  const [rule] = seedRecipes('short', 0);
  assert.equal(ruleName({ ...rule, recipe: { setup: 'washout', trigger: 'outside', within: 4 } }),
    'Two-range rally → bearish outside bar');
});
