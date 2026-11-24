'use client';

import { useCallback, useEffect, useState } from 'react';
import { notFound, useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight, CandlestickChart, FlaskConical, Landmark, Loader2 } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { journeyHref, JOURNEY_STEPS } from '@/components/layout/journey';
import { stockHref } from '@/components/layout/workspaces';
import { TradeActions } from '@/components/journey/TradeActions';
import { FullAutopilot } from '@/components/journey/FullAutopilot';
import { frameNames, StrategySearch } from '@/components/journey/StrategySearch';
import { Button } from '@/components/ui/button';
import { IDEA_RULES, findIdea, ideaId, type StrategyIdea } from '@/lib/automation/ideas';
import type { AutomationMarket, AutomationProfile, Evidence } from '@/lib/automation/model';
import type { PaperResults } from '@/lib/automation/policy';
import type { StockEnvironment } from '@/components/stocks/StockOrderTicket';
import { stockSizingQuery } from '@/lib/stocks/leverage';
import { SEARCH_ASSETS, SEARCH_FRAMES, searchPair, type SearchFrame } from '@/lib/strategy-search/model';
import { cn } from '@/lib/utils';

type IdeaResult = { evidence: Evidence; asOf: string };
type IdeaWork = { status: string; detail: string | null };
type Journey = {
  results: Record<string, IdeaResult>;
  work: Record<string, IdeaWork>;
  profiles: AutomationProfile[];
  ready: Evidence | null;
  paper: PaperResults | null;
  connections: StockEnvironment[];
  hasWallet: boolean;
  isTestnet: boolean;
  observedAt: number;
  live: { version: string; name: string; symbol: string }[];
};

