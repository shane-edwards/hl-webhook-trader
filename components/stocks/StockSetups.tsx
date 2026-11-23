'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { stockSizingParams, type StockLeverage } from '@/lib/stocks/leverage';
import type { StockSetupScan } from '@/lib/stocks/setups';
import { STOCK_EXIT_LABELS, STOCK_TRADE_RULES } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';
import insideDayEvidence from '@/lib/stocks/inside-day-evidence.json';

const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

export function StockSetups({ connections }: { connections: ('demo' | 'real')[] }) {
  const [selectedEnvironment, setEnvironment] = useState<'demo' | 'real' | null>(null);
  const environment = selectedEnvironment ?? (connections.includes('demo') ? 'demo' : connections[0]) ?? null;
  const [amount, setAmount] = useState('1000');
  const [leverage, setLeverage] = useState<StockLeverage>(1);
  const [stop, setStop] = useState('10');
  const [scan, setScan] = useState<{ result: StockSetupScan; sizing: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectClass = 'mt-1 w-full rounded-md border border-border bg-background px-3 h-10';

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!environment || busy) return;
    setError('');
    setScan(null);
    setBusy(true);
    try {
      const sizing = stockSizingParams({ amount: Number(amount), leverage, stopMarginPct: Number(stop) });
      const response = await fetch(`/api/stocks?${new URLSearchParams({ view: 'setups', environment, ...sizing })}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'The scan did not finish.');
      setScan({ result: data, sizing });
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The scan did not finish.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="surface p-4 lg:p-6 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">Find an entry now</h2>
        <p className="text-sm text-muted-foreground">Find qualifying strategy entries across the supported US stocks. The Strong buy grade is available under Discover.</p>
      </div>
      {connections.length === 2 && environment && <Segmented aria-label="Setup scan account" value={environment} disabled={busy}
        options={[{ value: 'demo', label: 'Paper' }, { value: 'real', label: 'Live' }]} onChange={mode => { setEnvironment(mode); setScan(null); setError(''); }} />}
    </div>
    {!environment ? <Button asChild><Link href={stockHref('account')}>Connect eToro</Link></Button> : <form className="grid sm:grid-cols-2 lg:grid-cols-4 items-end gap-3" onSubmit={run}>
      <label className="text-sm">{leverage === 1 ? 'Amount (USD)' : 'Margin (USD)'}<Input className="mt-1" type="number" min="1" max="10000" step="0.01" required disabled={busy} value={amount} onChange={e => { setAmount(e.target.value); setScan(null); }} /></label>
      <label className="text-sm">Leverage<select aria-label="Leverage" className={selectClass} disabled={busy} value={leverage} onChange={e => { setLeverage(Number(e.target.value) as StockLeverage); setScan(null); }}>
        <option value={1}>1× · Cash</option><option value={2}>2× · CFD</option><option value={5}>5× · CFD</option>
      </select></label>
      {leverage > 1 && <label className="text-sm">Stop loss (% of margin)<Input className="mt-1" type="number" min="0.01" max="50" step="0.01" required disabled={busy} value={stop} onChange={e => { setStop(e.target.value); setScan(null); }} /></label>}
      <Button disabled={busy} type="submit">{busy ? 'Checking entries…' : 'Scan for setups'}</Button>
    </form>}
    {error && <p role="alert" className="text-sm text-loss">{error}</p>}
    {scan && <div aria-live="polite" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {time.format(new Date(scan.result.scannedAt))} ET · {environment === 'real' ? 'eToro Real' : 'eToro Demo'} · {scan.result.evaluated} of {scan.result.planned} stock and rule pairs checked
        {scan.result.outsideWindow > 0 && ` · ${scan.result.outsideWindow} outside the entry window`}
      </p>
      {!scan.result.open ? <p className="text-sm">The US regular session is closed. Scan when it opens at 9:30 a.m. ET.</p>
        : scan.result.rows.length === 0 ? <p className="text-sm">No setup met the entry, quote and cost checks.</p>
        : <p className="text-sm text-muted-foreground">Ranked by estimated entry friction. Overnight and weekend financing appear separately below.</p>}
      <div className="grid gap-3 md:grid-cols-2">{scan.result.rows.map(row => {
        const rule = STOCK_TRADE_RULES.find(rule => rule.id === row.rule)!;
        const params = { symbol: row.symbol, rule: row.rule, ...scan.sizing };
        const financing = row.costs.filter(cost => cost.value !== 0 && ['overnightFee', 'overWeekendFee'].includes(cost.costType));
        return <article key={`${row.symbol}:${row.rule}`} className="rounded-lg border border-border p-4 space-y-2">
          <h3 className="font-semibold">{row.symbol} · {rule.name}{row.rule === 'earnings-rebound' && ' (Experimental)'}</h3>
          <p className="text-sm">{row.signal.description ?? rule.description}</p>
          {row.rule === 'inside-day' && <p className="text-xs text-muted-foreground">{insideDayEvidence.stages[2].trades} historical holdout trades across {insideDayEvidence.symbols.length} stocks. Average under higher costs was {insideDayEvidence.stages[2].stressBps.toFixed(1)} bps per trade.</p>}
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">Indicative entry ask</dt><dd>{formatCurrency(row.ask)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Estimated entry friction</dt><dd>{formatCurrency(row.entryCost)} · {row.spreadBps.toFixed(1)} bps quoted spread</dd></div>
            <div className="col-span-2"><dt className="text-xs text-muted-foreground">Strategy exit</dt><dd>{STOCK_EXIT_LABELS[row.rule]}{row.execution.settlementType === 'cfd' && ` · Stop ${formatCurrency(row.execution.stopLossRate)}`}</dd></div>
          </dl>
          {financing.map(fee => <p key={fee.costType} className="text-xs text-muted-foreground">{fee.costType === 'overnightFee' ? 'Overnight' : 'Weekend'} financing {fee.value.toFixed(2)} {fee.currency}</p>)}
          <p className="text-xs text-muted-foreground">Quote {time.format(new Date(row.quoteAt!))} ET · Entry check expires {time.format(new Date(row.signal.validUntil))} ET</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild><Link href={stockHref('trade', { ...params, mode: 'demo' })}>Review Paper</Link></Button>
            <Button size="sm" variant="outline" asChild><Link href={stockHref('trade', { ...params, mode: 'real' })}>Review Live</Link></Button>
            <Button size="sm" variant="ghost" asChild><Link href={stockHref('research', params)}>Backtest</Link></Button>
          </div>
        </article>;
      })}</div>
      {scan.result.unavailable.length > 0 && <p className="text-xs text-muted-foreground">Incomplete data for {scan.result.unavailable.join(', ')}.</p>}
      {scan.result.spreadSkipped + scan.result.estimateSkipped > 0 && <p className="text-xs text-muted-foreground">{scan.result.spreadSkipped} skipped for quote, spread or timing · {scan.result.estimateSkipped} without a broker cost estimate.</p>}
    </div>}
  </section>;
}
