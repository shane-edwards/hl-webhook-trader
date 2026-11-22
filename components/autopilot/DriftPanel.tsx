'use client';

import { useEffect, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import { ChartTooltip } from '@/components/ui/stat';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import type { StrategyDrift } from '@/lib/autopilot/drift';

interface Data { available: boolean; since: number | null; truncated?: boolean; strategies: StrategyDrift[]; error?: string }

/**
 * Paper record against the backtest's simulator over the same dates, one small
 * chart per strategy. The two lines should move together; a paper line that
 * falls away from the replay means the live scanner and the backtest disagree.
 */
export function DriftPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => {
    fetch('/api/autopilot/drift').then(r => r.json()).then(setData).catch(() => setData({ available: true, since: null, strategies: [], error: 'Could not load' }));
  }, [refreshKey]);

  if (data && !data.available) return null;
  return (
    <section className="surface p-5 space-y-4" aria-label="Paper record versus backtest">
      <div>
        <h2 className="text-sm font-semibold">Paper record versus backtest</h2>
        <p className="text-xs text-muted-foreground mt-1 max-w-3xl leading-relaxed">
          For the dates the paper account has run: realised profit and loss on paper, against what the backtest&apos;s simulator makes of the same rules, markets and sizing.
          The lines will not match exactly: the replay takes every signal, while the paper book holds one position per market and stops at the position limit.
          A paper line that keeps falling away from the replay is the warning sign.
        </p>
      </div>
      {!data ? <Skeleton className="h-40 w-full rounded-lg" />
        : data.error ? <p className="text-sm text-muted-foreground">{data.error}</p>
        : !data.strategies.length ? <p className="text-sm text-muted-foreground">No paper trades yet. This fills in once the paper account has opened its first position.</p>
        : (
          <>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: 'var(--series-1)' }} />Paper (what happened)</span>
              <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: 'var(--series-2)' }} />Replay (what the backtest expects)</span>
              {data.since && <span>since {format(data.since, 'MMM d, yyyy')}{data.truncated ? ' (as far back as one data request reaches)' : ''}</span>}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {data.strategies.map(s => (
                <div key={s.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-semibold">{s.name}</h3>
                    <p className="num text-[11px] text-muted-foreground">
                      paper {formatCurrency(s.paperPnl)} ({s.paperTrades}) · replay {formatCurrency(s.replayPnl)} ({s.replayTrades})
                    </p>
                  </div>
                  <ResponsiveContainer width="100%" height={130}>
                    <LineChart data={s.points} margin={{ top: 8, right: 6, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={t => format(t, 'MMM d')}
                        tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={40} />
                      <YAxis tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }} axisLine={false} tickLine={false} width={44} tickFormatter={v => `$${v.toFixed(0)}`} />
                      <Tooltip content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as StrategyDrift['points'][number];
                        return <ChartTooltip title={format(p.t, 'MMM d, HH:mm')} rows={[
                          { label: 'Paper', value: formatCurrency(p.paper), color: 'var(--series-1)' },
                          { label: 'Replay', value: formatCurrency(p.replay), color: 'var(--series-2)' },
                        ]} />;
                      }} />
                      <Line type="stepAfter" dataKey="replay" stroke="var(--series-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
                      <Line type="stepAfter" dataKey="paper" stroke="var(--series-1)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </div>
          </>
        )}
    </section>
  );
}
