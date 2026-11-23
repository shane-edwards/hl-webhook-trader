'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/segmented';
import { ChevronDown, Lightbulb, RefreshCw } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import { LevelsChart, type ChartCandle, type ChartLine } from '@/components/charts/LevelsChart';
import type { Suggestion } from '@/lib/suggestions';

type Row = (Suggestion & { volume24hUsd?: number }) | { symbol: string; error: string };
type Scope = 'watched' | 'market';

interface Props {
  /** Open the trade ticket on this market and side. */
  onTrade: (symbol: string, side: 'long' | 'short') => void;
}

const BIAS_BADGE = { long: 'profit', short: 'loss', neutral: 'secondary' } as const;
const MARKET_PAGE = 12;

/** Candles and lines for one expanded idea. Loaded only when the row is opened. */
function IdeaChart({ idea }: { idea: Suggestion }) {
  const [candles, setCandles] = useState<ChartCandle[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/candles?symbol=${encodeURIComponent(idea.symbol)}&hours=120`)
      .then(r => (r.ok ? r.json() : null)).then(d => { if (live) setCandles(d?.candles ?? []); }).catch(() => { if (live) setCandles([]); });
    return () => { live = false; };
  }, [idea.symbol]);

  if (candles === null) return <Skeleton className="h-[180px] w-full rounded-lg" />;
  if (!candles.length) return null;
  const lv = idea.bias === 'short' ? idea.short : idea.long;
  const lines: ChartLine[] = [
    ...idea.supports.map(l => ({ kind: 'support' as const, label: 'Support', price: l.price })),
    ...idea.resistances.map(l => ({ kind: 'resistance' as const, label: 'Resist.', price: l.price })),
    { kind: 'entry', label: 'Price', price: idea.price },
    ...(idea.bias !== 'neutral' ? [
      { kind: 'stop' as const, label: 'Stop', price: lv.stopPrice },
      { kind: 'target' as const, label: 'Target', price: lv.targetPrice },
    ] : []),
  ];
  return <LevelsChart candles={candles} lines={lines} height={180} className="rounded-lg border border-border bg-secondary/30 px-2 py-1.5" />;
}

export function TradeIdeas({ onTrade }: Props) {
  const [scope, setScope] = useState<Scope>('watched');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [marketNote, setMarketNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // The watched list is slow (it downloads candles) and the market list is fast (cached), so a
  // reply can arrive after the user has switched tabs. Only the latest request may update the list.
  const latest = useRef(0);
  const load = useCallback(async (which: Scope) => {
    const request = ++latest.current;
    setLoading(true);
    try {
      const res = await fetch(which === 'market' ? '/api/suggestions?scope=market' : '/api/suggestions');
      const data = await res.json();
      if (request !== latest.current) return;
      setRows(res.ok ? data.suggestions : []);
      setMarketNote(which !== 'market' ? null
        : data.available === false ? 'The whole-market scan needs database migration 006.'
        : !data.suggestions?.length ? 'The market scan has not filled its list yet. It works through the liquid markets a few at a time, every five minutes.'
        : data.oldest ? `Markets over $5M daily volume. Refreshed in rotation; oldest read is from ${new Date(data.oldest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : null);
    } catch {
      if (request === latest.current) setRows([]);
    } finally {
      if (request === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setRows(null); setExpanded(null); setShowAll(false);
    load(scope);
    const id = setInterval(() => load(scope), 5 * 60_000);
    return () => clearInterval(id);
  }, [load, scope]);

  // The whole market is long: lead with the markets that have a read, and keep the rest behind a button.
  const withRead = rows?.filter(r => !('error' in r) && r.bias !== 'neutral') ?? [];
  const shown = scope === 'market' && !showAll ? withRead.slice(0, MARKET_PAGE) : rows ?? [];
  const hidden = (rows?.length ?? 0) - shown.length;

  return (
    <section className="surface" aria-label="Trade ideas">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Trade ideas</h2>
        </div>
        <div className="flex items-center gap-2">
          <Segmented aria-label="Which markets" value={scope} onChange={setScope} options={[{ value: 'watched', label: 'Watched' }, { value: 'market', label: 'Whole market' }]} />
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => load(scope)} disabled={loading} aria-label="Refresh trade ideas">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>
      <p className="px-5 pb-3 -mt-1 text-xs text-muted-foreground">
        What the tested rules read right now. Not a forecast. {marketNote}
      </p>

      {rows === null ? (
        <div className="px-5 pb-5 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-muted-foreground">{scope === 'market' ? 'Nothing to show yet.' : 'Could not load suggestions right now.'}</p>
      ) : (
        <>
          {scope === 'market' && !showAll && withRead.length === 0 && (
            <p className="px-5 pb-4 text-sm text-muted-foreground">No market has a long or short read right now ({rows.length} scanned).</p>
          )}
          <ul className="divide-y divide-border/70 border-t border-border/70">
            {shown.map(r => {
              if ('error' in r) return <li key={r.symbol} className="px-5 py-3 text-sm text-muted-foreground"><span className="font-medium text-foreground mr-2">{r.symbol}</span>{r.error}</li>;
              const lv = r.bias === 'short' ? r.short : r.long;
              const isOpen = expanded === r.symbol;
              return (
                <li key={r.symbol}>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                    <button type="button" onClick={() => setExpanded(isOpen ? null : r.symbol)} aria-expanded={isOpen} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                      <div className="w-16 shrink-0">
                        <p className="text-sm font-semibold">{r.symbol}</p>
                        <p className="num text-[11px] text-muted-foreground">${formatPrice(r.price)}</p>
                      </div>
                      <Badge variant={BIAS_BADGE[r.bias]} className="shrink-0 uppercase">{r.bias === 'neutral' ? 'No trade' : `${r.strength} ${r.bias}`}</Badge>
                      <span className="text-xs text-muted-foreground truncate hidden md:block">{r.summary}</span>
                      <ChevronDown className={cn('w-4 h-4 text-muted-foreground shrink-0 ml-auto transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {r.bias !== 'neutral' && (
                      <div className="flex items-center gap-3 shrink-0">
                        <p className="num text-[11px] text-muted-foreground text-right leading-tight">
                          stop {lv.stopLossPct}%<br />target {lv.takeProfitPct}%
                        </p>
                        <Button size="sm" variant={r.bias === 'long' ? 'profit' : 'loss'} onClick={() => onTrade(r.symbol, r.bias as 'long' | 'short')}>
                          {r.bias === 'long' ? 'Review long' : 'Review short'}
                        </Button>
                      </div>
                    )}
                  </div>
                  {isOpen && (
                    <div className="px-5 pb-4 space-y-2">
                      <p className="text-xs text-muted-foreground md:hidden">{r.summary}</p>
                      <IdeaChart idea={r} />
                      <ul className="space-y-1.5">
                        {r.factors.map((f, k) => (
                          <li key={k} className="flex items-start gap-2 text-xs">
                            <span className={cn('num w-7 shrink-0 text-right font-medium', !f.counted || f.vote === 0 ? 'text-muted-foreground' : f.vote > 0 ? 'text-profit' : 'text-loss')}>
                              {!f.counted || f.vote === 0 ? '0' : f.vote > 0 ? `+${f.vote}` : f.vote}
                            </span>
                            <span className="min-w-0"><span className="font-medium">{f.label}:</span> <span className="text-muted-foreground">{f.detail}</span></span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground pt-1">
                        <span className="font-medium text-foreground">Levels:</span>{' '}
                        support {r.supports.length ? r.supports.map(l => `$${formatPrice(l.price)} (${l.touches})`).join(', ') : 'none found'} ·
                        resistance {r.resistances.length ? r.resistances.map(l => `$${formatPrice(l.price)} (${l.touches})`).join(', ') : 'none found'}
                        <span className="opacity-70"> — touches in brackets, last 30 days</span>
                      </p>
                      {r.bias !== 'neutral' && (
                        <p className="text-xs text-muted-foreground">Stop {lv.stopBasis}; target {lv.targetBasis}.</p>
                      )}
                      <p className="text-[11px] text-muted-foreground pt-1">
                        Score {r.score > 0 ? '+' : ''}{r.score}: +2 or more reads long, −2 or less reads short. 24-hour volatility {r.atrPct}% per hour bar.
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {scope === 'market' && hidden > 0 && (
            <div className="border-t border-border/70 px-5 py-2.5">
              <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowAll(true)}>
                Show all {rows.length} scanned markets
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
