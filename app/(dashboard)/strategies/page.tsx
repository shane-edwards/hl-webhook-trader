'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Activity, ArrowRight, ChevronDown, ChevronRight, CircleCheck, FlaskConical, Layers, Radio } from 'lucide-react';
import { CryptoPaperComparison } from '@/components/journey/CryptoPaperComparison';
import { ForwardTest } from '@/components/journey/ForwardTest';
import { FundingBasketTest } from '@/components/journey/FundingBasketTest';
import { EventStudies } from '@/components/journey/EventStudies';
import { PaperMatrix } from '@/components/journey/PaperMatrix';
import { PaperTrades } from '@/components/journey/PaperTrades';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { PaperScore, StrategyRow, Workspace } from '@/lib/automation/strategy-workspace';

const percent = (v: number) => `${(v * 100).toFixed(2)}%`;
const usd = (v: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
const marketName = (m: string) => m === 'stocks' ? 'Stocks' : 'Crypto';
type Controls = Workspace['markets'][number];

function Metrics({ paper }: { paper: PaperScore }) {
  const format = paper.unit === 'usd' ? usd : percent;
  return <dl className="grid grid-cols-3 gap-x-4 text-sm">
    {[[paper.unit === 'usd' ? 'Net paper P&L' : 'Net paper return', format(paper.net)],
      ['Largest drop', format(paper.drawdown)], ['Closed trades', paper.count]].map(([name, val]) =>
      <div key={name}><dt className="text-xs text-muted-foreground">{name}</dt><dd className="mt-1 font-semibold tabular-nums">{val}</dd></div>)}
  </dl>;
}

function StrategyDetail({ row, control, close, reload }: { row: StrategyRow; control: Controls; close: () => void; reload: () => Promise<void> }) {
  const shared = control.active.length > 0;
  const [budget, setBudget] = useState(shared ? String(control.budget ?? '') : '');
  const [order, setOrder] = useState(shared ? String(control.order ?? '') : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  async function submit(e: FormEvent, pause = false) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const change = pause ? { action: 'pause-live' } : { action: 'add-live', existing: control.active, confirmed: true,
        budget: Number(budget), maxOrder: Number(order) };
      const result = await fetch('/api/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...change, market: row.market, version: row.version }) });
      if (!result.ok) throw new Error((await result.json()).error || 'Could not save this change.');
      await reload(); close();
    } catch (err) { setError(err instanceof Error ? err.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  const paperLabel = row.paper ? `${row.paper.count} closed · ${row.paper.source}` : 'Awaiting paper trades';
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{row.name}</DialogTitle><DialogDescription>{row.symbol} · {row.frame} · {marketName(row.market)}</DialogDescription></DialogHeader>
    <ol className="divide-y rounded-lg border px-4">
      {([{ icon: FlaskConical, label: 'Backtest', value: row.backtest }, { icon: Layers, label: 'Paper', value: paperLabel },
        { icon: Radio, label: 'Live', value: row.live }]).map(({icon: Icon, label, value}) => {
        return <li key={label} className="flex items-start gap-3 py-3 text-sm"><Icon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{label}</span><span className="ml-auto text-right text-muted-foreground">{value}</span></li>;
      })}
    </ol>
    {row.paper && <Metrics paper={row.paper} />}
    {row.admission && <span className="text-xs text-muted-foreground">{row.admission}</span>}
    {row.through && <details className="border-t pt-3 text-sm"><summary className="cursor-pointer">Backtest results</summary>
      <div className="mt-2 space-y-1 text-muted-foreground"><p>Through {row.through}</p>
        {row.backtestNet != null && <p>Higher-cost return {percent(row.backtestNet)}</p>}
        {row.backtestTrades != null && <p>{row.backtestTrades} trades on later data</p>}</div></details>}
    {(row.rule || row.version) && <details className="text-sm"><summary className="cursor-pointer">Strategy details</summary>
      <p className="mt-2 break-words text-xs text-muted-foreground">{row.rule ?? row.version}</p></details>}
    {row.stage === 'ready' && (!control.account ? <Button asChild><Link href={row.market === 'stocks' ? '/stocks?tab=account&mode=real' : '/settings'}>Connect live account</Link></Button>
      : shared && (control.paused || control.active.length >= 8) ? <Button asChild variant="outline"><Link href="/automation">Manage live plan</Link></Button>
      : <form className="space-y-3 border-t pt-4" onSubmit={submit}>
        <h3 className="font-semibold">{row.market === 'stocks' ? 'eToro Real' : 'Hyperliquid Live'} · Real money</h3>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">Loss budget per trade ($)<Input type="number" value={budget} readOnly={shared} onChange={e => setBudget(e.target.value)} required min={1} max={10000} step=".01" /></label>
          <label className="text-sm">Maximum order ($)<Input type="number" value={order} readOnly={shared} onChange={e => setOrder(e.target.value)} required min={10} max={10000} step=".01" /></label></div>
        {shared && <p className="text-xs text-muted-foreground">Uses your existing {marketName(row.market).toLowerCase()} limits.</p>}
        <Button disabled={busy} type="submit">Confirm live trading</Button>
      </form>)}
    {row.stage === 'live' && <Button variant="outline" disabled={busy} onClick={e => stopping ? void submit(e,true) : setStopping(true)}>
      {stopping ? 'Confirm pause for this strategy' : 'Pause new entries'}</Button>}
    {row.market === 'stocks' && row.live === 'Requires eToro Demo fills' && <Button asChild variant="outline"><Link href="/stocks?tab=account&mode=demo">Connect eToro Demo</Link></Button>}
    {error && <p role="alert" className="text-sm text-loss">{error}</p>}
  </DialogContent></Dialog>;
}

function Row({ row, open }: { row: StrategyRow; open: () => void }) {
  return <button onClick={open} className="flex w-full flex-wrap items-center justify-between gap-4 px-4 py-4 text-left hover:bg-accent/40 sm:px-5">
    <div className="min-w-0 flex-1"><div className="text-xs text-muted-foreground">{row.symbol} · {row.frame}</div>
      <div className="mt-1 font-semibold">{row.name}</div>
      {row.stage !== 'ready' && <div className="mt-1 text-xs text-muted-foreground">{row.status}</div>}</div>
    {row.stage === 'ready' && row.paper && <Metrics paper={row.paper} />}
    {row.stage === 'ready' ? <span className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">Review for live <ArrowRight size={15} /></span> :
      <ChevronRight aria-label="View results" size={17} className="text-muted-foreground" />}
  </button>;
}

export default function StrategiesPage() {
  const path = usePathname(), router = useRouter(), query = useSearchParams();
  const selected = query.get('strategy'), filter = query.get('market') ?? 'all';
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityLimit, setActivityLimit] = useState(12);
  const [paperRefresh, setPaperRefresh] = useState(0);
  const request = useRef(0);
  function navigate(market: string, id?: string) {
    const params = new URLSearchParams();
    if (market !== 'all') params.set('market', market);
    if (id) params.set('strategy', id);
    router.push(params.size ? `${path}?${params}` : path, { scroll: false });
  }
  const load = useCallback(async () => {
    const ticket = ++request.current;
    setBusy(true);
    try {
      const read = async (method: string) => {
        const res = await fetch('/api/strategies', { method, cache:'no-store' });
        if (!res.ok) throw new Error();
        return await res.json() as Workspace;
      };
      let result = await read('GET');
      if (ticket === request.current && result.markets.some(m => m.needsSetup)) result = await read('POST');
      if (ticket === request.current) { setData(result); setError(''); }
    } catch { if (ticket === request.current) setError('Strategies could not be refreshed.'); }
    finally { if (ticket === request.current) setBusy(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);
  const rows = (data?.rows ?? []).filter(r => filter === 'all' || r.market === filter);
  const detail = data?.rows.find(r => r.id === selected);
  const groups = [{ id: 'ready', label: 'Ready for review', icon: CircleCheck }, { id: 'paper', label: 'Paper trading', icon: Layers },
    { id: 'live', label: 'Live', icon: Radio }] as const;
  const activity = rows.filter(r => r.stage === 'activity');
  const markets = (data?.markets ?? []).filter(m => filter === 'all' || m.market === filter);
  const completed = markets.reduce((sum, m) => sum + m.discovery.completed24h, 0);
  const pending = markets.reduce((sum, m) => sum + m.discovery.pending, 0);
  const last = markets.map(m => m.discovery.lastCompleted).filter((t): t is string => !!t).sort().at(-1);
  const rankedActivity = [...activity].sort((a,b) => priority(a) - priority(b));
  function priority(r: StrategyRow) { return r.status === 'Backtesting' ? 0 : r.status === 'Backtest queued' ? 1 : r.paper ? 2 : r.through ? 3 : 4; }
  return <><Header onRefresh={() => { void load(); setPaperRefresh(n => n + 1); }} refreshing={busy} /><div className="mx-auto max-w-5xl space-y-5 px-4 py-5 lg:px-8 lg:py-8">
    <div className="inline-flex rounded-lg border bg-card p-1" aria-label="Market">{['all','stocks','crypto'].map(m =>
      <Button key={m} size="sm" variant={filter === m ? 'secondary' : 'ghost'} aria-pressed={filter === m} onClick={() => navigate(m)}>{m === 'all' ? 'All markets' : marketName(m)}</Button>)}</div>
    {filter !== 'stocks' && <PaperMatrix refresh={paperRefresh} />}
    {filter !== 'stocks' && <ForwardTest refresh={paperRefresh} />}
    {filter !== 'stocks' && <FundingBasketTest refresh={paperRefresh} />}
    <EventStudies market={filter} refresh={paperRefresh} />
    <PaperTrades market={filter} refresh={paperRefresh} />
    {error && <p role="alert">{error} <button className="underline" onClick={() => void load()}>Retry</button></p>}
    {!data && !error && <p role="status">Loading strategies…</p>}
    {data && <>
      {data.markets.filter(m => (filter === 'all' || m.market === filter) && (!m.connected || !m.enabled)).map(m =>
        <Link key={m.market} href={!m.connected ? '/stocks?tab=account' : '/automation'} className="block text-sm text-primary">
          {!m.connected ? 'Connect stock market data' : `${marketName(m.market)} research paused · Manage`}</Link>)}
      {groups.map(({id,label,icon: Icon}) => {
        const list = rows.filter(r => r.stage === id);
        if (!list.length) return null;
        return <section key={id} className="surface overflow-hidden"><h2 className="flex items-center gap-2 border-b px-4 py-3 font-semibold sm:px-5">
          <Icon className="text-primary" size={18} />{label}<span className="ml-auto text-sm text-muted-foreground">{list.length}</span></h2>
          <div className="divide-y">{list.map(row => <Row key={row.id} row={row} open={() => navigate(filter,row.id)} />)}</div></section>;
      })}
      <section className="surface p-5">
        <h2 className="font-semibold">Strategy discovery</h2>
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[[completed, 'Searches · 24h'], [rows.filter(r => r.stage === 'paper').length, 'Paper strategies'], [rows.filter(r => r.stage === 'ready').length, 'Ready for live']].map(([value, label]) =>
            <div key={label}><div className="text-lg font-semibold tabular-nums">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>)}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{pending > 0 ? `${pending} backtest${pending === 1 ? '' : 's'} queued or running` :
          last ? `Last search ${new Date(last).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'})}` : 'No completed searches in the past 24h'}</p>
        {rows.every(r => r.stage === 'activity') && completed > 0 && <p className="mt-1 text-sm text-muted-foreground">Waiting for a qualifying backtest.</p>}
        <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary" href="#backtest-activity" onClick={() => setActivityOpen(true)}>View backtests <ArrowRight size={15} /></a>
      </section>
      {filter !== 'stocks' && <CryptoPaperComparison result={data.comparison} paused={!!data.markets.find(m => m.market === 'crypto')?.paused} />}
      <section id="backtest-activity" className="surface overflow-hidden"><button aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}
        className="flex w-full items-center gap-2 px-4 py-4 text-sm font-semibold"><Activity size={17} />Activity
        <ChevronDown size={16} className={`ml-auto ${activityOpen ? 'rotate-180' : ''}`} /></button>
        {activityOpen && <div className="divide-y border-t">{rankedActivity.slice(0,activityLimit).map(row =>
          <Row key={row.id} row={row} open={() => navigate(filter,row.id)} />)}
          {activity.length > activityLimit && <Button variant="ghost" className="m-2" onClick={() => setActivityLimit(activityLimit + 25)}>Show more</Button>}
          {!activity.length && <p className="p-4 text-sm text-muted-foreground">No recent backtests</p>}
          <div className="flex gap-4 px-4 py-3 text-sm text-primary">
            {filter !== 'crypto' && <Link href="/journey/find?market=stocks&asset=AAPL&frame=1d#asset-research">Stock research</Link>}
            {filter !== 'stocks' && <Link href="/journey/find?market=crypto&asset=BTC&frame=1h#asset-research">Crypto research</Link>}
          </div></div>}</section>
    </>}
    {detail && data && <StrategyDetail key={detail.id} row={detail} control={data.markets.find(m => m.market === detail.market)!}
      close={() => navigate(filter)} reload={load} />}
    {data && selected && !detail && <p role="status">This strategy is no longer available. <button className="underline" onClick={() => navigate(filter)}>Show strategies</button></p>}
  </div></>;
}
