'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { CATALYST_COSTS, type CatalystFiling, type CatalystObservation, type catalystComparison } from '@/lib/stocks/catalyst';
import { CATALYST_UNIVERSE } from '@/lib/stocks/catalyst-universe';
import { formatCurrency } from '@/lib/utils';

type Mode = 'demo' | 'real';
type ShadowBook = {
  open: boolean; connections: Mode[]; rows: CatalystObservation[]; comparisons: ReturnType<typeof catalystComparison>;
  settings: { environment: Mode; enabled: boolean; last_checked_at: string | null } | null;
  latest: { session_day: string; completed_at: string; summary: {
    scanned: number; unavailable: string[]; events: (CatalystFiling & { symbol: string })[]; rows: number;
  } } | null;
};
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const bps = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)} bps`;
const money = (value: number | null | undefined) => value == null ? '—' : formatCurrency(value);

export default function StockCatalystsPage() {
  const [mode, setMode] = useState<Mode>('real');
  const [payload, setPayload] = useState<{ mode: Mode; data: ShadowBook } | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/stocks/catalysts?environment=${mode}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setPayload({ mode, data });
  }, [mode]);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => void load(abort.signal).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    refresh();
    const repeat = setInterval(refresh, 45_000);
    return () => { abort.abort(); clearInterval(repeat); };
  }, [load]);
  const data = payload?.mode === mode ? payload.data : null;
  const ordered = [...(data?.rows ?? [])].sort((a, b) => b.session_day.localeCompare(a.session_day) ||
    Number(b.decision.status === 'Qualified') - Number(a.decision.status === 'Qualified') ||
    Number(a.lane === 'control') - Number(b.lane === 'control') ||
    (b.decision.relativeBps ?? -Infinity) - (a.decision.relativeBps ?? -Infinity) || a.symbol.localeCompare(b.symbol));
  const scheduledHere = !!data?.settings?.enabled && data.settings.environment === mode;
  const connected = !!data?.connections.includes(mode);
  async function act(action: 'capture' | 'settle' | 'schedule') {
    setBusy(action); setMessage(''); setError('');
    try {
      const response = await fetch('/api/stocks/catalysts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, environment: mode, ...(action === 'schedule' ? { enabled: !scheduledHere } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setMessage(result.message);
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update the shadow book.'); }
    finally { setBusy(''); }
  }
  return <><Header /><div className="p-4 lg:p-8 max-w-[1400px] mx-auto w-full space-y-4">
    <section className="surface p-4 lg:p-6 space-y-3">
      <div className="flex flex-wrap gap-3 justify-between">
        <div><h2 className="font-semibold">Earnings and guidance at the open</h2>
          <p className="text-sm text-muted-foreground">{CATALYST_UNIVERSE.length} US stocks · SEC filings · 15-minute relative strength and volume</p></div>
        <Segmented aria-label="Shadow book price feed" value={mode} options={[{ value: 'real', label: 'Real feed' }, { value: 'demo', label: 'Demo feed' }]}
          disabled={!!busy} onChange={next => { setMode(next); setError(''); setMessage(''); }} />
      </div>
      <p className="text-sm">Shadow mode simulates trades and records what happens to the setups it passes on. Opening capture is available from 9:47 to 9:56 a.m. ET.</p>
      <div className="flex flex-wrap gap-2">
        {data && !connected ? <Button asChild><Link href={stockHref('account', { mode })}>Connect eToro market data</Link></Button> : <>
          <Button disabled={!connected || !data?.open || !!busy} onClick={() => void act('capture')}>{busy === 'capture' ? 'Capturing…' : 'Capture now'}</Button>
          <Button variant="outline" disabled={!connected || !!busy} onClick={() => void act('schedule')}>{scheduledHere ? 'Pause daily capture' : 'Enable daily capture'}</Button>
          <Button variant="ghost" disabled={!connected || !!busy} onClick={() => void act('settle')}>Refresh outcomes</Button>
        </>}
      </div>
      {data?.settings?.enabled && <p className="text-sm text-muted-foreground">Daily capture uses the {data.settings.environment === 'real' ? 'Real' : 'Demo'} feed around 9:52 a.m. ET. Enabling the other feed switches the schedule.</p>}
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {data?.latest && <div className="border-t pt-3 space-y-1">
        <h3 className="font-semibold text-sm">Last capture · {data.latest.session_day}</h3>
        <p className="text-xs text-muted-foreground">{data.latest.summary.scanned} checked · {data.latest.summary.rows} observations{data.latest.summary.unavailable.length > 0 && ` · Missing data for ${data.latest.summary.unavailable.join(', ')}`}</p>
        {data.latest.summary.events.length === 0 ? <p className="text-sm">No qualifying SEC filings were found.</p> :
          data.latest.summary.events.map(event => <p className="text-sm" key={event.accession}>{event.symbol} · {event.kind} · {et.format(new Date(event.at))} ET <a className="text-primary underline" href={event.url} target="_blank" rel="noreferrer">SEC filing</a></p>)}
      </div>}
    </section>
    <section className="surface p-4 lg:p-6 space-y-3">
      <h2 className="font-semibold">Shadow outcomes</h2>
      <p className="text-sm text-muted-foreground">Compares qualified catalysts with qualified same-sector peers without an eligible filing. Lift is measured under higher costs and averaged by session.</p>
      <div className="overflow-x-auto"><table className="w-full min-w-[530px] text-left text-sm">
        <thead><tr>{['Hold', 'Qualified net', 'Skipped net', 'Matched pairs', 'Matched lift'].map(label => <th className="p-2 text-xs text-muted-foreground" key={label}>{label}</th>)}</tr></thead>
        <tbody>{data?.comparisons.map(row => <tr className="border-t" key={row.hold}>
          <td className="p-2">{row.hold} min</td><td>{bps(row.qualifiedBps)} ({row.qualified})</td>
          <td>{bps(row.skippedBps)} ({row.skipped})</td><td>{row.paired} · {row.matchedDays} days</td><td>{bps(row.liftBps)}</td>
        </tr>)}</tbody>
      </table></div>
      {data?.rows.length === 0 && <p className="text-sm">No shadow observations yet for this feed.</p>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Simulation assumptions</summary>
        <p className="mt-2">Entry uses the first complete five-minute quote after at least {CATALYST_COSTS.latencySeconds} seconds of delay. Exits use observed bids and a stop at the opening range low. Assumes {money(CATALYST_COSTS.notionalUsd)} cash exposure, {money(CATALYST_COSTS.feePerSideUsd)} per side and {CATALYST_COSTS.slipBps} bps slippage per side. SEC acceptance time is the earliest information this scanner uses.</p>
      </details>
      <div className="grid gap-3 md:grid-cols-2">
        {ordered.map(row => <article key={row.id} className="rounded-lg border p-3 space-y-2 text-sm">
          <h3 className="font-semibold">{row.symbol} · {row.lane === 'control' ? `Peer for ${row.for_symbol}` : row.decision.status}</h3>
          <p className="text-xs text-muted-foreground">{et.format(new Date(row.observed_at))} ET · {row.sector} benchmark</p>
          <p>{row.decision.reason}</p>
          <p className="text-xs text-muted-foreground">Ask {money(row.quote?.ask)} · Stop {money(row.decision.stop)} · Relative move {bps(row.decision.relativeBps)} · Opening volume {row.decision.relativeVolume == null ? '—' : `${row.decision.relativeVolume.toFixed(1)}×`}</p>
          {row.outcomes ? <dl className="grid grid-cols-3 gap-2">{row.outcomes.map(result => <div key={result.hold}>
            <dt className="text-xs text-muted-foreground">{result.hold} min</dt><dd>{result.state === 'complete' ? money(result.pnlUsd) : result.state === 'unfilled' ? 'Unfilled' : 'Missing data'}</dd>
            <dd className="text-xs text-muted-foreground">{result.reason}</dd>
          </div>)}</dl> : <p className="text-xs text-muted-foreground">Awaiting the scheduled outcome window.</p>}
        </article>)}
      </div>
    </section>
  </div></>;
}
