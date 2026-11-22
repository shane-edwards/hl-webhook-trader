'use client';

import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import { Segmented } from '@/components/ui/segmented';
import { ChartTooltip } from '@/components/ui/stat';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { cn, formatCurrency } from '@/lib/utils';
import type { AccountTruth } from '@/lib/hyperliquid/public';

type Period = 'day' | 'week' | 'month' | 'allTime';
const PERIODS: Array<{ value: Period; label: string }> = [
  { value: 'day', label: '24H' },
  { value: 'week', label: '7D' },
  { value: 'month', label: '30D' },
  { value: 'allTime', label: 'All' },
];
const TICK_FORMAT: Record<Period, string> = { day: 'HH:mm', week: 'MMM d', month: 'MMM d', allTime: 'MMM yy' };

const compact = (v: number) =>
  Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}k` : `$${v.toFixed(0)}`;

interface Props {
  account: AccountTruth | null;
  loading: boolean;
  isTestnet: boolean;
  /** True when no exchange key is configured yet. */
  notConnected: boolean;
}

export function AccountPanel({ account, loading, isTestnet, notConnected }: Props) {
  const [period, setPeriod] = useState<Period>('month');

  const { data, value, pnl } = useMemo(() => {
    const h = account?.periods[period];
    const pnlByT = new Map((h?.pnl ?? []).map(p => [p.t, p.v]));
    const rows = (h?.equity ?? []).map(p => ({ t: p.t, equity: p.v, pnl: pnlByT.get(p.t) ?? 0 }));
    return {
      data: rows,
      value: rows.length ? rows[rows.length - 1].equity : 0,
      pnl: h?.pnl.length ? h.pnl[h.pnl.length - 1].v : 0,
    };
  }, [account, period]);

  const costs = account?.last30d;
  const small: Array<{ label: string; value: string; tone?: 'up' | 'down' }> = costs
    ? [
        { label: 'Realised P&L · 30d', value: formatCurrency(costs.realizedPnl), tone: costs.realizedPnl > 0 ? 'up' : costs.realizedPnl < 0 ? 'down' : undefined },
        { label: 'Fees paid · 30d', value: formatCurrency(costs.fees) },
        { label: 'Funding · 30d', value: formatCurrency(costs.funding), tone: costs.funding > 0 ? 'up' : costs.funding < 0 ? 'down' : undefined },
        { label: 'Fills · 30d', value: `${costs.fills}${costs.truncated ? '+' : ''}` },
      ]
    : [];

  return (
    <section className="surface overflow-hidden h-full flex flex-col" aria-label="Account">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div>
          <div className="flex items-center gap-2">
            <p className="eyebrow">Account value</p>
            <Badge variant={isTestnet ? 'warning' : 'secondary'} className="text-[10px] py-0">{isTestnet ? 'TESTNET' : 'MAINNET'}</Badge>
          </div>
          {loading ? (
            <Skeleton className="h-10 w-48 mt-2" />
          ) : (
            <p className="num text-3xl sm:text-4xl font-semibold mt-1.5 leading-none">{formatCurrency(value)}</p>
          )}
          {!loading && !notConnected && (
            <p className="text-sm mt-2">
              <span className={cn('num font-medium', pnl > 0 ? 'text-profit' : pnl < 0 ? 'text-loss' : 'text-muted-foreground')}>
                {pnl > 0 ? '+' : ''}{formatCurrency(pnl)}
              </span>
              <span className="text-muted-foreground"> profit and loss, {PERIODS.find(p => p.value === period)!.label.toLowerCase()} · from the exchange</span>
            </p>
          )}
        </div>
        <Segmented value={period} onChange={setPeriod} options={PERIODS} aria-label="Period" />
      </div>

      <div className="h-56 sm:h-64 mt-3 px-2 flex-1 min-h-[14rem]">
        {loading ? (
          <Skeleton className="h-full w-full rounded-lg" />
        ) : data.length < 2 ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground px-6 text-center">
            {notConnected ? 'Connect your Hyperliquid account in Settings to see its history here.' : 'No account history for this period yet.'}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="acct-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickCount={6}
                tickFormatter={t => format(new Date(t), TICK_FORMAT[period])}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={40}
              />
              <YAxis
                domain={['auto', 'auto']} tickFormatter={compact} width={56}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickLine={false} axisLine={false}
              />
              <Tooltip
                cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeOpacity: 0.4 }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const p = payload[0].payload as { t: number; equity: number; pnl: number };
                  return (
                    <ChartTooltip
                      title={format(new Date(p.t), 'MMM d, yyyy HH:mm')}
                      rows={[
                        { label: 'Account value', value: formatCurrency(p.equity), color: 'var(--series-1)' },
                        { label: 'P&L in period', value: formatCurrency(p.pnl) },
                      ]}
                    />
                  );
                }}
              />
              <Area type="monotone" dataKey="equity" stroke="var(--series-1)" strokeWidth={2} fill="url(#acct-fill)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {small.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-4 border-t border-border mt-3 divide-x divide-border/70 [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border/70 sm:[&>*]:border-b-0">
          {small.map(s => (
            <div key={s.label} className="px-5 py-3">
              <dt className="eyebrow">{s.label}</dt>
              <dd className={cn('num text-[15px] font-medium mt-1', s.tone === 'up' && 'text-profit', s.tone === 'down' && 'text-loss')}>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
