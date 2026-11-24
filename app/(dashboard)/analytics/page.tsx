'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import { Header } from '@/components/layout/Header';
import { PnLChart } from '@/components/analytics/PnLChart';
import { Stat, ChartTooltip } from '@/components/ui/stat';
import { Segmented } from '@/components/ui/segmented';
import { equityStats, MIN_DAYS_FOR_SHARPE } from '@/lib/analytics';
import { type TagResult } from '@/lib/journal';
import { cn, formatCurrency } from '@/lib/utils';
import type { AnalyticsReport } from '@/lib/analytics-report';
import type { AccountTruth } from '@/lib/hyperliquid/public';
import { toast } from 'sonner';

type Period = 'month' | 'allTime';
const PERIODS: Array<{ value: Period; label: string }> = [{ value: 'month', label: '30 days' }, { value: 'allTime', label: 'All time' }];
const pct = (v: number | null, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined, good = 0) => (v == null ? 'neutral' : v > good ? 'up' : v < good ? 'down' : 'neutral');

function TagTable({ title, rows }: { title: string; rows: TagResult[] }) {
  return (
    <div className="surface overflow-x-auto">
      <table className="data-table">
        <thead><tr><th>{title}</th><th>Trades</th><th>Win rate</th><th>Average</th><th>Total</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.tag}>
              <td className="font-medium">{r.tag}</td>
              <td className="num">{r.trades}</td>
              <td className="num">{r.trades ? `${r.winRate.toFixed(0)}%` : '—'}</td>
              <td className={cn('num', r.trades && (r.average > 0 ? 'text-profit' : r.average < 0 ? 'text-loss' : ''))}>{r.trades ? formatCurrency(r.average) : '—'}</td>
              <td className={cn('num', r.trades && (r.total > 0 ? 'text-profit' : r.total < 0 ? 'text-loss' : ''))}>{r.trades ? formatCurrency(r.total) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AnalyticsPage() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [account, setAccount] = useState<AccountTruth | null>(null);
  const [accountState, setAccountState] = useState<'loading' | 'ready' | 'none'>('loading');
  const [period, setPeriod] = useState<Period>('month');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    try {
      const [analytics, exchange] = await Promise.allSettled([
        fetch('/api/analytics').then(r => r.ok ? r.json() : null),
        fetch('/api/account').then(r => r.ok ? r.json() : null),
      ]);
      setReport(analytics.status === 'fulfilled' ? analytics.value : null);
      const a = exchange.status === 'fulfilled' ? exchange.value?.account ?? null : null;
      setAccount(a); setAccountState(a ? 'ready' : 'none');
    } catch {
      toast.error('Failed to load analytics data');
      setAccountState(s => (s === 'loading' ? 'none' : s));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const eq = useMemo(() => equityStats(account?.periods[period]), [account, period]);
  // Sharpe always uses the 30-day series: it is the only one with roughly daily points.
  const month = useMemo(() => equityStats(account?.periods.month), [account]);
  const acctLoading = accountState === 'loading';
  const last30 = account?.last30d;

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => load(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-8 space-y-6 lg:space-y-8 flex-1 w-full max-w-[1400px] mx-auto">
        <section className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold">Account, as the exchange recorded it</h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Measured against real account value. Returns take deposits and withdrawals out, so adding money does not look like profit.
              </p>
            </div>
            <Segmented options={PERIODS} value={period} onChange={setPeriod} />
          </div>

          {accountState === 'none' ? (
            <p className="surface px-5 py-6 text-sm text-muted-foreground">Connect your Hyperliquid account in Settings to see account-level figures. The trade statistics below come from this app&apos;s own log.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
                <Stat label="Return" value={pct(eq.returnPct)} hint={`${formatCurrency(eq.pnl)} profit and loss`} tone={tone(eq.returnPct)} loading={acctLoading} />
                <Stat label="Largest drawdown" value={eq.maxDrawdownPct == null ? '—' : `-${eq.maxDrawdownPct.toFixed(2)}%`}
                  hint={period === 'allTime' ? 'From weekly points: dips inside a week are missed' : 'Peak-to-trough fall in the period'} tone={eq.maxDrawdownPct ? 'down' : 'neutral'} loading={acctLoading} />
                <Stat label="Sharpe ratio" value={month.sharpe == null ? '—' : month.sharpe.toFixed(2)}
                  hint={month.sharpe == null ? `Needs ${MIN_DAYS_FOR_SHARPE} daily returns; have ${month.days}` : `Daily returns, last ${month.days} days, annualised`} tone={tone(month.sharpe)} loading={acctLoading} />
                <Stat label="Fees and funding, 30 days" value={last30 ? formatCurrency(-(last30.fees) + last30.funding) : '—'}
                  hint={last30 ? `Fees ${formatCurrency(-last30.fees)} · funding ${formatCurrency(last30.funding)}${last30.truncated ? ' (at least)' : ''}` : undefined}
                  tone={last30 ? tone(-(last30.fees) + last30.funding) : 'neutral'} loading={acctLoading} />
              </div>

              <div className="surface p-4 lg:p-5">
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-sm font-semibold">Return index</h3>
                  <p className="text-xs text-muted-foreground">Starts at 100; deposits and withdrawals removed</p>
                </div>
                {eq.points.length < 2 ? (
                  <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">{acctLoading ? 'Loading…' : 'Not enough account history yet'}</div>
                ) : (
                  <ResponsiveContainer width="100%" height={240}>
                    <AreaChart data={eq.points} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="idx" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.25} />
                          <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={t => format(t, period === 'month' ? 'MMM d' : 'MMM yy')}
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={40} />
                      <YAxis domain={['auto', 'auto']} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={false} tickLine={false} width={44} tickFormatter={v => v.toFixed(0)} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as (typeof eq.points)[number];
                        return <ChartTooltip title={format(p.t, 'MMM d, yyyy HH:mm')} rows={[
                          { label: 'Return index', value: p.index.toFixed(2), color: 'var(--series-1)' },
                          { label: 'Below peak', value: `-${p.drawdownPct.toFixed(2)}%` },
                          { label: 'Account value', value: formatCurrency(p.equity) },
                        ]} />;
                      }} />
                      <Area type="monotone" dataKey="index" stroke="var(--series-1)" strokeWidth={2} fill="url(#idx)" isAnimationActive={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </>
          )}
        </section>

        {report ? <>
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Trades placed by this app</h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
              Closed trades, after fees and funding where the exchange figures have been pulled
              ({report.stats.costedTrades} of {report.stats.totalTrades} so far; the rest show price move only, which flatters them).
            </p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
            <Stat label="Net profit and loss" value={formatCurrency(report.stats.totalPnl)} hint={`${report.stats.totalTrades} closed trades`} tone={tone(report.stats.totalPnl)} loading={loading} />
            <Stat label="Win rate" value={`${report.stats.winRate.toFixed(1)}%`} hint={`${report.stats.winningTrades} wins · ${report.stats.losingTrades} losses`} loading={loading} />
            <Stat label="Profit factor" value={report.stats.profitFactor != null && isFinite(report.stats.profitFactor) ? report.stats.profitFactor.toFixed(2) : '∞'} hint="Gross profit ÷ gross loss" tone={tone(report.stats.profitFactor, 1)} loading={loading} />
            <Stat label="Average trade" value={formatCurrency(report.stats.expectancy)} hint="Net result per closed trade" tone={tone(report.stats.expectancy)} loading={loading} />
            <Stat label="Average win / loss" value={`${formatCurrency(report.stats.avgWin)} / ${formatCurrency(-report.stats.avgLoss)}`} hint={report.stats.avgWinLossRatio != null && isFinite(report.stats.avgWinLossRatio) && report.stats.avgWinLossRatio > 0 ? `Ratio ${report.stats.avgWinLossRatio.toFixed(2)}` : undefined} loading={loading} />
            <Stat label="Largest win / loss" value={`${formatCurrency(report.stats.largestWin)} / ${formatCurrency(report.stats.largestLoss)}`} hint={`Longest runs: ${report.stats.maxConsecutiveWins} wins, ${report.stats.maxConsecutiveLosses} losses`} loading={loading} />
            <Stat label="Fees paid" value={formatCurrency(-report.stats.totalFees)} hint="On trades with exchange figures" tone={report.stats.totalFees > 0 ? 'down' : 'neutral'} loading={loading} />
            <Stat label="Funding" value={formatCurrency(-report.stats.totalFunding)} hint={`Average hold ${report.stats.avgTradeDurationHours.toFixed(1)} hours`} tone={tone(-report.stats.totalFunding)} loading={loading} />
          </div>
          <PnLChart data={report.monthly} />
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Execution: what getting in costs</h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
              Each entry is compared with the mid price at the moment the order was sent. Slippage is the gap; a negative figure means a better price than the mid,
              which only a resting order can get. Fees cover entry and exit and appear once the exchange figures are in. A market order pays 0.045% a side, a resting one 0.015%.
            </p>
          </div>
          {report.execution[0].trades === 0 ? (
            <p className="surface px-5 py-5 text-sm text-muted-foreground">No measured entries yet. Entries are measured from now on; earlier trades did not record the price at the moment of sending.</p>
          ) : (
            <div className="surface overflow-x-auto">
              <table className="data-table">
                <thead><tr><th>How it was sent</th><th>Entries</th><th>Avg slippage</th><th>Slippage cost</th><th>Fees, round trip</th></tr></thead>
                <tbody>
                  {report.execution.map(r => (
                    <tr key={r.type}>
                      <td className="font-medium">{r.type}</td>
                      <td className="num">{r.trades}</td>
                      <td className={cn('num', r.avgSlippageBps != null && (r.avgSlippageBps > 0 ? 'text-loss' : r.avgSlippageBps < 0 ? 'text-profit' : ''))}>{r.avgSlippageBps == null ? '—' : `${(r.avgSlippageBps / 100).toFixed(3)}%`}</td>
                      <td className={cn('num', r.slippageUsd > 0 ? 'text-loss' : r.slippageUsd < 0 ? 'text-profit' : '')}>{formatCurrency(-r.slippageUsd)}</td>
                      <td className="num">{r.feeBps == null ? '—' : `${(r.feeBps / 100).toFixed(3)}%`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold">Journal: manual trades by habit</h2>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
              Each manual trade is tagged when it is placed: whether it followed the rules&apos; read, whether you kept the suggested stop, and which chart timeframe it was sized on.
              A handful of trades proves nothing either way; this becomes useful after a few dozen.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3 lg:gap-4">
            <TagTable title="Direction" rows={report.tags.read} />
            <TagTable title="Stop" rows={report.tags.stop} />
            <TagTable title="Timeframe" rows={report.tags.timeframe} />
          </div>
        </section>
        </> : <p role="status" className="surface p-5 text-sm">{loading ? 'Loading complete trade history…' : 'Trade analytics unavailable. Refresh to retry.'}</p>}
      </div>
    </div>
  );
}
