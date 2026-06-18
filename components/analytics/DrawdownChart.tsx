'use client';

import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { EquityPoint } from '@/types';

interface DrawdownChartProps {
  data: EquityPoint[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-xl text-xs">
      <p className="text-muted-foreground mb-1">{label}</p>
      <p className="font-bold text-loss">-{payload[0]?.value?.toFixed(2)}% drawdown</p>
    </div>
  );
}

export function DrawdownChart({ data }: DrawdownChartProps) {
  const maxDD = Math.max(...data.map(d => d.drawdown), 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Drawdown</CardTitle>
        <p className="text-xs text-muted-foreground">
          Max: <span className="text-loss font-medium">{maxDD.toFixed(2)}%</span>
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        {data.length === 0 ? (
          <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
            Not enough data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ddGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
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
                tickFormatter={v => `-${v.toFixed(0)}%`}
                width={50}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="drawdown"
                stroke="#ef4444"
                strokeWidth={1.5}
                fill="url(#ddGradient)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
