'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { journeyHref } from '@/components/layout/journey';
import { stockHref } from '@/components/layout/workspaces';
import type { SearchMarket } from '@/lib/strategy-search/model';
import type { MarketResearch, MarketSetup } from '@/lib/strategy-search/recommendations';
import { frameNames } from './StrategySearch';

function ResultRow({ setup }: { setup: MarketSetup }) {
  const { market, symbol, frame } = setup.pair;
  const details = setup.ideaId ? journeyHref('test', market, setup.ideaId) :
    `/journey/find?${new URLSearchParams({ market, asset: symbol, frame })}#asset-research`;
  return <li className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{symbol} · {frameNames[frame]} · {setup.side === 'short' ? 'Short' : 'Long'}</p>
      <h3 className="font-semibold tracking-tight">{setup.name}</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-medium text-profit">+{(setup.stressedReturn * 100).toFixed(2)}%</span> at higher costs
        {' · '}{setup.trades} later trades
        {setup.kind === 'research' && ' · Research candidate'}
      </p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild size="sm" variant="outline"><Link href={details}>View results</Link></Button>
      {setup.kind === 'trade' && setup.ideaId && <Button asChild size="sm">
        <Link href={journeyHref('trade', market, setup.ideaId)}>Trade setup <ArrowRight size={15} /></Link>
      </Button>}
    </div>
  </li>;
}

export function MarketRecommendations({ market }: { market: SearchMarket }) {
  const [loaded, setLoaded] = useState<{ market: SearchMarket; data: MarketResearch }>();
  const [error, setError] = useState<SearchMarket>();
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const response = await fetch(`/api/strategy-search?${new URLSearchParams({ market })}`,
          { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error();
        let data: MarketResearch = await response.json();
        if (data.needsSetup) {
          const started = await fetch('/api/strategy-search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ market }), signal: controller.signal });
          if (!started.ok) throw new Error();
          data = await started.json();
        }
        if (!controller.signal.aborted) { setLoaded({ market, data }); setError(undefined); }
      } catch {
        if (!controller.signal.aborted) setError(market);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 25_000);
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [market]);

  const data = loaded?.market === market ? loaded.data : null;
  const coverage = data?.coverage;
  const note = error === market ? 'Research temporarily unavailable · retrying' : !data ? 'Checking the market scan…' :
    !data.connected ? 'Connect eToro to scan stocks' : data.paused ? 'Automatic research paused' :
      data.setups.length ? null : 'No qualifying strategies yet';
  return <section aria-labelledby="market-recommendations" className="surface overflow-hidden">
    <div className="space-y-2 px-4 py-4 sm:px-5">
      <h2 id="market-recommendations" className="text-lg font-semibold tracking-tight">Recommended strategies</h2>
      {coverage && <p className="text-xs text-muted-foreground">
        {coverage.symbols} assets · {coverage.timeframes} timeframes · {coverage.scanned}/{coverage.total} combinations tested
        {coverage.queued > 0 && ` · ${coverage.queued} in progress`}
        {coverage.limited > 0 && ` · ${coverage.limited} awaiting data`}
      </p>}
      {note && <p role="status" className="text-sm font-medium">{note}</p>}
      {data && !data.connected && <Button asChild size="sm" variant="outline"><Link href={stockHref('account')}>Connect eToro</Link></Button>}
      {data?.paused && <Button asChild size="sm" variant="outline"><Link href="/automation">Research settings</Link></Button>}
    </div>
    {!!data?.setups.length && <ul className="divide-y border-t">
      {data.setups.map(setup => <ResultRow key={setup.id} setup={setup} />)}
    </ul>}
  </section>;
}
