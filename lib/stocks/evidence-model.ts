import type { StockBar } from './research';
import type { StockTradeRule, StockTradeSymbol } from './trade-rules';

export type StockMarketRegime = 'rising-calm' | 'rising-volatile' | 'falling-calm' | 'falling-volatile';
export type EvidenceTrade = { symbol: string; rule: StockTradeRule; day: string; closed: string; regime: StockMarketRegime;
  grossBps: number; nights: number; spreadBps?: number };
export type EdgeEvidence = { status: 'Qualified' | 'Watch' | 'Skip'; reason: string; samples: number; days: number; symbolSamples: number;
  netBps: number | null; lowerBps: number | null };

export function stockRegime(bars: StockBar[]): StockMarketRegime | null {
  const closes = bars.slice(-21).map(bar => bar.bidClose);
  if (closes.length < 21) return null;
  const average = closes.slice(0, -1).reduce((sum, close) => sum + close, 0) / 20;
  const returns = closes.slice(1).map((close, i) => Math.log(close / closes[i]));
  const mean = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
  const vol = Math.sqrt(252 / (returns.length - 1) * returns.reduce((sum, ret) => sum + (ret - mean) ** 2, 0));
  return `${closes.at(-1)! >= average ? 'rising' : 'falling'}-${vol >= 0.18 ? 'volatile' : 'calm'}`;
}

export function stockEdgeEvidence(trades: EvidenceTrade[], symbol: StockTradeSymbol, rule: StockTradeRule,
  regime: StockMarketRegime | null, openingWindow: boolean, frictionBps: number, leverage: number, slipBps: number, spreadBps?: number): EdgeEvidence {
  const absent = { samples: 0, days: 0, symbolSamples: 0, netBps: null, lowerBps: null };
  if (!openingWindow || !regime) return { ...absent, status: 'Watch', reason: 'No matching history for this time or market regime' };
  const matches = trades.filter(trade => trade.rule === rule && trade.regime === regime &&
    (spreadBps == null || (trade.spreadBps != null && (trade.spreadBps <= 10) === (spreadBps <= 10))));
  const own = matches.filter(trade => trade.symbol === symbol);
  const used = own.length >= 30 ? own : matches;
  const groups = new Map<string, { sum: number; n: number }>();
  for (const trade of used) {
    const point = groups.get(trade.day) ?? { sum: 0, n: 0 };
    const funding = leverage > 1 ? trade.nights * 11.4 / 3.65 : 0;
    point.sum += trade.grossBps - funding - frictionBps - 2 * slipBps;
    point.n++;
    groups.set(trade.day, point);
  }
  const values = [...groups.values()].map(point => point.sum / point.n);
  const days = values.length;
  const netBps = days ? values.reduce((sum, value) => sum + value, 0) / days : null;
  const variance = days > 1 ? values.reduce((sum, value) => sum + (value - netBps!) ** 2, 0) / (days - 1) : null;
  const lowerBps = variance != null ? netBps! - 1.65 * Math.sqrt(variance / days) : null;
  const metrics = { samples: used.length, days, symbolSamples: own.length, netBps, lowerBps };
  if (used.length < 30 || days < 20 || own.length < 4 || lowerBps == null) {
    return { ...metrics, status: 'Watch', reason: 'Too few comparable stock and session observations' };
  }
  if (netBps! <= 0) return { ...metrics, status: 'Skip', reason: 'Estimated round-trip costs absorb the historical edge' };
  if (lowerBps <= 0) return { ...metrics, status: 'Watch', reason: 'Historical results are too uncertain after costs' };
  return { ...metrics, status: 'Qualified', reason: 'The historical net estimate remains positive under the uncertainty check' };
}
