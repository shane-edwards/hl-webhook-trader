'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { MetricCard } from '@/components/analytics/MetricCard';
import { PnLChart } from '@/components/analytics/PnLChart';
import { DrawdownChart } from '@/components/analytics/DrawdownChart';
import { EquityCurve } from '@/components/dashboard/EquityCurve';
import { calculateAnalytics, buildEquityCurve, buildMonthlyPnL } from '@/lib/analytics';
import { formatCurrency, formatPercent } from '@/lib/utils';
import type { Trade } from '@/types';
import { Skeleton } from '@/components/ui/skeleton';
import {
  TrendingUp, TrendingDown, Target, Shield, Activity, Zap,
  Award, AlertTriangle, Clock, DollarSign,
} from 'lucide-react';
import { toast } from 'sonner';

export default function AnalyticsPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchTrades = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const res = await fetch('/api/trades?limit=500');
      const data = await res.json();
      setTrades(data.trades ?? []);
    } catch {
      toast.error('Failed to load analytics data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchTrades(); }, [fetchTrades]);

  const m = calculateAnalytics(trades);
  const equityData = buildEquityCurve(trades);
  const monthlyData = buildMonthlyPnL(trades);

  function metricStatus(val: number, good: number, bad: number): 'positive' | 'negative' | 'warning' | 'neutral' {
    if (val >= good) return 'positive';
    if (val <= bad) return 'negative';
    return 'warning';
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => fetchTrades(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-6 space-y-6 flex-1">
        {/* Risk-adjusted returns */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Risk-Adjusted Returns
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {loading ? (
              [...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <MetricCard
                  label="Sharpe Ratio"
                  value={isFinite(m.sharpeRatio) ? m.sharpeRatio.toFixed(2) : '—'}
                  description="Annualized, risk-free = 0"
                  icon={Activity}
                  status={metricStatus(m.sharpeRatio, 1.5, 0)}
                />
                <MetricCard
                  label="Sortino Ratio"
                  value={isFinite(m.sortinoRatio) ? m.sortinoRatio.toFixed(2) : '—'}
                  description="Downside deviation-adjusted"
                  icon={Shield}
                  status={metricStatus(m.sortinoRatio, 2, 0)}
                />
                <MetricCard
                  label="Calmar Ratio"
                  value={isFinite(m.calmarRatio) ? m.calmarRatio.toFixed(2) : '—'}
                  description="Return / max drawdown"
                  icon={TrendingUp}
                  status={metricStatus(m.calmarRatio, 1, 0)}
                />
                <MetricCard
                  label="Recovery Factor"
                  value={isFinite(m.recoveryFactor) ? m.recoveryFactor.toFixed(2) : '—'}
                  description="Net profit / max DD ($)"
                  icon={Award}
                  status={metricStatus(m.recoveryFactor, 2, 0)}
                />
              </>
            )}
          </div>
        </div>

        {/* Trade statistics */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Trade Statistics
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {loading ? (
              [...Array(8)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <MetricCard
                  label="Win Rate"
                  value={`${m.winRate.toFixed(1)}%`}
                  description={`${m.winningTrades}W · ${m.losingTrades}L`}
                  icon={Target}
                  status={metricStatus(m.winRate, 55, 40)}
                />
                <MetricCard
                  label="Profit Factor"
                  value={isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞'}
                  description="Gross profit / gross loss"
                  icon={DollarSign}
                  status={metricStatus(m.profitFactor, 1.5, 1)}
                />
                <MetricCard
                  label="Expectancy"
                  value={formatCurrency(m.expectancy)}
                  description="Average return per trade"
                  icon={TrendingUp}
                  status={m.expectancy > 0 ? 'positive' : m.expectancy < 0 ? 'negative' : 'neutral'}
                />
                <MetricCard
                  label="Win/Loss Ratio"
                  value={isFinite(m.avgWinLossRatio) ? m.avgWinLossRatio.toFixed(2) : '—'}
                  description={`Avg win $${m.avgWin.toFixed(0)} / loss $${m.avgLoss.toFixed(0)}`}
                  icon={Activity}
                  status={metricStatus(m.avgWinLossRatio, 1.5, 0.8)}
                />
                <MetricCard
                  label="Largest Win"
                  value={formatCurrency(m.largestWin)}
                  icon={TrendingUp}
                  status="positive"
                />
                <MetricCard
                  label="Largest Loss"
                  value={formatCurrency(Math.abs(m.largestLoss))}
                  icon={TrendingDown}
                  status="negative"
                />
                <MetricCard
                  label="Max Consec. Wins"
                  value={m.maxConsecutiveWins.toString()}
                  description={`Current: ${m.consecutiveWins}`}
                  icon={Zap}
                  status="positive"
                />
                <MetricCard
                  label="Max Consec. Losses"
                  value={m.maxConsecutiveLosses.toString()}
                  description={`Current: ${m.consecutiveLosses}`}
                  icon={AlertTriangle}
                  status={m.maxConsecutiveLosses >= 5 ? 'negative' : 'warning'}
                />
              </>
            )}
          </div>
        </div>

        {/* Risk metrics */}
        <div>
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Risk Metrics
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {loading ? (
              [...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
            ) : (
              <>
                <MetricCard
                  label="Max Drawdown"
                  value={`${m.maxDrawdown.toFixed(2)}%`}
                  description={formatCurrency(m.maxDrawdownDollar)}
                  icon={Shield}
                  status={metricStatus(-m.maxDrawdown, -10, -25)}
                />
                <MetricCard
                  label="VaR (95%)"
                  value={formatCurrency(m.varNinetyFive)}
                  description="Daily value at risk"
                  icon={AlertTriangle}
                  status="neutral"
                />
                <MetricCard
                  label="Kelly %"
                  value={`${m.kellyPercentage.toFixed(1)}%`}
                  description="Optimal position size"
                  icon={Target}
                  status="neutral"
                />
                <MetricCard
                  label="Avg Duration"
                  value={`${m.avgTradeDurationHours.toFixed(1)}h`}
                  description="Average trade hold time"
                  icon={Clock}
                  status="neutral"
                />
              </>
            )}
          </div>
        </div>

        {/* Fees */}
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          {loading ? (
            [...Array(3)].map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)
          ) : (
            <>
              <MetricCard
                label="Total Fees Paid"
                value={formatCurrency(m.totalFees)}
                description="Exchange fees"
                status={m.totalFees > 0 ? 'negative' : 'neutral'}
              />
              <MetricCard
                label="Total Funding"
                value={formatCurrency(m.totalFunding)}
                description="Accumulated funding"
                status={m.totalFunding < 0 ? 'negative' : m.totalFunding > 0 ? 'positive' : 'neutral'}
              />
              <MetricCard
                label="Avg Leverage"
                value={`${m.avgLeverage.toFixed(1)}x`}
                description="Average leverage used"
                status={m.avgLeverage > 20 ? 'negative' : m.avgLeverage > 10 ? 'warning' : 'positive'}
              />
            </>
          )}
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PnLChart data={monthlyData} />
          <DrawdownChart data={equityData} />
        </div>

        <EquityCurve data={equityData} loading={loading} />
      </div>
    </div>
  );
}
