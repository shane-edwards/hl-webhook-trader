import { sma } from '@/lib/strategy/trend';
import type { annualFundamentals } from './fundamentals';
import { stockSetups, type StockBar } from './research';

type Fundamentals = ReturnType<typeof annualFundamentals>;
type Factor = { label: string; value: number | null; unit: 'percent' | 'multiple' | 'index'; points: number; max: number };

export function gradeStock(bars: StockBar[], benchmark: StockBar[], fundamentals: Fundamentals, spreadPct: number | null, now: number) {
  const latest = stockSetups(bars);
  if (!latest || bars.length < 201) return null;
  const close = bars.map(b => b.bidClose);
  const i = close.length - 1;
  const change = (sessions: number) => close[i] / close[i - sessions] - 1;
  const sessions = new Map(benchmark.map(b => [b.day, b.bidClose]));
  const benchmarkFrom = sessions.get(bars[i - 63].day), benchmarkTo = sessions.get(bars[i].day);
  const relative = benchmarkFrom && benchmarkTo ? change(63) - (benchmarkTo / benchmarkFrom - 1) : null;
  const returns = close.slice(-21).slice(1).map((p, index) => Math.log(p / close[i - 20 + index]));
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 19 * 252);
  const atr = bars.slice(-14).reduce((sum, b, j) => {
    const previous = close[i - 14 + j];
    return sum + Math.max(b.high - b.low, Math.abs(b.high - previous), Math.abs(b.low - previous));
  }, 0) / 14 / close[i];
  const moves = returns.slice(-14);
  const up = moves.reduce((s, r) => s + Math.max(r, 0), 0), down = moves.reduce((s, r) => s + Math.max(-r, 0), 0);
  const rsi = up + down > 0 ? 100 * up / (up + down) : 50;
  const factors: Factor[] = [];
  const add = (label: string, value: number | null | undefined, max: number, good: (v: number) => boolean, unit: Factor['unit'] = 'percent') => factors.push({
    label, value: value ?? null, unit, points: value != null && good(value) ? max : 0, max,
  });
  add('Above 200-session average', close[i] / sma(close, 200, i) - 1, 12, v => v > 0);
  add('50 vs. 200-session trend', sma(close, 50, i) / sma(close, 200, i) - 1, 10, v => v > 0);
  add('One-month momentum', change(21), 7, v => v > 0);
  add('Three-month momentum', change(63), 7, v => v > 0.03);
  add('Three-month return vs. SPY', relative, 12, v => v >= 0.02);
  add('Distance from 200-session high', close[i] / Math.max(...bars.slice(-200).map(b => b.high)) - 1, 6, v => v >= -0.1);
  add('20-session annualized volatility', vol, 5, v => v <= 0.45);
  add('14-session ATR / price', atr, 4, v => v < 0.035);
  add('14-session RSI (simple)', rsi, 4, v => v >= 45 && v <= 75, 'index');
  add('Quoted bid-ask spread', spreadPct, 5, v => v <= 0.003);
  add('Annual revenue growth', fundamentals?.revenueGrowth, 8, v => v >= 0.05);
  add('Annual operating margin', fundamentals?.operatingMargin, 6, v => v >= 0.1);
  add('Annual net margin', fundamentals?.netMargin, 4, v => v > 0);
  add('Annual free cash flow margin', fundamentals?.freeCashFlowMargin, 6, v => v >= 0.05);
  add('Price / annual diluted EPS', fundamentals?.annualPE, 4, v => v > 0 && v <= 35, 'multiple');
  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  const coverage = factors.reduce((sum, factor) => sum + (factor.value == null ? 0 : factor.max), 0);
  const stale = now - Date.parse(latest.day) > 5 * 86_400_000;
  const fundamentalsSupportBuy = (fundamentals?.revenueGrowth ?? -1) > 0 && (fundamentals?.netMargin ?? -1) > 0 && (fundamentals?.freeCashFlowMargin ?? -1) > 0;
  const label = stale ? 'Stale data' : score >= 80 && relative != null && relative >= 0.02 && fundamentalsSupportBuy && coverage >= 90 && spreadPct != null && spreadPct <= 0.003
    ? 'Strong buy' : score >= 65 ? 'Watch closely' : 'Watchlist';
  return { ...latest, score, coverage, label, factors, fiscalEnd: fundamentals?.fiscalEnd ?? null };
}
