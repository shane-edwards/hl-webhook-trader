'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { stockFillCalibration, stockFillMetrics, type StockJournalOrder } from '@/lib/stocks/execution-journal';
import { STOCK_TRADE_RULES } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

type Mode = 'demo' | 'real';
type Journal = { orders: StockJournalOrder[]; scans: { observed_at: string; state: string; detail: string }[]; connected: boolean; asOf: number };
const money = (value: number | null | undefined) => value == null ? '—' : formatCurrency(value);
const time = (value: string) => new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function JournalRow({ row, save, orders, asOf }: { row: StockJournalOrder; save: (id: string, amount: number | null) => Promise<void>; orders: StockJournalOrder[]; asOf: number }) {
  const [financing, setFinancing] = useState(row.statement_financing_usd == null ? '' : String(row.statement_financing_usd));
  const metrics = stockFillMetrics(row);
  const calibration = stockFillCalibration(orders, row.symbol, row.request.settlementType);
  const strategy = STOCK_TRADE_RULES.find(rule => rule.id === row.strategy);
  const missed = row.state === 'draft' && row.signal_expires_at != null && Date.parse(row.signal_expires_at) < asOf;
  const estimate = row.estimated_costs?.find(cost => cost.costType === 'overnightFee' && cost.currency.toUpperCase() === 'USD');
  const state = missed ? 'Signal expired before submission' : row.state === 'draft' ? 'Review only'
    : row.broker_state === 5 ? 'Partially filled' : row.broker_state === 6 ? 'Pending cancellation' : row.state;
  return <article className="rounded-lg border border-border p-3 space-y-2 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-semibold">{row.symbol} · {strategy?.name ?? 'Manual buy'} · {row.request.leverage}×</h3>
      <span className="text-xs text-muted-foreground">{time(row.created_at)} ET · {state}</span>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-4">
      <div><dt className="text-xs text-muted-foreground">Decision ask</dt><dd>{money(row.decision_quote?.ask ?? row.reference_price)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Submission ask</dt><dd>{money(row.submission_quote?.ask)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Broker fill</dt><dd>{money(row.fill_metrics?.price)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Slippage / time to fill</dt><dd>{metrics ? `${metrics.slipBps.toFixed(2)} bps` : '—'} / {metrics?.latencyMs == null ? '—' : `${(metrics.latencyMs / 1000).toFixed(2)} s`}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Broker entry fees</dt><dd>{money(row.fill_metrics?.feesUsd)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Broker entry taxes</dt><dd>{money(row.fill_metrics?.taxesUsd)}</dd></div>
      {row.request.leverage > 1 && <div><dt className="text-xs text-muted-foreground">Quoted overnight estimate</dt><dd>{money(estimate?.value)}</dd></div>}
      {row.request.leverage > 1 && <div><dt className="text-xs text-muted-foreground">Financing from statement</dt><dd>{money(row.statement_financing_usd)}</dd></div>}
    </dl>
    {Object.entries(row.close_execution).map(([id, close]) => <p key={id} className="text-xs text-muted-foreground">
      Exit #{close.orderId} · Submitted bid {money(close.quote?.bid)} · Fill {money(close.rate)}{close.closedAt && ` · ${time(close.closedAt)} ET`}
    </p>)}
    {row.broker_message && <p role="status" className="text-xs text-muted-foreground">{row.broker_message}</p>}
    <div className="flex flex-wrap items-center gap-2">
      {strategy && calibration.slipBps != null && <Button size="sm" variant="outline" asChild><Link href={stockHref('research', { rule: strategy.id, symbol: row.symbol, slipBps: String(Math.min(100, calibration.slipBps)) })}>Use measured slippage</Link></Button>}
      {row.request.leverage > 1 && row.state === 'filled' && <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void save(row.id, financing.trim() ? Number(financing) : null); }}>
        <label className="text-xs text-muted-foreground">Statement financing (USD)<Input className="mt-1" type="number" step="0.01" min="-100000" max="100000" value={financing} onChange={e => setFinancing(e.target.value)} /></label>
        <Button type="submit" size="sm" variant="ghost">Save</Button>
      </form>}
    </div>
  </article>;
}

export default function ExecutionJournalPage() {
  const query = useSearchParams();
  const [mode, setMode] = useState<Mode>(query.get('mode') === 'demo' ? 'demo' : 'real');
  const [journal, setJournal] = useState<{ mode: Mode; data: Journal } | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/stocks/journal?environment=${mode}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not load journal.');
    setJournal({ mode, data });
  }, [mode]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [load]);
  async function action(body: object) {
    setBusy(true); setError(''); setStatus('');
    try {
      const response = await fetch('/api/stocks/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, environment: mode }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setStatus('unavailable' in result ? `${result.updated} refreshed · ${result.unavailable} awaiting broker data` : 'Statement financing saved');
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update journal.'); }
    finally { setBusy(false); }
  }
  const data = journal?.mode === mode ? journal.data : null;
  const fills = data?.orders.flatMap(row => { const fill = stockFillMetrics(row); return fill ? [fill] : []; }) ?? [];
  const average = fills.length ? fills.reduce((sum, fill) => sum + fill.slipBps, 0) / fills.length : null;
  return <><Header /><div className="p-4 lg:p-8 space-y-4 max-w-[1400px] w-full mx-auto">
    <section className="surface p-4 lg:p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="font-semibold">Quotes and actual fills</h2>
        <Segmented aria-label="Journal account" value={mode} options={[{ value: 'demo', label: 'Paper' }, { value: 'real', label: 'Live' }]} disabled={busy} onChange={value => { setMode(value); setStatus(''); setError(''); }} />
      </div>
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {status && <p role="status" className="text-sm">{status}</p>}
      {data?.connected && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action({ action: 'sync' })}>{busy ? 'Refreshing…' : 'Refresh eToro fills'}</Button>}
      {data && !data.connected && <p className="text-sm text-muted-foreground">Connect this eToro account to refresh broker fills.</p>}
      <p className="text-sm text-muted-foreground">{fills.length} matched fills · {average == null ? 'Slippage unavailable' : `${average.toFixed(2)} bps average slippage`}. The scanner uses the 75th percentile for a ticker and account after ten matched fills.</p>
      {data?.orders.map(row => <JournalRow key={row.id} row={row} orders={data.orders} asOf={data.asOf} save={(id, usd) => action({ action: 'financing', id, usd })} />)}
      {data && !data.orders.length && <p className="text-sm">The journal will show stock orders as you review or submit them.</p>}
    </section>
    <section className="surface p-4 lg:p-6 space-y-2">
      <h2 className="font-semibold">Autopilot decisions</h2>
      {data?.scans.map((row, index) => <p className="text-sm" key={`${row.observed_at}:${index}`}><span className="text-muted-foreground">{time(row.observed_at)} ET</span> · {row.detail}</p>)}
      {data && !data.scans.length && <p className="text-sm text-muted-foreground">No recorded Autopilot checks in this mode.</p>}
    </section>
  </div></>;
}
