'use client';

import { useEffect, useState } from 'react';
import type { HedgeMarket } from '@/lib/hedge-research/model';
import { formatCurrency } from '@/lib/utils';

type HedgeSnapshot = { status: string; detail: string; rate14d: number | null; simulatedNet: number | null; spreadCostBps: number | null;
  closed: number; realized: number; missingHours: number };
type Report = { observedAt: string | null; sampleCapital: number; snapshot: HedgeSnapshot | null };

export function FundingHedge({ symbol }: { symbol: HedgeMarket }) {
  const [result, setResult] = useState<Report>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      try {
        const response = await fetch(`/api/funding-hedge?symbol=${symbol}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json() as Report;
        if (!controller.signal.aborted) { setResult(data); setFailed(false); }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    };
    void update();
    const interval = setInterval(() => void update(), 60_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [symbol]);
  const sample = result?.snapshot;
  const status = failed ? 'Could not load observations'
    : !sample ? 'Waiting for the first observation'
      : sample.status === 'opened' || sample.status === 'holding' ? 'Paper hedge open'
        : sample.status === 'closed' ? 'Paper hedge closed' : sample.status === 'unavailable' ? 'Market data unavailable' : 'Watching funding';
  return <details className="surface p-4">
    <summary className="cursor-pointer text-sm font-medium">{symbol} funding hedge <span className="ml-1 text-xs text-muted-foreground">Paper research</span></summary>
    <div className="mt-3 space-y-2 text-sm">
      <p className="font-medium">{status}</p>
      <p className="text-xs text-muted-foreground">Long spot · Short an equal amount of perpetuals</p>
      {sample && <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        {sample.rate14d != null && <span>14-day funding {(100 * sample.rate14d).toFixed(3)}%</span>}
        {sample.spreadCostBps != null && <span>Estimated round trip {(sample.spreadCostBps / 100).toFixed(3)}%</span>}
        {sample.simulatedNet != null && <span>Simulated trade P&L {formatCurrency(sample.simulatedNet)}</span>}
        {!!sample.closed && <span>{sample.closed} closed · {formatCurrency(sample.realized)} realized in the simulation</span>}
        {!!sample.missingHours && <span>{sample.missingHours} missed hourly checks</span>}
      </div>}
      {sample && <p className="text-xs text-muted-foreground">{sample.detail}</p>}
      {!!result?.observedAt && <p className="text-xs text-muted-foreground">Checked {new Date(result.observedAt).toLocaleString()} · {formatCurrency(result.sampleCapital)} modeled capital</p>}
    </div>
  </details>;
}
