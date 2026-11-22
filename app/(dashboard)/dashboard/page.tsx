'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { Stat } from '@/components/ui/stat';
import { AccountPanel } from '@/components/dashboard/AccountPanel';
import { AutomationPanel } from '@/components/dashboard/AutomationPanel';
import { TradeTicket } from '@/components/dashboard/TradeTicket';
import { RecentTrades } from '@/components/dashboard/RecentTrades';
import { ActivePositions } from '@/components/dashboard/ActivePositions';
import { calculateAnalytics } from '@/lib/analytics';
import { formatCurrency } from '@/lib/utils';
import type { Trade, Settings } from '@/types';
import type { AccountTruth } from '@/lib/hyperliquid/public';
import { toast } from 'sonner';

export default function DashboardPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [account, setAccount] = useState<AccountTruth | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [positionsKey, setPositionsKey] = useState(0);
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
      setPositionsKey(k => k + 1);
      // Exchange history is slower and optional; never block the page on it.
      fetch('/api/account')
        .then(r => (r.ok ? r.json() : null))
        .then(d => setAccount(d?.account ?? null))
        .catch(() => {})
        .finally(() => setAccountLoaded(true));
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
  const openTrades = trades.filter(t => t.status === 'open');
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const webhookUrl = `${appUrl}/api/webhook`;
  const tone = (v: number, good = 0) => (v > good ? 'up' : v < good ? 'down' : 'neutral');

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => fetchData(true)} refreshing={refreshing} actions={<TradeTicket settings={settings} onTraded={() => fetchData(true)} />} />

      <div className="p-4 lg:p-8 space-y-4 lg:space-y-6 flex-1 w-full max-w-[1400px] mx-auto">
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
          <div className="xl:col-span-2">
            <AccountPanel
              account={account}
              loading={!accountLoaded}
              isTestnet={settings?.is_testnet ?? true}
              notConnected={accountLoaded && account === null}
            />
          </div>
          <AutomationPanel
            settings={settings}
            loading={loading}
            webhookUrl={webhookUrl}
            onToggleWebhook={handleWebhookToggle}
            onFlattened={() => fetchData(true)}
          />
        </div>

        <div>
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 mb-2.5">
            <h2 className="text-sm font-semibold">Webhook trade log</h2>
            <p className="text-xs text-muted-foreground">Closed trades placed by this app, before fees and funding</p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            <Stat label="Total P&L" value={formatCurrency(metrics.totalPnl)} hint={`${metrics.totalTrades} closed · ${openTrades.length} open`} tone={tone(metrics.totalPnl)} loading={loading} />
            <Stat label="Win rate" value={`${metrics.winRate.toFixed(1)}%`} hint={`${metrics.winningTrades} wins · ${metrics.losingTrades} losses`} loading={loading} />
            <Stat label="Profit factor" value={isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'} hint="Gross profit ÷ gross loss" tone={tone(metrics.profitFactor, 1)} loading={loading} />
            <Stat label="Average trade" value={formatCurrency(metrics.expectancy)} hint={`Largest loss ${formatCurrency(metrics.largestLoss)}`} tone={tone(metrics.expectancy)} loading={loading} />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6">
          <div className="xl:col-span-2 order-2 xl:order-1">
            <RecentTrades trades={trades} loading={loading} />
          </div>
          <div className="order-1 xl:order-2">
            <ActivePositions key={positionsKey} />
          </div>
        </div>
      </div>
    </div>
  );
}
