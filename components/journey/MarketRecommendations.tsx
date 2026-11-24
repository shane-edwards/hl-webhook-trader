'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { journeyHref } from '@/components/layout/journey';
import { stockHref } from '@/components/layout/workspaces';
import { paperTradingStatus, type SearchMarket } from '@/lib/strategy-search/model';
import type { MarketResearch, MarketSetup } from '@/lib/strategy-search/recommendations';
import { frameNames } from './StrategySearch';

const percent = (value: number, signed = false) =>
  `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

function resultsHref(setup: MarketSetup) {
  const { market, symbol, frame } = setup.pair;
  if (setup.ideaId) return journeyHref('test', market, setup.ideaId);
  const query = new URLSearchParams({ market, asset: symbol, frame });
  if (setup.ruleKey) query.set('rule', setup.ruleKey);
  return `/journey/find?${query}#asset-research`;
}

function SetupMetrics({ setup }: { setup: MarketSetup }) {
  return <dl className="grid grid-cols-3 gap-2 tabular-nums">
    {[
      ['Return at higher costs', percent(setup.stressedReturn, true)],
      ['Max drawdown', percent(setup.drawdown)],
      ['Test trades', String(setup.trades)],
    ].map(([label, value], index) => <div key={label}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 font-semibold ${index === 0 ? 'text-profit' : ''}`}>{value}</dd>
    </div>)}
  </dl>;
}

function StrategyCard({ setup, paused, leading = false }: { setup: MarketSetup; paused: boolean; leading?: boolean }) {
  const trialState = setup.trial?.complete ? 'completed' : paused ? 'paused' : 'tracking';
  return <div className={leading ? 'space-y-4 border-l-2 border-primary pl-4' : 'space-y-3 py-4'}>
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{setup.pair.symbol} · {frameNames[setup.pair.frame]} · {setup.side === 'short' ? 'Short' : 'Long'}</p>
      <h3 className={leading ? 'text-xl font-semibold tracking-tight' : 'font-semibold'}>{setup.name}</h3>
      <p className="mt-1 text-xs font-medium">{paperTradingStatus(setup.trial?.count ?? setup.paperCloses,
        trialState, setup.paperCloses === 30)}</p>
    </div>
    <SetupMetrics setup={setup} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">Backtest through {setup.through}</span>
      <Button asChild size="sm" variant={leading ? 'default' : 'outline'}>
        <Link href={resultsHref(setup)}>View strategy <ArrowRight size={14} /></Link>
      </Button>
    </div>
  </div>;
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
  const leader = data?.setups[0];
  const others = data?.setups.slice(1) ?? [];
  const note = error === market ? (data ? 'Refresh failed · Showing last results' : 'Research unavailable · Retrying') :
    !data ? 'Checking strategies…' : !data.connected ? 'Connect eToro to update stock research' :
    data.paused ? 'Automatic research paused' : null;

  return <section aria-labelledby="market-recommendations" className="surface space-y-4 p-4 sm:p-5">
    <h2 id="market-recommendations" className="text-lg font-semibold tracking-tight">
      {leader ? `Top ${market === 'stocks' ? 'stock' : 'crypto'} strategy by backtest` : 'Recommended strategies'}
    </h2>
    {note && <p role="status" className="text-sm text-muted-foreground">{note}</p>}
    {data && !data.connected && <Button asChild size="sm" variant="outline"><Link href={stockHref('account')}>Connect eToro</Link></Button>}
    {data?.paused && <Button asChild size="sm" variant="outline"><Link href="/automation">Research settings</Link></Button>}
    {data && leader && <StrategyCard setup={leader} paused={data.paused || !data.connected} leading />}
    {data && !leader && <div className="space-y-2">
      <p className="font-medium">{coverage?.scanned ? 'No strategy qualifies yet' : 'Waiting for qualifying results'}</p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Historical study results</summary>
        <div className="mt-2 space-y-1">
          <p>{market === 'stocks' ? 'Two-range selloff → bullish outside bar' : 'Retracement in a rising trend → accelerating two-bar advance'}</p>
          <p className="text-xs text-muted-foreground">{market === 'stocks'
            ? '+1.15% cumulative at higher costs · Passed in all 3 baskets · Jan 2022–Oct 2026'
            : '+12.91% cumulative at higher costs · Positive in 3 of 4 baskets · Jan 2025–Oct 2026'}</p>
          <a className="inline-flex items-center gap-1 text-primary hover:underline"
            href="https://github.com/shane-edwards/hl-webhook-trader/blob/69a39da/backtest/GENERATED-STRATEGIES.md#twenty-historically-profitable-trade-ideas"
            target="_blank" rel="noreferrer">View study <ArrowRight size={14} /></a>
        </div>
      </details>
    </div>}
    {others.length > 0 && <details key={market} className="border-t pt-3">
      <summary className="cursor-pointer text-sm font-medium">Compare {others.length} other {others.length === 1 ? 'strategy' : 'strategies'}</summary>
      <ol className="mt-2 divide-y">{others.map(setup => <li key={setup.id}><StrategyCard setup={setup} paused={!!data?.paused || !data?.connected} /></li>)}</ol>
    </details>}
    {coverage && <details className="border-t pt-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer">Scan details · {coverage.scanned}/{coverage.total} combinations tested</summary>
      <div className="mt-2 space-y-1">
        <p>{coverage.symbols} assets · {coverage.timeframes} timeframes · {coverage.queued} in progress · {coverage.limited} awaiting data</p>
        {leader && <p>Rank favors higher returns above the benchmark after costs, smaller drawdowns and more test trades. The leading strategy’s benchmark returned {percent(leader.benchmark, true)}.</p>}
      </div>
    </details>}
  </section>;
}
