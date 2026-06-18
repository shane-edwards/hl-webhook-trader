'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { MonthlyPnL } from '@/types';
import { formatCurrency } from '@/lib/utils';

interface PnLChartProps {
  data: MonthlyPnL[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as MonthlyPnL;
  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-xl text-xs space-y-1">
      <p className="font-semibold text-foreground">{label}</p>
      <p className={`font-bold ${d.pnl >= 0 ? 'text-profit' : 'text-loss'}`}>{formatCurrency(d.pnl)}</p>
      <p className="text-muted-foreground">{d.trades} trades · {d.winRate.toFixed(0)}% win rate</p>
    </div>
  );
}

export function PnLChart({ data }: PnLChartProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Monthly P&L</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {data.length === 0 ? (
          <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
            Not enough data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(0 0% 15%)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: 'hsl(215 20% 55%)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'hsl(215 20% 55%)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => `$${v.toFixed(0)}`}
                width={55}
              />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {data.map((entry, index) => (
                  <Cell key={index} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
