'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Stat } from '@/components/ui/stat';
import { AccountPanel } from '@/components/dashboard/AccountPanel';
import { AutomationPanel } from '@/components/dashboard/AutomationPanel';
import { TradeTicket } from '@/components/dashboard/TradeTicket';
import { TradeIdeas } from '@/components/dashboard/TradeIdeas';
import { Scorecard } from '@/components/dashboard/Scorecard';
import { OpenOrders } from '@/components/dashboard/OpenOrders';
import { HealthBanner } from '@/components/dashboard/HealthBanner';
import { AlertsPanel } from '@/components/dashboard/AlertsPanel';
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
  const [preset, setPreset] = useState<{ symbol: string; side: 'long' | 'short'; nonce: number } | null>(null);
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
      <Header onRefresh={() => fetchData(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-8 space-y-4 lg:space-y-6 flex-1 w-full max-w-[1400px] mx-auto">
        <HealthBanner />
        <section className="grid sm:grid-cols-2 gap-3" aria-label="Crypto trading actions">
          <div className="surface p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Choose a market and review your order.</p>
            <TradeTicket settings={settings} onTraded={() => fetchData(true)} preset={preset} />
          </div>
          <div className="surface p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Try a strategy with simulated funds.</p>
            <Button asChild variant="outline"><Link href="/autopilot"><Bot className="w-4 h-4" />Open Autopilot</Link></Button>
          </div>
        </section>
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

        <OpenOrders refreshKey={positionsKey} onChanged={() => fetchData(true)} />
        <ActivePositions key={positionsKey} />
        <TradeIdeas onTrade={(symbol, side) => setPreset({ symbol, side, nonce: Date.now() })} />

        <details className="surface p-4 space-y-4">
          <summary className="cursor-pointer text-sm font-semibold">Trade history and analytics</summary>
          <Scorecard />
          <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 mb-2.5">
            <h2 className="text-sm font-semibold">Trade log</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            <Stat label="Total P&L" value={formatCurrency(metrics.totalPnl)} hint={`${metrics.totalTrades} closed · ${openTrades.length} open`} tone={tone(metrics.totalPnl)} loading={loading} />
            <Stat label="Win rate" value={`${metrics.winRate.toFixed(1)}%`} hint={`${metrics.winningTrades} wins · ${metrics.losingTrades} losses`} loading={loading} />
            <Stat label="Profit factor" value={isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'} hint="Gross profit ÷ gross loss" tone={tone(metrics.profitFactor, 1)} loading={loading} />
            <Stat label="Average trade" value={formatCurrency(metrics.expectancy)} hint={`Largest loss ${formatCurrency(metrics.largestLoss)}`} tone={tone(metrics.expectancy)} loading={loading} />
          </div>
          <RecentTrades trades={trades} loading={loading} />
          <AlertsPanel refreshKey={positionsKey} />
        </details>
      </div>
    </div>
  );
}
