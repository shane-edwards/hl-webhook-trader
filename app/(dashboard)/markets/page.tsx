'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Stat } from '@/components/ui/stat';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowDown, ArrowUp, Search, Info } from 'lucide-react';
import { toast } from 'sonner';
import { cn, formatPrice } from '@/lib/utils';
import type { Market } from '@/lib/hyperliquid/public';

type SortKey = 'coin' | 'price' | 'change24h' | 'fundingAnnual' | 'premium' | 'openInterestUsd' | 'volume24hUsd';

const LIQUID_VOLUME_USD = 5_000_000;
const FUNDING_BAR_FULL = 0.3; // a 30%/yr rate fills the bar

const usd = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`;
const pct = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;

const COLUMNS: Array<{ key: SortKey; label: string; hint?: string; className?: string }> = [
  { key: 'coin', label: 'Market' },
  { key: 'price', label: 'Price' },
  { key: 'change24h', label: '24h' },
  { key: 'fundingAnnual', label: 'Funding / yr', hint: 'The current hourly rate, annualised. Positive: longs pay shorts.' },
  { key: 'premium', label: 'Premium', hint: 'Perp price vs the spot oracle', className: 'hidden md:table-cell' },
  { key: 'openInterestUsd', label: 'Open interest', className: 'hidden sm:table-cell' },
  { key: 'volume24hUsd', label: '24h volume', className: 'hidden lg:table-cell' },
];

/** Diverging bar: right of centre when longs pay, left when shorts pay. */
function FundingBar({ value }: { value: number }) {
  const w = Math.min(1, Math.abs(value) / FUNDING_BAR_FULL) * 50;
  return (
    <span className="relative hidden sm:inline-block w-16 h-1.5 rounded-full bg-secondary align-middle" aria-hidden>
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span
        className="absolute inset-y-0 rounded-full"
        style={{ width: `${w}%`, left: value >= 0 ? '50%' : `${50 - w}%`, background: value >= 0 ? 'var(--series-1)' : 'var(--series-2)' }}
      />
    </span>
  );
}

export default function MarketsPage() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [liquidOnly, setLiquidOnly] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'fundingAnnual', dir: -1 });

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const res = await fetch('/api/markets');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMarkets(data.markets ?? []);
    } catch {
      if (manual) toast.error('Could not load markets');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const liquid = useMemo(() => markets.filter(m => m.volume24hUsd >= LIQUID_VOLUME_USD), [markets]);

  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const base = (liquidOnly ? liquid : markets).filter(m => !q || m.coin.toUpperCase().includes(q));
    return [...base].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
    });
  }, [markets, liquid, liquidOnly, query, sort]);

  const btc = markets.find(m => m.coin === 'BTC');
  const hot = liquid.filter(m => m.fundingAnnual >= 0.15).length;
  const negative = liquid.filter(m => m.fundingAnnual < 0).length;
  const totalOi = markets.reduce((a, m) => a + m.openInterestUsd, 0);

  function toggleSort(key: SortKey) {
    setSort(s => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'coin' ? 1 : -1 }));
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => load(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-8 space-y-4 lg:space-y-6 flex-1 w-full max-w-[1400px] mx-auto">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          <Stat label="BTC funding / yr" value={btc ? pct(btc.fundingAnnual, 1) : '—'} hint={btc ? (btc.fundingAnnual >= 0 ? 'Longs are paying shorts' : 'Shorts are paying longs') : undefined} loading={loading} />
          <Stat label="High funding" value={String(hot)} hint="Liquid markets above 15% / yr" loading={loading} />
          <Stat label="Negative funding" value={String(negative)} hint="Liquid markets, shorts pay" loading={loading} />
          <Stat label="Total open interest" value={usd(totalOi)} hint={`${markets.length} markets`} loading={loading} />
        </div>

        <div className="surface px-4 py-3 flex gap-3 text-xs text-muted-foreground leading-relaxed">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
          <p>
            <span className="text-foreground font-medium">Reading funding.</span> A high positive rate means holding a long is
            expensive, and that a hedged position (spot long + perp short) is being paid. Rates reset every hour and often
            fade within days, so an annualised figure is a snapshot, not a yield you can lock in. The Strategy Lab shows what
            collecting it actually returned.
          </p>
        </div>

        <section className="surface overflow-hidden" aria-label="Markets">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search market" className="pl-9" aria-label="Search market" />
            </div>
            <label className="flex items-center gap-2.5 text-xs text-muted-foreground cursor-pointer select-none">
              Liquid only <span className="hidden sm:inline">(over $5M traded today)</span>
              <Switch checked={liquidOnly} onCheckedChange={setLiquidOnly} />
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  {COLUMNS.map(c => (
                    <th key={c.key} className={c.className} aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        title={c.hint}
                        className={cn('inline-flex items-center gap-1 uppercase tracking-[0.08em] hover:text-foreground transition-colors', sort.key === c.key && 'text-foreground')}
                      >
                        {c.label}
                        {sort.key === c.key && (sort.dir === 1 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? [...Array(12)].map((_, i) => (
                      <tr key={i}><td colSpan={COLUMNS.length}><Skeleton className="h-5 w-full" /></td></tr>
                    ))
                  : rows.map(m => (
                      <tr key={m.coin}>
                        <td>
                          <span className="font-medium text-foreground">{m.coin}</span>
                          <span className="text-[11px] text-muted-foreground ml-2 hidden sm:inline">{m.maxLeverage}x</span>
                        </td>
                        <td className="num">${formatPrice(m.price)}</td>
                        <td className={cn('num', m.change24h > 0 ? 'text-profit' : m.change24h < 0 ? 'text-loss' : 'text-muted-foreground')}>{pct(m.change24h)}</td>
                        <td>
                          <span className="inline-flex items-center gap-2.5 justify-end">
                            <FundingBar value={m.fundingAnnual} />
                            <span className="num sm:w-[68px] text-right">{pct(m.fundingAnnual, 1)}</span>
                          </span>
                        </td>
                        <td className="num text-muted-foreground hidden md:table-cell">{pct(m.premium, 3)}</td>
                        <td className="num hidden sm:table-cell">{usd(m.openInterestUsd)}</td>
                        <td className="num text-muted-foreground hidden lg:table-cell">{usd(m.volume24hUsd)}</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>

          {!loading && rows.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-10">No markets match.</p>
          )}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5 border-t border-border text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: 'var(--series-1)' }} />Longs pay shorts</span>
            <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: 'var(--series-2)' }} />Shorts pay longs</span>
            <span className="ml-auto">{rows.length} shown · updates every 30s</span>
          </div>
        </section>
      </div>
    </div>
  );
}
