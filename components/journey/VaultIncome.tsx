'use client';

import { useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VaultIncome as Income } from '@/lib/income/hlp';

const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-profit' : 'text-loss');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0 });

/** What simply depositing in Hyperliquid's HLP vault has earned: the one live income source on the venue. */
export function VaultIncome({ refresh }: { refresh?: number }) {
  const [income, setIncome] = useState<Income | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/income', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (live && r.ok && data?.years) setIncome(data);
    }).catch(() => {});
    return () => { live = false; };
  }, [refresh]);

  if (!income || income.updated == null) return null;
  const shrinking = income.size != null && income.sizeYearAgo != null && income.size < income.sizeYearAgo * 0.8;

  return (
    <section className="surface overflow-hidden" aria-label="HLP vault income">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Landmark className="text-primary" size={18} />HLP vault</h2>
          <span className="text-xs font-medium text-muted-foreground">Hyperliquid · real results</span>
        </div>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <div className={cn('text-3xl font-semibold tabular-nums leading-none', tone(income.year))}>{pct(income.year)}</div>
            <div className="mt-1 text-xs text-muted-foreground">last 12 months</div>
          </div>
          <dl className="grid grid-cols-3 gap-x-4 text-right text-sm">
            <div><dt className="text-xs text-muted-foreground">Now, per year</dt><dd className={cn('tabular-nums', tone(income.nowAnnual))}>{pct(income.nowAnnual)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Worst dip</dt><dd className="tabular-nums">{income.dip == null ? '—' : pct(-income.dip)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Size</dt><dd className={cn('tabular-nums', shrinking && 'text-warning')}>{income.size == null ? '—' : usd.format(income.size)}</dd></div>
          </dl>
        </div>
      </div>

      <ul className="divide-y divide-border/50 border-t border-border/70">
        {income.years.map(row => (
          <li key={row.year} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
            <span>{row.year}{row.partial && <span className="text-muted-foreground"> · part year</span>}</span>
            <span className={cn('font-semibold tabular-nums', tone(row.total))}>{pct(row.total)}</span>
          </li>
        ))}
      </ul>

      <details className="border-t border-border/70 px-4 py-3 text-sm text-muted-foreground sm:px-5">
        <summary className="cursor-pointer text-primary">About this</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>HLP is Hyperliquid&apos;s own vault. Depositors share what the exchange makes from market making, liquidations and fees. These are its actual results, not a backtest.</li>
          <li>The yield has fallen every year as the vault matured.{shrinking && income.sizeYearAgo != null ? ` Its size has dropped from ${usd.format(income.sizeYearAgo)} a year ago.` : ''}</li>
          <li>The history has one point about every two weeks, so a dip that recovered inside a fortnight does not show.</li>
          <li>The main risk is not in these numbers: money in the vault is exposed to an exchange failure, an exploit or a bad liquidation event.</li>
          <li>This card only reports. Depositing and withdrawing are done on Hyperliquid.</li>
        </ul>
      </details>
    </section>
  );
}
