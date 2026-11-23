import { replayStockIntraday, summarizeIntraday, type IntradayTrade, type StockSession } from './intraday';

export const LAB_VERSION = 'volume-controls-v1';
export const LAB_MARKETS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'AMZN', 'TSLA'] as const;
export const LAB_HOLDOUT = ['AMAT', 'INTC', 'ORCL', 'CRM', 'GS', 'HD'] as const;
export const LAB_SYMBOLS = [...LAB_MARKETS, ...LAB_HOLDOUT] as const;
export type LabSymbol = typeof LAB_SYMBOLS[number];
export const LAB_RULES = [
  { rule: 'orb-rvol', control: 'orb', label: 'Relative-volume opening breakout', baseline: 'Opening breakout without volume filter' },
  { rule: 'vwap', control: 'vwap-unfiltered', label: 'VWAP reclaim with volume', baseline: 'VWAP reclaim without volume filter' },
] as const;

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export function stockLabWindows(asOf: string) {
  const end = Date.parse(asOf);
  return { from: iso(end - 140 * DAY), validationFrom: iso(end - 105 * DAY), holdoutFrom: iso(end - 56 * DAY), to: asOf };
}

export function replayLabMarket(symbol: LabSymbol, sessions: StockSession[], asOf: string, options: { slipBps: number; fee: number }) {
  const window = stockLabWindows(asOf);
  const cost = { ...options, stressSlipBps: Math.max(3, options.slipBps * 2), stressFee: options.fee * 2 };
  return { symbol, days: sessions.filter(s => s.day >= window.validationFrom && s.day < window.to).map(s => s.day),
    trials: LAB_RULES.map(trial => ({
      rule: trial.rule,
      trades: replayStockIntraday(sessions, trial.rule, window.validationFrom, window.to, cost),
      baseline: replayStockIntraday(sessions, trial.control, window.validationFrom, window.to, cost),
    })) };
}

type Market = ReturnType<typeof replayLabMarket>;
function compare(markets: Market[], rule: Market['trials'][number]['rule'], from: string, to: string) {
  const dates = new Map<string, { excess: number; count: number }>();
  const bucket = (trades: IntradayTrade[]) => {
    const sum = new Map<string, number>();
    for (const trade of trades) sum.set(trade.day, (sum.get(trade.day) ?? 0) + trade.stressBps);
    return sum;
  };
  const forDate = ({ day }: IntradayTrade) => day >= from && day < to;
  const slices = markets.map(market => {
    const trial = market.trials.find(trial => trial.rule === rule)!;
    const strategy = trial.trades.filter(forDate), baseline = trial.baseline.filter(forDate);
    const a = bucket(strategy), b = bucket(baseline);
    let count = 0, excess = 0;
    for (const day of market.days.filter(day => day >= from && day < to)) {
      const value = (a.get(day) ?? 0) - (b.get(day) ?? 0);
      const point = dates.get(day) ?? { excess: 0, count: 0 };
      point.excess += value;
      point.count++;
      dates.set(day, point);
      count++;
      excess += value;
    }
    return { symbol: market.symbol, strategy, baseline, sessions: count, excess: count ? excess / count : null };
  });
  const values = [...dates.values()].map(point => point.excess / point.count);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const error = values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean!) ** 2, 0) / (values.length * (values.length - 1))) : null;
  const summary = summarizeIntraday(slices.map(row => row.strategy));
  return { ...summary, sessions: values.length, baselineTrades: slices.reduce((sum, row) => sum + row.baseline.length, 0),
    excess: mean, lower: error != null ? mean! - 2.24 * error : null,
    marketResults: slices.map(row => ({ symbol: row.symbol, trades: row.strategy.length, sessions: row.sessions, excess: row.excess })) };
}

export function summarizeStockLab(markets: Market[], asOf: string, options: { slipBps: number; fee: number }) {
  const window = stockLabWindows(asOf);
  const validationMarkets = markets.filter(market => LAB_MARKETS.some(symbol => symbol === market.symbol));
  const holdoutMarkets = markets.filter(market => LAB_HOLDOUT.some(symbol => symbol === market.symbol));
  const reports = LAB_RULES.map(trial => {
    const validation = compare(validationMarkets, trial.rule, window.validationFrom, window.holdoutFrom);
    const dateHoldout = compare(validationMarkets, trial.rule, window.holdoutFrom, window.to);
    const tickerHoldout = compare(holdoutMarkets, trial.rule, window.holdoutFrom, window.to);
    const legs = [validation, dateHoldout, tickerHoldout];
    const sufficient = legs.every(leg => leg.marketResults.filter(row => row.sessions >= 15).length >= 4 && leg.trades >= 20 && leg.activeDays >= 12);
    const passes = sufficient && legs.every(leg => (leg.stressBps ?? 0) > 0 && (leg.lower ?? 0) > 0 &&
      leg.marketResults.filter(row => (row.excess ?? 0) > 0).length >= 3);
    return { ...trial, validation, dateHoldout, tickerHoldout, status: passes ? 'Paper candidate' : sufficient ? 'Did not pass' : 'Insufficient sample' };
  });
  return { ...window, version: LAB_VERSION, options, markets: markets.map(market => market.symbol), reports };
}

export type StockLabReport = ReturnType<typeof summarizeStockLab>;
