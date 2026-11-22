'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, Lightbulb, RefreshCw } from 'lucide-react';
import { cn, formatPrice } from '@/lib/utils';
import type { Suggestion } from '@/lib/suggestions';

type Row = Suggestion | { symbol: string; error: string };

interface Props {
  /** Open the trade ticket on this market and side. */
  onTrade: (symbol: string, side: 'long' | 'short') => void;
}

const BIAS_BADGE = { long: 'profit', short: 'loss', neutral: 'secondary' } as const;

export function TradeIdeas({ onTrade }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/suggestions');
      const data = await res.json();
      setRows(res.ok ? data.suggestions : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <section className="surface" aria-label="Trade ideas">
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Trade ideas</h2>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground hidden sm:block">What the tested rules read right now. Not a forecast.</p>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={load} disabled={loading} aria-label="Refresh trade ideas">
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {rows === null ? (
        <div className="px-5 pb-5 space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}</div>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-6 text-sm text-muted-foreground">Could not load suggestions right now.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {rows.map(r => {
            if ('error' in r) return <li key={r.symbol} className="px-5 py-3 text-sm text-muted-foreground"><span className="font-medium text-foreground mr-2">{r.symbol}</span>{r.error}</li>;
            const lv = r.bias === 'short' ? r.short : r.long;
            const isOpen = expanded === r.symbol;
            return (
              <li key={r.symbol}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                  <button type="button" onClick={() => setExpanded(isOpen ? null : r.symbol)} aria-expanded={isOpen} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                    <div className="w-14 shrink-0">
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
                        {r.bias === 'long' ? 'Long' : 'Short'}
                      </Button>
                    </div>
                  )}
                </div>
                {isOpen && (
                  <div className="px-5 pb-4 space-y-2">
                    <p className="text-xs text-muted-foreground md:hidden">{r.summary}</p>
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
                    <p className="text-[11px] text-muted-foreground pt-1">
                      Score {r.score > 0 ? '+' : ''}{r.score}: +2 or more reads long, −2 or less reads short. 24-hour volatility {r.atrPct}% per hour bar.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
