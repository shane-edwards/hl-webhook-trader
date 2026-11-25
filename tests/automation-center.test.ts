import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationSchedule, automationVersion, PAPER_REQUIREMENT, PAPER_REQUIREMENT_TEXT, paperThreshold, studyEvidence } from '../lib/automation/model';
import { automationDecision, LIVE_EVIDENCE_REASON, readPaperResults } from '../lib/automation/policy';
import { controlledCryptoConfig } from '../lib/automation/trading';
import { capAutomationNotional, DEFAULT_RISK } from '../lib/autopilot/risk';
import { memoryDb } from './helpers';
import { settleCryptoShadow } from '../lib/automation/crypto-shadow';
import { settleDiffusion, standardizedMove } from '../lib/automation/diffusion-shadow';

test('automated research follows the US close for Stocks and the UTC day for Crypto', () => {
  assert.equal(automationSchedule('stocks', Date.parse('2026-11-24T21:14Z')).length, 0);
  assert.equal(automationSchedule('stocks', Date.parse('2026-11-24T22:14Z')).length, 0);
  assert.equal(automationSchedule('stocks', Date.parse('2026-11-24T22:15Z'))[0].key, '2026-11-24');
  assert.equal(automationSchedule('stocks', Date.parse('2026-11-29T23:00Z')).length, 0);
  assert.equal(automationSchedule('crypto', Date.parse('2026-11-29T00:15Z'))[0].key, '2026-11-29');
  assert.ok(automationSchedule('stocks', Date.parse('2026-11-28T03:00Z')).some(item => item.kind === 'weekly'));
});

test('promotion evidence rejects small samples, fees and drawdown and binds the tested market and rule', () => {
  const input = { market: 'crypto' as const, symbol: 'BTC', rule: 'trend_breakout', name: 'Trend Breakout', trades: 30,
    holdoutTrades: 10, early: .07, later: .08, stress: .07, benchmark: .06, drawdown: .09, from: '2026-08-01', through: '2026-11-23' };
  const pass = studyEvidence(input);
  assert.equal(pass.qualified, true);
  assert.equal(pass.version, automationVersion('crypto', 'BTC', 'trend_breakout'));
  assert.notEqual(pass.version, studyEvidence({ ...input, symbol: 'ETH' }).version);
  assert.equal(studyEvidence({ ...input, holdoutTrades: 7 }).qualified, false);
  assert.equal(studyEvidence({ ...input, stress: .06 }).qualified, false);
  assert.equal(studyEvidence({ ...input, drawdown: .13 }).qualified, false);
});

test('Paper requires 30 settled trades on 10 dates, a net profit within the drawdown limit and a mean trade clearly above zero', () => {
  assert.deepEqual(PAPER_REQUIREMENT, { trades: 30, dates: 10, maxDrawdownUsd: 100, tStat: 2 });
  assert.match(PAPER_REQUIREMENT_TEXT, /30 closed Paper trades on 10 or more dates.*\$100.*t-statistic of 2 or more/);
  const record = (count: number, pnl: (i: number) => number, perDate = 2) => Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.UTC(2026, 9, 1 + Math.floor(i / perDate), 12)).toISOString(), pnl: pnl(i) }));
  const steady = (i: number) => i % 2 ? 4 : 2;
  const pass = paperThreshold(record(36, steady));
  assert.equal(pass.passed, true);
  assert.equal(pass.closed, 30);
  assert.ok(pass.tStat! > 10);
  assert.equal(paperThreshold(record(30, steady, 3)).passed, true); // exactly 30 trades on exactly 10 dates
  // Small samples, including the old 10-trade bar.
  assert.equal(paperThreshold(record(29, steady)).passed, false);
  assert.equal(paperThreshold(record(10, steady, 1)).passed, false);
  // Too few dates: 30 trades on 8.
  assert.equal(paperThreshold(record(30, steady, 4)).passed, false);
  // Positive but noisy: the mean is not distinguishable from zero.
  const noisy = paperThreshold(record(30, i => i % 2 ? -10 : 12));
  assert.ok(noisy.net > 0 && noisy.drawdown <= 100 && noisy.days >= 10 && noisy.tStat! > 0 && noisy.tStat! < 2, JSON.stringify(noisy));
  assert.equal(noisy.passed, false);
  assert.equal(paperThreshold(record(30, i => -steady(i))).passed, false);
  // The drawdown limit still applies to a record that passes everything else.
  const deep = paperThreshold(record(30, i => i < 2 ? -60 : 20));
  assert.ok(deep.tStat! >= 2 && deep.drawdown > 100);
  assert.equal(deep.passed, false);
  // Identical results or a single trade give no statistic and never pass.
  for (const flat of [record(30, () => 2), record(30, () => 0.1), record(1, () => 5), []]) {
    assert.equal(paperThreshold(flat).tStat, null);
    assert.equal(paperThreshold(flat).passed, false);
  }
});

