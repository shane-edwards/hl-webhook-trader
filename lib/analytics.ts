import type { Trade, AnalyticsMetrics, EquityPoint, MonthlyPnL } from '@/types';
import { format, parseISO } from 'date-fns';

export function calculateAnalytics(trades: Trade[]): AnalyticsMetrics {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);

  if (closed.length === 0) {
    return emptyMetrics();
  }

  const pnls = closed.map(t => t.pnl!);
  const wins = closed.filter(t => t.pnl! > 0);
  const losses = closed.filter(t => t.pnl! < 0);

  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl!, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl!, 0));

  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  const largestWin = wins.length > 0 ? Math.max(...wins.map(t => t.pnl!)) : 0;
  const largestLoss = losses.length > 0 ? Math.min(...losses.map(t => t.pnl!)) : 0;

  const returns = pnls;
  const sharpeRatio = calculateSharpe(returns);
  const sortinoRatio = calculateSortino(returns);
  const { maxDrawdown, maxDrawdownDollar } = calculateMaxDrawdown(closed);
  const calmarRatio = maxDrawdown > 0 ? (totalPnl / (maxDrawdown * 1)) : 0;
  const recoveryFactor = maxDrawdownDollar > 0 ? totalPnl / maxDrawdownDollar : 0;

  const { consecutiveWins, consecutiveLosses, maxConsecutiveWins, maxConsecutiveLosses } =
    calculateStreaks(closed);

  const durations = closed.filter(t => t.duration_seconds != null).map(t => t.duration_seconds!);
  const avgTradeDurationHours =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length / 3600 : 0;

  const avgLeverage =
    closed.length > 0 ? closed.reduce((a, t) => a + t.leverage, 0) / closed.length : 1;

  const totalFees = closed.reduce((a, t) => a + (t.fees ?? 0), 0);
  const totalFunding = closed.reduce((a, t) => a + (t.funding_paid ?? 0), 0);

  const kellyPercentage = calculateKelly(winRate, avgWinLossRatio);
  const varNinetyFive = calculateVaR(returns, 0.95);

  const totalSizeUsd = closed.reduce((a, t) => a + t.size_usd, 0);
  const totalPnlPercent = totalSizeUsd > 0 ? (totalPnl / totalSizeUsd) * 100 : 0;

  return {
    totalPnl,
    totalPnlPercent,
    winRate: winRate * 100,
    profitFactor,
    sharpeRatio,
    sortinoRatio,
    calmarRatio,
    maxDrawdown: maxDrawdown * 100,
    maxDrawdownDollar,
    expectancy,
    avgWin,
    avgLoss,
    avgWinLossRatio,
    totalTrades: closed.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    avgTradeDurationHours,
    largestWin,
    largestLoss,
    consecutiveWins,
    consecutiveLosses,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    recoveryFactor,
    avgLeverage,
    totalFees,
    totalFunding,
    kellyPercentage,
    varNinetyFive,
  };
}

function calculateSharpe(returns: number[], riskFreeRate = 0): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return ((mean - riskFreeRate) / stdDev) * Math.sqrt(252);
}

function calculateSortino(returns: number[], riskFreeRate = 0): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const downside = returns.filter(r => r < riskFreeRate);
  if (downside.length === 0) return 5;
  const downsideVariance = downside.reduce((a, r) => a + Math.pow(r - riskFreeRate, 2), 0) / downside.length;
  const downsideStdDev = Math.sqrt(downsideVariance);
  if (downsideStdDev === 0) return 0;
  return ((mean - riskFreeRate) / downsideStdDev) * Math.sqrt(252);
}

function calculateMaxDrawdown(trades: Trade[]): { maxDrawdown: number; maxDrawdownDollar: number } {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownDollar = 0;

  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime()
  );

  for (const trade of sorted) {
    equity += trade.pnl ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    const ddDollar = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddDollar > maxDrawdownDollar) maxDrawdownDollar = ddDollar;
  }

  return { maxDrawdown, maxDrawdownDollar };
}

function calculateStreaks(trades: Trade[]) {
  const sorted = [...trades].sort(
    (a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime()
  );

  let consecutiveWins = 0;
  let consecutiveLosses = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  for (const trade of sorted) {
    if ((trade.pnl ?? 0) > 0) {
      currentWins++;
      currentLosses = 0;
      if (currentWins > maxConsecutiveWins) maxConsecutiveWins = currentWins;
    } else {
      currentLosses++;
      currentWins = 0;
      if (currentLosses > maxConsecutiveLosses) maxConsecutiveLosses = currentLosses;
    }
  }

  consecutiveWins = currentWins;
  consecutiveLosses = currentLosses;

  return { consecutiveWins, consecutiveLosses, maxConsecutiveWins, maxConsecutiveLosses };
}

function calculateKelly(winRate: number, winLossRatio: number): number {
  if (winLossRatio <= 0) return 0;
  const kelly = winRate - (1 - winRate) / winLossRatio;
  return Math.max(0, Math.min(kelly * 100, 100));
}

function calculateVaR(returns: number[], confidence: number): number {
  if (returns.length === 0) return 0;
  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  return Math.abs(sorted[index] ?? 0);
}

export function buildEquityCurve(trades: Trade[]): EquityPoint[] {
  const closed = trades
    .filter(t => t.status === 'closed' && t.pnl != null)
    .sort((a, b) => new Date(a.entry_time).getTime() - new Date(b.entry_time).getTime());

  let equity = 0;
  let peak = 0;
  const points: EquityPoint[] = [];

  for (const trade of closed) {
    equity += trade.pnl!;
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;

    points.push({
      date: format(parseISO(trade.exit_time ?? trade.entry_time), 'MMM d'),
      equity: parseFloat(equity.toFixed(2)),
      drawdown: parseFloat(drawdown.toFixed(2)),
      pnl: trade.pnl!,
    });
  }

  return points;
}

export function buildMonthlyPnL(trades: Trade[]): MonthlyPnL[] {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null);
  const map = new Map<string, { pnl: number; trades: number; wins: number }>();

  for (const trade of closed) {
    const month = format(parseISO(trade.entry_time), 'yyyy-MM');
    const existing = map.get(month) ?? { pnl: 0, trades: 0, wins: 0 };
    map.set(month, {
      pnl: existing.pnl + trade.pnl!,
      trades: existing.trades + 1,
      wins: existing.wins + (trade.pnl! > 0 ? 1 : 0),
    });
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, data]) => ({
      month: format(parseISO(`${month}-01`), 'MMM yyyy'),
      pnl: parseFloat(data.pnl.toFixed(2)),
      trades: data.trades,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    }));
}

function emptyMetrics(): AnalyticsMetrics {
  return {
    totalPnl: 0, totalPnlPercent: 0, winRate: 0, profitFactor: 0,
    sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0, maxDrawdown: 0,
    maxDrawdownDollar: 0, expectancy: 0, avgWin: 0, avgLoss: 0,
    avgWinLossRatio: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    avgTradeDurationHours: 0, largestWin: 0, largestLoss: 0,
    consecutiveWins: 0, consecutiveLosses: 0, maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0, recoveryFactor: 0, avgLeverage: 1,
    totalFees: 0, totalFunding: 0, kellyPercentage: 0, varNinetyFive: 0,
  };
}
