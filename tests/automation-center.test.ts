import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationSchedule, automationVersion, paperThreshold, studyEvidence } from '../lib/automation/model';
import { capAutomationNotional } from '../lib/autopilot/risk';
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

test('Paper requires settled samples across different dates and positive net P&L', () => {
  const outcomes = Array.from({ length: 10 }, (_, i) => ({ at: `2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`, pnl: 2 }));
  assert.equal(paperThreshold(outcomes).passed, true);
  assert.equal(paperThreshold(outcomes.slice(0, 9)).passed, false);
  assert.equal(paperThreshold(outcomes.map(row => ({ ...row, at: outcomes[0].at }))).passed, false);
  assert.equal(paperThreshold(outcomes.map(row => ({ ...row, pnl: -2 }))).passed, false);
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