const selectClass = 'w-full h-10 mt-1 rounded-md border bg-background pl-2 pr-1 text-sm';
const percentage = (value: number) => `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
const cleanDate = (date: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date));

function status(evidence: Evidence | undefined, work?: IdeaWork) {
  if (work?.status === 'queued') return 'Queued';
  if (work?.status === 'running') return 'Testing';
  if (work?.status === 'failed') return 'Run failed';
  if (!evidence) return 'Ready to test';
  if (evidence.qualified) return 'Passed backtest';
  if (evidence.trades < 24 || evidence.holdoutTrades < 8) return 'Needs more trades';
  return 'Did not pass';
}

function IdeaCard({ item, data }: { item: (typeof IDEA_RULES)[number]; data: Journey | null }) {
  const ranked = item.symbols.map(symbol => {
    const id = ideaId(item.market, item.rule, symbol);
    const result = data?.results[id]?.evidence;
    return { symbol, result, id };
  }).sort((a, b) => Number(!!b.result?.qualified) - Number(!!a.result?.qualified) ||
    (b.result?.holdoutTrades ?? -1) - (a.result?.holdoutTrades ?? -1));
  const [picked, setPicked] = useState<string>();
  const displayed = ranked.find(row => row.symbol === picked) ?? ranked[0];
  return <article className="surface min-w-0 p-4 sm:p-5 flex flex-col gap-4">
    <div className="space-y-2">
      <div className="flex flex-wrap justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{item.timeframe}</span>
        <span className={cn(displayed.result?.qualified && 'text-profit')}>{status(displayed.result, data?.work[displayed.id])}</span>
      </div>
      <h2 className="font-semibold tracking-tight">{item.name}</h2>
    </div>
    <div className="flex flex-wrap items-center gap-2 mt-auto">
      <select aria-label={`Asset for ${item.name}`} className="h-9 px-2 rounded-md border bg-background text-sm" value={displayed.symbol}
        onChange={event => setPicked(event.target.value)}>{item.symbols.map(symbol => <option key={symbol}>{symbol}</option>)}</select>
      <Button size="sm" variant="outline" asChild className="ml-auto">
        <Link href={journeyHref('test', item.market, displayed.id)} aria-label={`Test ${item.name} on ${displayed.symbol}`}>Test <ArrowRight size={15} /></Link>
      </Button>
    </div>
  </article>;
}

function EvidencePanel({ evidence, idea }: { evidence: Evidence; idea: StrategyIdea }) {
  const metrics = [
    ['Return on later data', percentage(evidence.later)], ['Return with higher costs', percentage(evidence.stress)],
    ['Trades on later data', String(evidence.holdoutTrades)], ['Largest drop', `${(evidence.drawdown * 100).toFixed(2)}%`],
  ];
  return <div className="space-y-3">
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {metrics.map(([label, value]) => <div key={label} className="rounded-lg border p-3">
        <div className="text-xs text-muted-foreground">{label}</div><div className="font-semibold tabular-nums mt-1">{value}</div>
      </div>)}
    </div>
    <details className="border-t pt-3 text-sm">
      <summary className="cursor-pointer font-medium">Backtest details</summary>
      <div className="grid gap-1 mt-2 text-xs text-muted-foreground">
        <span>{cleanDate(evidence.from)} – {cleanDate(evidence.through)} · {idea.market === 'stocks' ? 'eToro bid/ask history' : 'Hyperliquid candles and funding'}</span>
        <span>Earlier-period return {percentage(evidence.early)} · Benchmark return {percentage(evidence.benchmark)} · {evidence.trades} total trades</span>
        <span>{evidence.reason}</span>
        {idea.source && <a href={idea.source} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary">Source study <ArrowUpRight size={12} /></a>}
      </div>
    </details>
  </div>;
}

function ideaFrame(idea: (typeof IDEA_RULES)[number]): SearchFrame {
  if (idea.market === 'crypto') return idea.rule === 'trend_breakout' ? '4h' : '1h';
  if (idea.executable) return '1d';
  return idea.rule === 'close' || idea.rule === 'close-volume' ? '30m' : '5m';
}

export default function JourneyPage() {
  const { step: rawStep } = useParams<{ step: string }>();
  const step = JOURNEY_STEPS.find(value => value === rawStep);
  const query = useSearchParams();
  const router = useRouter();
  const requested = findIdea(query.get('idea'));
  const market: AutomationMarket = requested?.market ?? (query.get('market') === 'crypto' ? 'crypto' : 'stocks');
  const rules = IDEA_RULES.filter(item => item.market === market);
  const fallback = (step === 'trade' ? rules.find(item => item.executable) : rules[0])!;
  const idea = requested ?? findIdea(ideaId(market, fallback.rule, fallback.symbols[0]))!;
  const selectedId = step === 'find' ? undefined : String(idea.id);
  const [loaded, setLoaded] = useState<{ data: Journey; idea?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(selectedId ? `/api/journey?${new URLSearchParams({ idea: selectedId })}` : '/api/journey', { signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not load strategies.');
    if (!signal?.aborted) setLoaded({ data, idea: selectedId });
  }, [selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void load(controller.signal).catch(problem => {
      if (!controller.signal.aborted) setError(problem.message);
    });
    refresh();
    const interval = setInterval(refresh, 15_000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [load]);

  if (!step) notFound();
  const data = loaded?.data ?? null;
  const current = loaded && loaded.idea === selectedId ? loaded.data : null;
  const work = data?.work[idea.id];
  const evidence = data?.results[idea.id]?.evidence;
  const testing = work?.status === 'queued' || work?.status === 'running';
  const needsFeed = market === 'stocks' && !!current && current.connections.length === 0;
  const profile = current?.profiles.find(item => item.market === market);
  const stockMode = query.get('mode');
  const baseAsset = query.get('asset') ?? requested?.symbol ?? SEARCH_ASSETS[market][0];
  const baseFrame = query.get('frame') ?? (market === 'crypto' ? '1h' : '1d');
  const findPair = searchPair(market, baseAsset, baseFrame) ?? searchPair(market, SEARCH_ASSETS[market][0], market === 'crypto' ? '1h' : '1d')!;
  const matching = rules.filter(item => item.symbols.includes(findPair.symbol) && ideaFrame(item) === findPair.frame);
  const readyIdeas = matching.flatMap(item => {
    const id = ideaId(market, item.rule, findPair.symbol);
    const row = data?.results[id];
    return item.executable && data && row?.evidence.qualified && Date.parse(row.asOf) > data.observedAt - 4 * 86_400_000 ? [{ id, row }] : [];
  }).sort((a, b) => b.row.evidence.stress - a.row.evidence.stress);
  const recommend = readyIdeas[0];

  function changeSearch(field: 'asset' | 'frame', value: string) {
    const next = new URLSearchParams(window.location.search);
    next.set('market', market);
    if (!next.has('asset')) next.set('asset', findPair.symbol);
    if (!next.has('frame')) next.set('frame', findPair.frame);
    next.delete('idea');
    next.set(field, value);
    window.history.replaceState(null, '', `/journey/find?${next}`);
  }
  function changeIdea(rule: string, symbol: string) {
    setError(''); setNotice('');
    router.push(journeyHref(step!, market, ideaId(market, rule, symbol)));
  }

  async function runTest() {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch('/api/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', market, idea: idea.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setNotice(result.message);
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not start the backtest.'); }
    finally { setBusy(false); }
  }

  return <><Header />
    <div className="mx-auto max-w-6xl px-4 py-5 lg:px-8 lg:py-7 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Market" className="inline-flex gap-1 rounded-lg border bg-card p-1">
          {([{ id: 'stocks', label: 'Stocks', icon: Landmark }, { id: 'crypto', label: 'Crypto', icon: CandlestickChart }] as const).map(({ id, label, icon: Icon }) =>
            <Link key={id} href={journeyHref(step, id)} aria-current={market === id ? 'page' : undefined}
              className={cn('flex min-h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium', market === id ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:bg-accent')}>
              <Icon size={15} />{label}
            </Link>)}
        </nav>
        {step === 'find' && <Button asChild size="sm" variant="ghost"><Link href={market === 'stocks' ? '/stocks' : '/markets'}>{market === 'stocks' ? 'Strong Buys' : 'Market scanner'} <ArrowUpRight size={14} /></Link></Button>}
        {step === 'test' && <Button asChild size="sm" variant="ghost"><Link href="/automation">Scheduled tests <ArrowUpRight size={14} /></Link></Button>}
        {step === 'trade' && <Button asChild size="sm" variant="ghost"><Link href={market === 'stocks' ? stockHref('trade') : '/dashboard'}>Standalone ticket <ArrowUpRight size={14} /></Link></Button>}
      </div>
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {step === 'find' ? <>
        <section className="surface p-4 grid grid-cols-2 gap-3 sm:max-w-xl">
          <label className="block text-xs font-medium">Asset<select aria-label="Asset" className={selectClass} value={findPair.symbol}
            onChange={event => changeSearch('asset', event.target.value)}>{SEARCH_ASSETS[market].map(symbol => <option key={symbol}>{symbol}</option>)}</select></label>
          <label className="block text-xs font-medium">Timeframe<select aria-label="Timeframe" className={selectClass} value={findPair.frame}
            onChange={event => changeSearch('frame', event.target.value)}>{SEARCH_FRAMES[market].map(frame => <option key={frame} value={frame}>{frameNames[frame]}</option>)}</select></label>
        </section>
        {recommend && <section className="surface p-4 sm:p-5 flex flex-wrap justify-between items-center gap-3">
          <div><h2 className="font-semibold">{recommend.row.evidence.name}</h2><p className="mt-1 text-xs text-profit">Passed backtest</p></div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm"><Link href={journeyHref('test', market, recommend.id)}>See test</Link></Button>
            <Button asChild size="sm"><Link href={journeyHref('trade', market, recommend.id)}>Trade setup</Link></Button>
          </div>
        </section>}
        <StrategySearch market={market} symbol={findPair.symbol} frame={findPair.frame} />
        {!!matching.length && <details className="surface p-4">
          <summary className="cursor-pointer text-sm font-medium">Other tested ideas</summary>
          <div className="grid gap-3 mt-3 sm:grid-cols-2 xl:grid-cols-3">
            {matching.map(item => <IdeaCard key={item.rule} item={{ ...item, symbols: [findPair.symbol] }} data={data} />)}
          </div>
        </details>}
        <Button asChild variant="ghost" size="sm"><Link href={journeyHref('trade', market) + '#autopilot'}>Full Autopilot <ArrowRight size={15} /></Link></Button>
      </> : <div className="grid gap-4 lg:grid-cols-[minmax(225px,1fr)_minmax(0,3fr)]">
        <section className="surface min-w-0 p-4 self-start space-y-3">
          <label className="block text-xs font-medium">Strategy<select className={selectClass} value={idea.rule} onChange={event => {
            const row = rules.find(item => item.rule === event.target.value)!;
            changeIdea(row.rule, row.symbols.includes(idea.symbol) ? idea.symbol : row.symbols[0]);
          }}>{rules.filter(item => step === 'test' || item.executable || item.rule === idea.rule).map(item =>
            <option key={item.rule} value={item.rule}>{item.name}</option>)}</select></label>
          <label className="block text-xs font-medium">Asset<select className={selectClass} value={idea.symbol}
            onChange={event => changeIdea(idea.rule, event.target.value)}>{idea.symbols.map(symbol => <option key={symbol}>{symbol}</option>)}</select></label>
          <div className="flex justify-between gap-2 text-xs text-muted-foreground"><span>{idea.timeframe}</span><span>{idea.market === 'stocks' ? 'eToro' : 'Hyperliquid'}</span></div>
        </section>
        {step === 'test' ? <section className="surface min-w-0 p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">{idea.symbol} · {idea.name}</h2>
              <p role="status" className={cn('mt-1 text-xs text-muted-foreground', current?.ready && 'text-profit')}>{status(evidence, work)}</p>
            </div>
            {needsFeed ? <Button asChild size="sm"><Link href={stockHref('account', { mode: 'real', returnTo: 'journey-test', idea: idea.id })}>Connect eToro</Link></Button>
              : <Button size="sm" disabled={busy || testing || !current} onClick={() => void runTest()}>
                {testing || busy ? <Loader2 className="animate-spin" size={15} /> : <FlaskConical size={15} />}{testing ? 'In progress' : evidence ? 'Run again' : 'Run backtest'}
              </Button>}
          </div>
          {work?.status === 'failed' && work.detail && <p role="status" className="text-sm text-loss">{work.detail}</p>}
          {evidence && <EvidencePanel evidence={evidence} idea={idea} />}
          {idea.executable && evidence && <Button asChild variant={current?.ready ? 'default' : 'outline'}><Link href={journeyHref('trade', market, idea.id)}>
            {current?.ready ? 'Continue to Trade' : 'Open manual trade'} <ArrowRight size={16} />
          </Link></Button>}
          {!idea.executable && <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>Research only</span>
            {idea.source && !evidence && <a className="text-primary hover:underline" href={idea.source} target="_blank" rel="noreferrer">Source study</a>}
          </div>}
        </section> : <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap justify-between items-center gap-3 px-0.5">
            <h2 className="font-semibold">{idea.symbol} · {idea.name}</h2>
            <Link href={journeyHref('test', market, idea.id)} className="text-xs text-primary hover:underline">{current?.ready ? 'Passed backtest' : 'Backtest results'}</Link>
          </div>
          {current ? <TradeActions key={`${idea.id}:${query.get('method')}:${stockMode}`} idea={idea}
            state={{ ...current, profile }} refresh={load} initialMethod={query.get('method') === 'automated' ? 'automated' : 'manual'}
            initialEnvironment={stockMode === 'real' ? 'real' : undefined} initialSizing={stockSizingQuery(query).data} />
            : <div role="status" className="surface p-4 text-sm text-muted-foreground">Loading trade controls…</div>}
          <StrategySearch market={market} symbol={idea.symbol} frame={ideaFrame(idea)} compact />
          {current && <FullAutopilot key={market} market={market} profile={profile} demo={current.connections.includes('demo')}
            real={market === 'stocks' ? current.connections.includes('real') : current.hasWallet && !current.isTestnet} live={current.live ?? []} refresh={load} />}
        </div>}
      </div>}
    </div>
  </>;
}
