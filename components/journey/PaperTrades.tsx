'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PaperTrade } from '@/lib/automation/paper-trades';

const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
function result(value: number, unit: PaperTrade['unit']) {
  return (value > 0 ? '+' : '') + (unit === 'usd' ? money.format(value) : (100 * value).toFixed(2) + '%');
}
const time = (at: number) => new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
const price = (n: number) => n.toLocaleString(undefined,{maximumSignificantDigits:7});

function Trade({trade:t}:{trade: PaperTrade}) {
  return <li className="border-t px-4 py-3 sm:px-5">
    <div className="flex items-start justify-between gap-3"><span className="font-semibold">{t.symbol}{t.side && <span className="ml-2 text-xs font-normal capitalize text-muted-foreground">{t.side}</span>}</span>
      <span className={`text-sm font-semibold tabular-nums ${t.net == null || t.net === 0 ? 'text-muted-foreground' : t.net > 0 ? 'text-profit' : 'text-loss'}`}>
        {t.net == null ? (t.closed ? 'P&L pending' : 'Open') : (t.estimated ? '≈ ' : '') + result(t.net,t.unit)}</span></div>
    <div className="text-sm">{t.name}</div>
    <div className="mt-1 text-xs text-muted-foreground">{t.source}{t.portfolios && ` · ${t.portfolios}`}</div>
    <div className="mt-1 text-xs text-muted-foreground">Opened {time(t.entry)}{t.price != null && ` at ${price(t.price)}`}</div>
    {t.exit != null && <div className="text-xs text-muted-foreground">Closed {time(t.exit)}{t.exitPrice != null && ` at ${price(t.exitPrice)}`}</div>}
  </li>;
}

function Results({trades,closed}:{trades:PaperTrade[];closed:boolean}) {
  const sources = [...new Set(trades.map(t => t.source))];
  return <dl className="flex flex-wrap gap-x-6 gap-y-2 px-4 pb-3 sm:px-5">{sources.map(source => {
    const scored = trades.filter(t => t.source === source && t.net != null);
    if (!scored.length) return null;
    const unit = scored[0].unit, total = scored.reduce((n,t) => n + t.net!,0);
    const count = trades.filter(t => t.source === source).length;
    return <div key={source}><dt className="text-xs text-muted-foreground">{source} · {closed ? unit === 'usd' ? 'Realized P&L' : 'Avg. return' : 'Open P&L'}</dt>
      <dd className="font-semibold tabular-nums">{scored.some(t => t.estimated) && '≈ '}{result(unit === 'usd' ? total : total / scored.length,unit)}</dd>
      {scored.length < count && <dd className="text-xs text-muted-foreground">{scored.length} of {count} priced</dd>}</div>;
  })}</dl>;
}

export function PaperTrades({market, refresh}:{market:string; refresh:number}) {
  const [data,setData] = useState<PaperTrade[] | null>(null), [error,setError] = useState(false);
  const [expanded,setExpanded] = useState(false), [closed,setClosed] = useState(false);
  const [limit,setLimit] = useState(15), [retry,setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch('/api/strategies/paper',{cache:'no-store',signal:controller.signal});
        if (!res.ok) throw new Error();
        const rows = await res.json() as PaperTrade[];
        if (!controller.signal.aborted) { setData(rows); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
    }
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); },60_000);
    return () => { clearInterval(timer); controller.abort(); };
  },[refresh,retry]);
  const rows = data?.filter(t => market === 'all' || t.market === market) ?? [];
  const open = rows.filter(t => !t.closed), done = rows.filter(t => t.closed);
  const list = closed ? done : open;
  return <section className="surface overflow-hidden">
    <button aria-expanded={expanded} aria-controls="paper-trades-list" onClick={() => setExpanded(!expanded)} className="flex w-full items-center gap-2 px-4 py-4 text-left sm:px-5">
      <Layers size={18} className="text-primary"/><span className="font-semibold">Paper trades</span>
      <span className="ml-auto text-sm text-muted-foreground">{error ? 'Refresh needed' : data ? `${open.length} open · ${done.length} closed` : 'Loading…'}</span>
      <ChevronDown size={16} className={expanded ? 'rotate-180' : ''}/></button>
    {expanded && <div id="paper-trades-list" className="border-t">
      {error && <div role="alert" className="px-4 py-3 text-sm">Couldn’t refresh paper trades. <button className="underline" onClick={() => setRetry(n=>n+1)}>Retry</button></div>}
      {data && <><div className="flex gap-1 px-3 py-3">{[false,true].map(tab => <Button key={String(tab)} size="sm" variant={closed === tab ? 'secondary' : 'ghost'}
        aria-pressed={closed===tab} onClick={() => {setClosed(tab);setLimit(15);}}>{tab ? `Closed results (${done.length})` : `Open (${open.length})`}</Button>)}</div>
      {list.some(t => t.net != null) && <Results trades={list} closed={closed}/>}
      {list.length ? <ul>{list.slice(0,limit).map(t => <Trade key={t.id} trade={t}/>)}</ul> :
        <p className="px-4 pb-4 text-sm text-muted-foreground">{closed ? 'No closed paper trades yet.' : 'No open paper trades.'}</p>}
      {limit < list.length && <Button className="m-2" variant="ghost" onClick={() => setLimit(n=>n+25)}>Show more</Button>}</>}
    </div>}
  </section>;
}
