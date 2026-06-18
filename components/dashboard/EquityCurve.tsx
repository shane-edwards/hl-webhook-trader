'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { EquityPoint } from '@/types';
import { formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface EquityCurveProps {
  data: EquityPoint[];
  loading?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const equity = payload[0]?.value ?? 0;
  const pnl = payload[0]?.payload?.pnl ?? 0;
  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-bold text-foreground">{formatCurrency(equity)}</p>
      <p className={`font-medium ${pnl >= 0 ? 'text-profit' : 'text-loss'}`}>
        {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)} this trade
      </p>
    </div>
  );
}

export function EquityCurve({ data, loading }: EquityCurveProps) {
  const isPositive = data.length > 0 && data[data.length - 1].equity >= 0;

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-sm">Equity Curve</CardTitle></CardHeader>
        <CardContent><Skeleton className="h-52 w-full" /></CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Equity Curve</CardTitle>
        {data.length > 0 && (
          <p className={`text-xl font-bold tabular-nums ${isPositive ? 'text-profit' : 'text-loss'}`}>
            {formatCurrency(data[data.length - 1]?.equity ?? 0)}
          </p>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        {data.length === 0 ? (
          <div className="h-52 flex items-center justify-center text-muted-foreground text-sm">
            No closed trades yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={isPositive ? '#22c55e' : '#ef4444'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 15%)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'hsl(215 20% 55%)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: 'hsl(215 20% 55%)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => `$${v.toFixed(0)}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="equity"
                stroke={isPositive ? '#22c55e' : '#ef4444'}
                strokeWidth={2}
                fill="url(#equityGradient)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
