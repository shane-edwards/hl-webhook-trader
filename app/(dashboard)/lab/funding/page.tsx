'use client';

import { Fragment, useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Badge } from '@/components/ui/badge';
import { Segmented } from '@/components/ui/segmented';
import { Skeleton } from '@/components/ui/skeleton';
import { SCAN_MINUTES, VENUE_NAMES, type GapResult } from '@/lib/funding-scan/model';
import { cn, formatRelativeTime, pnlColor } from '@/lib/utils';

type Days = '1' | '7' | '30';
type Report = { days: number; latestAt: string | null; markets: number; scans: number; gaps: GapResult[] };
/** Each answer remembers the window it was asked for, so a slower reply for an old window is never shown. */
type Loaded = { days: Days; report?: Report; stale?: boolean; error?: string };

const WINDOWS: Array<{ value: Days; label: string }> = [
  { value: '1', label: '24 hours' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];
const STALE_MS = 15 * 60_000;
const REFRESH_MS = 60_000;

const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
const signed = (value: number, digits = 1) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

function breakEven(hours: number) {
  if (!Number.isFinite(hours) || hours > 720) return 'over 30 days';
  return hours > 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`;
}

function hoursOfData(scans: number, days: number) {
  const hours = Math.min(scans * SCAN_MINUTES / 60, days * 24);
  const text = hours.toFixed(1).replace(/\.0$/, '');
  return `${text} ${text === '1' ? 'hour' : 'hours'} of data`;
}

export default function FundingGapsPage() {
  const [days, setDays] = useState<Days>('7');
  const [loaded, setLoaded] = useState<Loaded>();
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const update = async () => {
      try {
        const response = await fetch(`/api/funding-gaps?days=${days}`, { signal: controller.signal, cache: 'no-store' });
        const data = await response.json().catch(() => null) as (Partial<Report> & { error?: string }) | null;
        if (!response.ok || !data || !Array.isArray(data.gaps)) throw new Error(data?.error ?? 'Could not load the funding scans.');
        const report = data as Report;
        const stale = !!report.latestAt && Date.now() - Date.parse(report.latestAt) > STALE_MS;
        if (!controller.signal.aborted) setLoaded({ days, report, stale });
      } catch (err) {
        if (controller.signal.aborted) return;
        const error = err instanceof Error && err.message ? err.message : 'Could not load the funding scans.';
        // A failed refresh keeps the last good table for this window on screen.
        setLoaded(previous => previous?.days === days && previous.report ? { ...previous, error } : { days, error });
      }
    };
    void update();
    const interval = setInterval(() => void update(), REFRESH_MS);
    return () => { controller.abort(); clearInterval(interval); };
  }, [days]);

  const current = loaded?.days === days ? loaded : undefined;
  const report = current?.report;
  const loading = !current;

  return (
    <div className="flex flex-col min-h-full">
      <Header />
      <div className="p-4 lg:p-8 space-y-5 w-full max-w-[1400px] mx-auto">
        <section className="surface p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented aria-label="Time window" value={days} onChange={setDays} options={WINDOWS} />
            <div aria-live="polite" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {loading ? <Skeleton className="h-4 w-56" /> : report && <>
                {current.stale && <Badge variant="warning">Not updating</Badge>}
                <span>{report.latestAt ? `Updated ${formatRelativeTime(report.latestAt)}` : 'Collecting data'}</span>
                <span>· {hoursOfData(report.scans, report.days)}</span>
              </>}
            </div>
          </div>
          {current?.error && <p role="alert" className="text-sm text-destructive">{current.error}</p>}

          {loading && <div className="space-y-2" aria-label="Loading funding gaps">
            {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>}

          {report && report.gaps.length === 0 && <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Collecting data</p>
            <p className="mt-1">First results in about an hour.</p>
          </div>}

          {report && report.gaps.length > 0 && <div className="overflow-x-auto -mx-4 lg:-mx-6">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Market</th>
                  <th scope="col" className="text-left">Position</th>
                  <th scope="col" title="Funding collected over the data in this window minus one round trip, as a share of the position">Net after costs</th>
                  <th scope="col" title="Average funding difference over the window, as a yearly rate">Yearly gap</th>
                  <th scope="col" className="hidden sm:table-cell" title="The difference in the latest scan, as a yearly rate. Negative means the direction has flipped.">Now</th>
                  <th scope="col" className="hidden md:table-cell" title="Share of scans where the gap pointed the same way as its average">Consistency</th>
                  <th scope="col" className="hidden lg:table-cell" title="Fees and spread to open and close both sides, as a share of the position">Cost</th>
                  <th scope="col" className="hidden sm:table-cell" title="Time the average gap needs to pay for the round-trip cost">Break-even</th>
                  <th scope="col" className="hidden lg:table-cell">Volume</th>
                </tr>
              </thead>
              <tbody>
                {report.gaps.map(gap => {
                  const now = gap.nowHourly == null ? null : gap.nowHourly * 24 * 365 * 100;
                  const net = gap.netOverWindow * 100;
                  const open = expanded === gap.symbol;
                  const figures: Array<[string, string, string?]> = [
                    ['Yearly gap', `${gap.annualPct.toFixed(1)}%`],
                    ['Now', now == null ? 'n/a' : `${now.toFixed(1)}%`, now != null && now < 0 ? 'text-loss' : undefined],
                    ['Consistency', `${(gap.consistency * 100).toFixed(0)}%`],
                    ['Cost', `${(gap.cost * 100).toFixed(2)}%`],
                    ['Break-even', breakEven(gap.breakEvenHours)],
                    ['Volume', gap.hlVolume == null ? 'n/a' : compactUsd.format(gap.hlVolume)],
                  ];
                  return (
                    <Fragment key={gap.symbol}>
                    <tr>
                      <td className="font-medium">
                        {/* Below the widest layout some columns are hidden, so the market name opens every figure. */}
                        <button type="button" onClick={() => setExpanded(open ? null : gap.symbol)} aria-expanded={open}
                          className="inline-flex items-center gap-1 lg:pointer-events-none">
                          {gap.symbol}<ChevronDown size={14} aria-hidden="true" className={cn('text-muted-foreground transition-transform lg:hidden', open && 'rotate-180')} />
                        </button>
                      </td>
                      <td className="text-left">
                        <span className="block xl:inline">Short {VENUE_NAMES[gap.short]}</span>
                        <span className="hidden xl:inline"> / </span>
                        <span className="block xl:inline text-muted-foreground xl:text-foreground">Long {VENUE_NAMES[gap.long]}</span>
                      </td>
                      <td className={cn('num font-medium', pnlColor(net))}>{signed(net, 2)}%</td>
                      <td className="num">{gap.annualPct.toFixed(1)}%</td>
                      <td className={cn('num hidden sm:table-cell', now == null ? 'text-muted-foreground' : now < 0 && 'text-loss')}>{now == null ? 'n/a' : `${now.toFixed(1)}%`}</td>
                      <td className="num hidden md:table-cell">{(gap.consistency * 100).toFixed(0)}%</td>
                      <td className="num hidden lg:table-cell">{(gap.cost * 100).toFixed(2)}%</td>
                      <td className="num hidden sm:table-cell">{breakEven(gap.breakEvenHours)}</td>
                      <td className="num hidden lg:table-cell text-muted-foreground">{gap.hlVolume == null ? 'n/a' : compactUsd.format(gap.hlVolume)}</td>
                    </tr>
                    {open && <tr className="lg:hidden">
                      <td colSpan={9} className="!text-left">
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 py-1 sm:grid-cols-3">
                          {figures.map(([label, value, colour]) => <div key={label}>
                            <dt className="text-xs text-muted-foreground">{label}</dt>
                            <dd className={cn('tabular-nums', colour)}>{value}</dd>
                          </div>)}
                        </dl>
                      </td>
                    </tr>}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>}
        </section>

        <details className="surface p-4 lg:p-6 text-sm text-muted-foreground">
          <summary className="cursor-pointer text-primary">About these numbers</summary>
          <ul className="mt-3 list-disc pl-5 space-y-2 max-w-3xl">
            <li>The trade: short a coin on the exchange paying more funding and buy the same amount on the one paying less. Nothing here places an order.</li>
            <li>Rates are each exchange&apos;s predicted next funding rate, sampled every {SCAN_MINUTES} minutes, so results are estimates, not settled payments.</li>
            <li>Costs are the standard fee on all four fills, and assume the other exchange&apos;s spread matches Hyperliquid&apos;s.</li>
            <li>Not included: price differences between the exchanges, and the margin needed on both. A large gap on a small coin may not be tradable at size.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
