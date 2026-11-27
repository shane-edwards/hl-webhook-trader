'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import type { StudyCard } from '@/lib/event-studies/journal';
import { stockHref } from '@/components/layout/workspaces';

const percent = (n: number | null) => n == null ? 'Unavailable' : new Intl.NumberFormat(undefined, {
  style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero',
}).format(n);

function Comparison({ card }: { card: StudyCard }) {
  const gaps = card.results.flatMap(row => row.net != null && row.control != null ? [row.net - row.control] : []);
  return <div className="text-xs text-muted-foreground">
    <p>Comparison · {card.comparison}</p>
    {gaps.length > 0 && <p className="mt-1">Average lead · <strong className="text-foreground">{percent(gaps.reduce((a,b) => a+b,0) / gaps.length)}</strong> across {gaps.length} matched {gaps.length === 1 ? 'period' : 'periods'}</p>}
  </div>;
}

export function EventStudies({ market, refresh }: { market: string; refresh: number }) {
  const [studies, setStudies] = useState<StudyCard[]>([]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/forward-tests?test=events', { signal: abort.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!abort.signal.aborted) { setStudies(data.studies); setFailed(false); }
      } catch { if (!abort.signal.aborted) setFailed(true); }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [refresh, retry]);
  const shown = studies.filter(card => market === 'all' || (card.id === 'unlock' ? market === 'crypto' : market === 'stocks'));
  return <section className="surface overflow-hidden" aria-label="Event strategy paper tests">
    <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 sm:px-5">
      <h2 className="font-semibold">Event strategy paper tests</h2>
      {shown.some(card => card.needsConnection) && <Link className="text-sm text-primary underline" href={stockHref('account', { mode: 'demo' })}>Connect eToro Demo</Link>}
    </header>
    {failed && <p className="px-4 pb-3 text-sm" role="alert">Paper results could not be refreshed. <button className="underline" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
    {!failed && !studies.length && <p className="px-4 pb-3 text-sm text-muted-foreground" role="status">Loading paper tests…</p>}
    {shown.map(card => <details key={card.id} className="group border-t">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-accent/40 sm:px-5">
        <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{card.name}</h3>
          <p className="text-xs text-muted-foreground">{card.status}</p></div>
        {card.results.some(row => row.net != null) && <span className="text-xs text-muted-foreground">{card.results.filter(row => row.net != null).length} completed</span>}
        <ChevronRight size={16} aria-hidden className="shrink-0 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-3 px-4 pb-4 sm:px-5">
        <p className="max-w-2xl text-sm">{card.rule}</p>
        <Comparison card={card} />
        {card.sensitivity && <p className="text-sm">{card.sensitivity.label} · <strong>{percent(card.sensitivity.value)}</strong>
          <span className="block text-xs text-muted-foreground">{card.sensitivity.detail}</span></p>}
        {!card.results.length ? <p className="text-sm text-muted-foreground">Awaiting the first result.</p> :
          <ul className="divide-y">{card.results.slice(0,24).map(row => <li key={row.date + row.label} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div><span className="font-medium">{row.label}</span><span className="ml-2 text-xs text-muted-foreground">{row.date}</span>
              {row.note && <p className="text-xs text-muted-foreground">{row.note}</p>}</div>
            <div className="flex flex-wrap gap-3 text-xs tabular-nums"><span>Strategy {percent(row.net)}</span>
              <span>Comparison {percent(row.control)}</span>{row.benchmark !== undefined && <span>Sector {percent(row.benchmark)}</span>}</div>
          </li>)}</ul>}
      </div>
    </details>)}
  </section>;
}
