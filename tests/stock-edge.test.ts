import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stockEdgeEvidence, stockRegime, type EvidenceTrade } from '../lib/stocks/evidence-model';
import { journalQuote, stockFillCalibration, stockFillMetrics, stockJournalFill, type StockJournalOrder } from '../lib/stocks/execution-journal';
import { LAB_SYMBOLS, replayLabMarket, summarizeStockLab } from '../lib/stocks/intraday-lab';
import { replayStockPortfolio, type StockPortfolioInput } from '../lib/stocks/portfolio-replay';

test('shared-position replay allocates cash only once and applies the same limits to concurrent signals', () => {
  const bar = { day: '2026-11-20', bidOpen: 100, askOpen: 100, bidClose: 110, low: 100, high: 110 };
  const example = { daily: [], regular: [], missingEvents: 0, events: [{ day: bar.day, ask: 100, bid: 110 }] };
  const inputs: StockPortfolioInput[] = [{ ...example, symbol: 'AAPL' }, { ...example, symbol: 'NVDA' }];
  const costs = { amount: 900, slipBps: 0, commission: 0 };
  const settings = { capital: 1000, maxExposure: 10_000, maxGroup: 10_000, maxPositions: 1, dailyLoss: 100, maxCostBps: 35,
    from: bar.day, to: bar.day, symbols: ['AAPL', 'NVDA'] as const, strategies: ['earnings-rebound'] as const };
  const config = { ...settings, symbols: [...settings.symbols], strategies: [...settings.strategies] };
  const result = replayStockPortfolio(inputs, [bar], config, costs);
  assert.equal(result.trades, 1);
  assert.equal(result.skips.position, 1);
  assert.ok(Math.abs(result.return - 0.09) < 1e-8);
  assert.ok(result.stressedReturn < result.return);
  assert.equal(replayStockPortfolio(inputs, [bar], { ...config, evidenceOnly: true }, costs).skips.evidence, 2);
  assert.equal(replayStockPortfolio(inputs, [bar], { ...config, maxPositions: 2 }, costs).skips.cash, 1);
});

test('edge scoring counts independent sessions, adapts to costs and watches unmatched windows', () => {
  const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  const evidence: EvidenceTrade[] = days.map(day => ({ day, closed: '2026-03-01', symbol: 'AAPL', rule: 'inside-day',
    regime: 'rising-calm', grossBps: 40, nights: 2 }));
  assert.equal(stockEdgeEvidence(evidence, 'AAPL', 'inside-day', 'rising-calm', true, 12, 1, 3).status, 'Qualified');
  assert.equal(stockEdgeEvidence(evidence, 'AAPL', 'inside-day', 'rising-calm', true, 40, 1, 3).status, 'Skip');
  assert.equal(stockEdgeEvidence(evidence.map(row => ({ ...row, day: '2026-01-01' })), 'AAPL', 'inside-day', 'rising-calm', true, 12, 1, 3).status, 'Watch');
  assert.equal(stockEdgeEvidence(evidence, 'AAPL', 'inside-day', 'rising-calm', false, 12, 1, 3).status, 'Watch');
  assert.equal(stockRegime(days.map((day, i) => ({ day, bidOpen: 100, askOpen: 100, bidClose: 100 + i, high: 140, low: 99 }))), 'rising-calm');
});

test('journal weights fills by units and only uses observed slippage after enough matched fills', () => {
  const observed = '2026-11-20T14:30:00.000Z';
  const result = stockJournalFill({ orderId: 7, status: { id: 3 }, positionExecutions: [
    { positionId: 1, openingData: { avgPrice: 100, units: 1, fees: 1, taxes: 0, executionTime: '2026-11-20T14:30:00.300Z' } },
    { positionId: 2, openingData: { avgPrice: 104, units: 3, fees: 2, taxes: 0, executionTime: '2026-11-20T14:30:00.900Z' } },
  ] });
  assert.deepEqual(result, { price: 103, units: 4, executionAt: '2026-11-20T14:30:00.900Z', feesUsd: 3, taxesUsd: 0 });
  const row = { submission_quote: { ...journalQuote(99.95, 100, observed), observedAt: observed }, fill_metrics: result,
    state: 'filled', symbol: 'AAPL', request: { settlementType: 'real' } } as StockJournalOrder;
  assert.equal(stockFillMetrics(row)?.latencyMs, 900);
  assert.ok(Math.abs(stockFillMetrics(row)!.slipBps - 300) < 1e-8);
  assert.equal(stockFillCalibration(Array(9).fill(row), 'AAPL', 'real').slipBps, null);
  assert.ok(stockFillCalibration(Array(10).fill(row), 'AAPL', 'real').slipBps! > 299);
  assert.equal(stockFillCalibration(Array(10).fill(row), 'AAPL', 'cfd').samples, 0);
});

test('intraday lab records empty coverage without promoting either strategy', () => {
  const options = { slipBps: 3, fee: 1 };
  const asOf = '2026-11-21';
  const result = summarizeStockLab(LAB_SYMBOLS.map(symbol => replayLabMarket(symbol, [], asOf, options)), asOf, options);
  assert.equal(result.markets.length, 12);
  for (const trial of result.reports) {
    assert.equal(trial.status, 'Insufficient sample');
    assert.equal(trial.tickerHoldout.lower, null);
    assert.equal(trial.dateHoldout.baselineTrades, 0);
  }
});