test('a Crypto version reaches a Live decision only when its rule also passed the long-history backtest', async () => {
  const now = Date.now();
  const study = (rule: string) => studyEvidence({ market: 'crypto', symbol: 'BTC', rule, name: rule, trades: 30, holdoutTrades: 10,
    early: .07, later: .08, stress: .07, benchmark: .06, drawdown: .09, from: '2026-08-01', through: '2026-11-23' });
  const burst = study('momentum_burst'), breakout = study('trend_breakout');
  // Both versions have the same strong Paper book, so only the long-history evidence separates them.
  const book = (version: string) => Array.from({ length: 30 }, (_, i) => ({ user_id: 'u', mode: 'paper', status: 'closed', automation_version: version,
    paper_book_fill: true, pnl: i % 2 ? 4 : 2, exit_time: new Date(now - i * 43_200_000).toISOString() }));
  const profile = { user_id: 'u', market: 'crypto', enabled: true, mode: 'live', entries_paused: false, live_version: burst.version,
    loss_budget_usd: 25, max_order_usd: 500, updated_at: 'saved' };
  const { db } = memoryDb({ automation_profiles: [profile], autopilot_positions: [...book(burst.version), ...book(breakout.version)],
    automation_runs: [{ user_id: 'u', market: 'crypto', kind: 'daily', status: 'completed', as_of: new Date(now - 3_600_000).toISOString(),
      report: { evidence: [burst, breakout] } }] });
  const base = { mode: 'paper' as const, symbols: ['ETH'], strategies: ['momentum_burst'], allowShort: true, risk: DEFAULT_RISK, slippagePercent: 1, reservedSymbol: null };

  const paper = await readPaperResults(db, 'u', burst);
  assert.ok(paper.closed === 30 && paper.tStat! >= 2 && paper.net > 0);
  assert.equal(paper.passed, false);
  assert.equal(paper.blocked, LIVE_EVIDENCE_REASON);
  const blocked = await automationDecision(db, 'u', 'crypto');
  assert.equal(blocked.decision, 'waiting');
  assert.equal(blocked.detail, LIVE_EVIDENCE_REASON);
  assert.equal(controlledCryptoConfig(base, blocked, false), null);

  profile.live_version = breakout.version;
  const live = await automationDecision(db, 'u', 'crypto');
  assert.equal(live.decision, 'live');
  assert.equal(live.results?.passed, true);
  assert.equal(live.results?.blocked, undefined);
  const config = controlledCryptoConfig(base, live, false)!;
  assert.deepEqual([config.mode, config.symbols, config.strategies, config.allowShort, config.maxOrderUsd], ['live', ['BTC'], ['trend_breakout'], false, 500]);
  // A Live decision for an unproven rule, however it arose, still produces no trading config.
  assert.equal(controlledCryptoConfig(base, { ...live, candidate: burst }, false), null);
  // Stocks have no long-history file: the stricter Paper record is the only change there.
  assert.equal((await readPaperResults(memoryDb().db, 'u', { ...burst, market: 'stocks' })).blocked, undefined);
});

test('Live sizing for approved Crypto versions uses both the loss budget and notional cap', () => {
  assert.equal(capAutomationNotional(1000, .02, undefined, undefined), 1000);
  assert.equal(capAutomationNotional(1000, .02, 25, 500), 500);
  assert.ok(Math.abs(capAutomationNotional(1000, .02, 22, 1000) - 800) < .00001);
});

test('Crypto shadow settlement uses later hourly bars and actual funding, and refuses gaps', () => {
  const t = Date.parse('2026-11-20T14:00Z'), hour = 3_600_000;
  const signal = { entry_after: new Date(t).toISOString(), stop_pct: .04, assumed_slippage_bps: 2 };
  const bars = Array.from({ length: 25 }, (_, i) => ({ t: t + i * hour, o: 100 + i / 2, h: 101 + i / 2,
    l: 99 + i / 2, c: 100 + i / 2, v: 1 }));
  const rates = new Map(bars.slice(1).map(bar => [bar.t, .0001]));
  const paid = settleCryptoShadow(signal, bars, rates);
  assert.ok(paid && paid.netBps > 0);
  assert.ok(settleCryptoShadow(signal, bars, new Map([...rates].map(([key]) => [key, 0])))!.netBps > paid!.netBps);
  assert.equal(settleCryptoShadow(signal, bars.filter((_, i) => i !== 11), rates), null);
  assert.equal(settleCryptoShadow(signal, bars, new Map()), null);
});

test('retail-flow forward tests use completed input bars and actual funding after entry', () => {
  const frame = 900_000;
  const time = Date.parse('2026-11-24T09:15Z');
  const input = Array.from({ length: 7 }, (_, i) => ({ t: time - (6 - i) * frame, c: 100 * Math.exp(i / 100) }));
  assert.ok(Math.abs(standardizedMove(input, time, 4)! - 1) < 1e-8);
  assert.equal(standardizedMove(input, time - frame, 4), null);
  assert.equal(standardizedMove(input.filter((_, i) => i !== 2), time, 4), null);

  const bars = Array.from({ length: 97 }, (_, i) => ({ t: time + i * frame, o: 100 + i * .04, h: 101 + i * .04,
    l: 99 + i * .04, c: 100 + i * .04 }));
  const hour = 3_600_000;
  const funding = new Map(bars.filter(bar => bar.t % hour === 0).map(bar => [bar.t, .0001]));
  const result = settleDiffusion(time, .04, bars, funding);
  assert.equal(result?.exit, '24-hour exit');
  assert.ok(result && result.netBps > 0);
  assert.equal(settleDiffusion(time, .04, bars.filter((_, i) => i !== 55), funding), null);
  assert.equal(settleDiffusion(time, .04, bars, new Map()), null);
});
