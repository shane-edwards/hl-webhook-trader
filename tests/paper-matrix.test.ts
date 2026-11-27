import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperMatrix, type PaperRow } from '../lib/automation/paper-matrix';

const closed = (symbol: string, strategy_id: string, side: string, pnl: number, day: number, hour = 12): PaperRow =>
  ({ symbol, strategy_id, side, status: 'closed', pnl, exit_time: new Date(Date.UTC(2026, 10, day, hour)).toISOString() });
const open = (symbol: string, strategy_id: string, side: string): PaperRow => ({ symbol, strategy_id, side, status: 'open', pnl: null, exit_time: null });

test('paper trades are grouped by strategy, direction and coin, with the backtested coins first', () => {
  const m = buildPaperMatrix([
    closed('ZEC', 'trend_breakout', 'short', -30, 1), closed('ZEC', 'trend_breakout', 'short', 12, 2),
    closed('ETH', 'trend_breakout', 'short', -20, 1), closed('ADA', 'momentum_burst', 'long', 5, 3),
    open('BTC', 'trend_breakout', 'long'),
    closed('BTC', 'xs_momentum_90', 'long', 999, 1),   // the weekly basket is not a per-coin strategy
    closed('BTC', 'trend_breakout', 'flat', 999, 1),
    { ...closed('SOL', 'macd_trend', 'long', 1, 1), pnl: null }, // a close with no result is not counted
  ]);
  assert.deepEqual(m.symbols, ['BTC', 'ETH', 'ADA', 'ZEC']);
  assert.equal(m.lines.length, 10, 'five rules, long and short');
  const line = (rule: string, side: string) => m.lines.find(l => l.rule === rule && l.side === side)!;

  const zec = line('trend_breakout', 'short').cells.ZEC;
  assert.deepEqual([zec.closed, zec.wins, zec.net, zec.drawdown, zec.days, zec.status], [2, 1, -18, 30, 2, 'behind']);
  assert.equal(line('trend_breakout', 'short').net, -38);
  assert.equal(line('trend_breakout', 'short').closed, 3);
  assert.equal(line('momentum_burst', 'long').cells.ADA.status, 'ahead');
  const btc = line('trend_breakout', 'long').cells.BTC;
  assert.deepEqual([btc.closed, btc.open, btc.status], [0, 1, 'open-only']);
  assert.equal(line('macd_trend', 'long').cells.SOL, undefined);

  assert.deepEqual(m.totals, { pairs: 4, profitable: 1, losing: 2, qualified: 0, closed: 4, open: 1, net: -33 });
  assert.deepEqual(m.backtestCoins, ['BTC', 'ETH', 'SOL']);
});

test('each line carries the backtest result for its own rule and direction', () => {
  const m = buildPaperMatrix([]);
  const result = (rule: string, side: string) => m.lines.find(l => l.rule === rule && l.side === side)!.backtest;
  assert.equal(result('trend_breakout', 'long'), 'failed', 'flat since 2025');
  assert.equal(result('macd_trend', 'long'), 'passed');
  assert.equal(result('trend_breakout', 'short'), 'passed');
  assert.equal(result('trend_pullback', 'short'), 'failed');
  assert.equal(result('momentum_burst', 'long'), 'failed');
  assert.equal(m.totals.pairs, 0);
  assert.deepEqual(m.symbols, []);
});

test('a pair qualifies only with enough trades, dates, profit, a small drop and a result unlikely to be luck', () => {
  // 30 closes over 10 dates, mostly small wins: qualifies.
  const steady = Array.from({ length: 30 }, (_, i) => closed('BTC', 'trend_breakout', 'long', i % 5 === 0 ? -4 : 6, 1 + (i % 10), i % 24));
  assert.equal(buildPaperMatrix(steady).lines.find(l => l.rule === 'trend_breakout' && l.side === 'long')!.cells.BTC.status, 'qualified');
  assert.equal(buildPaperMatrix(steady).totals.qualified, 1);

  // The same trades on three dates only: enough trades, but not qualified.
  const bunched = steady.map((row, i) => ({ ...row, exit_time: new Date(Date.UTC(2026, 10, 1 + (i % 3), i % 24)).toISOString() }));
  assert.equal(buildPaperMatrix(bunched).lines[2].cells.BTC.status, 'did-not-qualify');

  // A run of losses past the drawdown limit is flagged whatever the trade count.
  const deep = [closed('ETH', 'macd_trend', 'short', -60, 1), closed('ETH', 'macd_trend', 'short', -55, 2), closed('ETH', 'macd_trend', 'short', 20, 3)];
  const cell = buildPaperMatrix(deep).lines.find(l => l.rule === 'macd_trend' && l.side === 'short')!.cells.ETH;
  assert.equal(cell.status, 'over-drawdown');
  assert.equal(cell.drawdown, 115);
});

test('only the most recent thirty closes are judged, but all are counted', () => {
  const rows = [...Array.from({ length: 5 }, (_, i) => closed('SOL', 'volume_breakout', 'long', -50, 1, i)),
    ...Array.from({ length: 30 }, (_, i) => closed('SOL', 'volume_breakout', 'long', 2, 2 + (i % 12), i % 24))];
  const cell = buildPaperMatrix(rows).lines.find(l => l.rule === 'volume_breakout' && l.side === 'long')!.cells.SOL;
  assert.equal(cell.closed, 35);
  assert.equal(cell.net, 60, 'the five early losses have rolled out of the judged window');
  assert.equal(cell.wins, 30);
});
