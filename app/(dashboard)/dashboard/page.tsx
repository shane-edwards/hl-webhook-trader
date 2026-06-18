'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { EquityCurve } from '@/components/dashboard/EquityCurve';
import { RecentTrades } from '@/components/dashboard/RecentTrades';
import { ActivePositions } from '@/components/dashboard/ActivePositions';
import { WebhookStatus } from '@/components/dashboard/WebhookStatus';
import { calculateAnalytics, buildEquityCurve } from '@/lib/analytics';
import { formatCurrency, formatPercent } from '@/lib/utils';
import type { Trade, Settings } from '@/types';
import {
  DollarSign, TrendingUp, Target, Activity, Zap, Shield,
} from 'lucide-react';
import { toast } from 'sonner';

export default function DashboardPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const [tradesRes, settingsRes] = await Promise.all([
        fetch('/api/trades?limit=100'),
        fetch('/api/settings'),
      ]);
      const [tradesData, settingsData] = await Promise.all([
        tradesRes.json(),
        settingsRes.json(),
      ]);
      setTrades(tradesData.trades ?? []);
      setSettings(settingsData.settings ?? null);
    } catch {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function handleWebhookToggle(enabled: boolean) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook_enabled: enabled }),
    });
    const data = await res.json();
    if (!res.ok) { toast.error(data.error); return; }
    setSettings(data.settings);
    toast.success(enabled ? 'Webhook trading enabled' : 'Webhook trading paused');
  }

  const metrics = calculateAnalytics(trades);
  const equityData = buildEquityCurve(trades);
  const openTrades = trades.filter(t => t.status === 'open');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const webhookUrl = `${appUrl}/api/webhook`;

  const pnlTrend = metrics.totalPnl > 0 ? 'up' : metrics.totalPnl < 0 ? 'down' : 'neutral';

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => fetchData(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-6 space-y-5 flex-1">
        {/* Webhook status */}
        {settings && (
          <WebhookStatus
            enabled={settings.webhook_enabled}
            webhookUrl={webhookUrl}
            onToggle={handleWebhookToggle}
          />
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          <StatsCard
            title="Total P&L"
            value={formatCurrency(metrics.totalPnl)}
            subtitle={`${formatPercent(metrics.totalPnlPercent)} overall`}
            icon={DollarSign}
            trend={pnlTrend}
            loading={loading}
            iconColor={metrics.totalPnl >= 0 ? 'text-profit' : 'text-loss'}
          />
          <StatsCard
            title="Win Rate"
            value={`${metrics.winRate.toFixed(1)}%`}
            subtitle={`${metrics.winningTrades}W / ${metrics.losingTrades}L`}
            icon={Target}
            trend={metrics.winRate >= 50 ? 'up' : 'down'}
            loading={loading}
          />
          <StatsCard
            title="Sharpe Ratio"
            value={isFinite(metrics.sharpeRatio) ? metrics.sharpeRatio.toFixed(2) : '—'}
            subtitle="Risk-adjusted return"
            icon={Activity}
            trend={metrics.sharpeRatio >= 1 ? 'up' : metrics.sharpeRatio < 0 ? 'down' : 'neutral'}
            loading={loading}
          />
          <StatsCard
            title="Max Drawdown"
            value={`${metrics.maxDrawdown.toFixed(1)}%`}
            subtitle={formatCurrency(metrics.maxDrawdownDollar)}
            icon={Shield}
            trend={metrics.maxDrawdown < 10 ? 'up' : metrics.maxDrawdown > 25 ? 'down' : 'neutral'}
            loading={loading}
          />
        </div>

        {/* Secondary stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          <StatsCard
            title="Active Trades"
            value={openTrades.length.toString()}
            subtitle={`of ${trades.length} total`}
            icon={Zap}
            loading={loading}
          />
          <StatsCard
            title="Profit Factor"
            value={isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'}
            subtitle="Gross profit / gross loss"
            icon={TrendingUp}
            trend={metrics.profitFactor >= 1.5 ? 'up' : metrics.profitFactor < 1 ? 'down' : 'neutral'}
            loading={loading}
          />
          <StatsCard
            title="Expectancy"
            value={formatCurrency(metrics.expectancy)}
            subtitle="Per trade average"
            icon={Target}
            trend={metrics.expectancy > 0 ? 'up' : metrics.expectancy < 0 ? 'down' : 'neutral'}
            loading={loading}
          />
          <StatsCard
            title="Total Trades"
            value={metrics.totalTrades.toString()}
            subtitle={`Avg ${metrics.avgLeverage.toFixed(1)}x leverage`}
            icon={Activity}
            loading={loading}
          />
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <EquityCurve data={equityData} loading={loading} />
          </div>
          <div>
            <ActivePositions />
          </div>
        </div>

        {/* Recent trades */}
        <RecentTrades trades={trades} loading={loading} />
      </div>
    </div>
  );
}
