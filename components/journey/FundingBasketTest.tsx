'use client';

import { useEffect, useState } from 'react';
import { Scale } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BasketSummary } from '@/lib/forward-tests/funding-basket';

type Leg = { symbol: string; rate: number | null };
type Report = { started: string; lastRebalance: string | null; summary: BasketSummary; current: { longs: Leg[]; shorts: Leg[] } | null;
  weeks: Array<{ ended: string; price: number; funding: number; cost: number }>; note: string | null };

/** Held weeks wanted before the result is treated as more than noise: about six months. */
const TARGET = 26;
const pct = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-profit' : 'text-loss');
const date = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** A daily funding rate as a yearly percentage. */
const yearly = (daily: number | null) => (daily == null ? '—' : pct(daily * 365, 0));

function status(s: BasketSummary) {
  if (s.weeks < TARGET) return { label: `Testing · week ${s.weeks} of ${TARGET}`, tone: 'text-muted-foreground' };
  if (s.net > 0 && s.tStat != null && s.tStat >= 2) return { label: 'Working', tone: 'text-profit' };
  return s.net > 0 ? { label: 'Unproven', tone: 'text-muted-foreground' } : { label: 'Not working', tone: 'text-loss' };
}

function Side({ title, legs }: { title: string; legs: Leg[] }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul className="mt-1 space-y-0.5 text-sm">
        {legs.map(leg => <li key={leg.symbol} className="flex justify-between gap-3"><span className="font-medium">{leg.symbol}</span>
          <span className="tabular-nums text-muted-foreground" title="Funding per year, last 30 days">{yearly(leg.rate)}</span></li>)}
      </ul>
    </div>
  );
}

/** The weekly funding basket run forward on Hyperliquid: result, where it came from, and what it holds. */
export function FundingBasketTest({ refresh }: { refresh?: number }) {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/forward-tests?test=funding_basket', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (live && r.ok && data?.summary) setReport(data);
    }).catch(() => {});
    return () => { live = false; };
  }, [refresh]);

  if (!report) return null;
  const s = report.summary, state = status(s);

  return (
    <section className="surface overflow-hidden" aria-label="Forward test: funding basket">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Scale className="text-primary" size={18} />Funding basket</h2>
          <span className={cn('text-xs font-medium', state.tone)}>{state.label}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={TARGET} aria-valuenow={Math.min(s.weeks, TARGET)} aria-label="Weeks tested">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (s.weeks / TARGET) * 100)}%` }} />
        </div>

        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            <div className={cn('text-3xl font-semibold tabular-nums leading-none', tone(s.weeks ? s.net : null))}>{s.weeks ? pct(s.net) : '—'}</div>
            <div className="mt-1 text-xs text-muted-foreground">{s.weeks ? `${s.positive} of ${s.weeks} weeks up` : `First result ${report.lastRebalance ? date(new Date(Date.parse(report.lastRebalance + 'T00:00:00Z') + 7 * 86_400_000).toISOString().slice(0, 10)) : 'next Monday'}`}</div>
          </div>
          {s.weeks > 0 && <dl className="grid grid-cols-3 gap-x-4 text-right text-sm">
            {([['Funding', s.funding], ['Price', s.price], ['Fees', -s.costs]] as const).map(([label, value]) =>
              <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className={cn('tabular-nums', tone(value))}>{pct(value)}</dd></div>)}
          </dl>}
        </div>

        {report.current && <div className="mt-4 grid grid-cols-2 gap-5">
          <Side title="Short" legs={report.current.shorts} />
          <Side title="Long" legs={report.current.longs} />
        </div>}
      </div>

      {report.weeks.length > 0 && <ul className="divide-y divide-border/50 border-t border-border/70">
        {report.weeks.map(week => {
          const net = week.price + week.funding - week.cost;
          return (
            <li key={week.ended} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
              <span>Week to {date(week.ended)}</span>
              <span className={cn('font-semibold tabular-nums', tone(net))}>{pct(net)}</span>
            </li>
          );
        })}
      </ul>}

      <details className="border-t border-border/70 px-4 py-3 text-sm text-muted-foreground sm:px-5">
        <summary className="cursor-pointer text-primary">About this test</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>Every Monday it shorts the 4 of 16 coins paying the most funding on Hyperliquid and buys the 4 paying the least. It records the result and places no orders.</li>
          <li>Funding is the income the idea is built on. Price is the swing around it, and can be far larger either way.</li>
          <li>Started {date(report.started)}. Weeks before it was switched on were worked out from recorded data by the same fixed rule.</li>
          <li>Fees are 0.1% of what changes each week. Margin, liquidation and spread are not included.</li>
          {report.note && <li>{report.note}</li>}
        </ul>
      </details>
    </section>
  );
}
