'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Scale } from 'lucide-react';
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
const yearly = (daily: number | null) => (daily == null ? '—' : pct(daily * 365, 1));

function verdict(s: BasketSummary) {
  if (!s.weeks) return 'No completed week yet. The basket is set every Monday at 00:00 UTC and scored a week later.';
  if (s.weeks < TARGET) return `${s.weeks} of ${TARGET} weeks. Too few to judge either way.`;
  if (s.tStat != null && s.tStat >= 2 && s.net > 0) return 'Enough weeks, and the profit is unlikely to be luck.';
  return s.net > 0 ? 'Enough weeks and a profit, but not clearly more than luck.' : 'Enough weeks, and it has not made money.';
}

function Legs({ title, legs, hint }: { title: string; legs: Leg[]; hint: string }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul className="mt-1 space-y-0.5 text-sm">
        {legs.map(leg => <li key={leg.symbol} className="flex justify-between gap-3"><span className="font-medium">{leg.symbol}</span><span className="tabular-nums text-muted-foreground">{yearly(leg.rate)}</span></li>)}
      </ul>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The weekly funding carry basket run forward on Hyperliquid: what it holds and what it has earned, split by source. */
export function FundingBasketTest({ refresh }: { refresh?: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/forward-tests?test=funding_basket', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (!live) return;
      if (!r.ok || !data?.summary) { setFailed(true); return; }
      setFailed(false); setReport(data);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refresh]);

  if (!report) return failed ? <section className="surface p-5 text-sm text-muted-foreground">The funding basket test could not be loaded.</section> : null;
  const s = report.summary;

  return (
    <section className="surface overflow-hidden" aria-label="Forward test: funding basket">
      <div className="px-4 py-4 sm:px-5">
        <h2 className="flex items-center gap-2 font-semibold"><Scale className="text-primary" size={18} />Forward test: funding basket</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each week it shorts the coins paying the most funding and buys the ones paying the least, in equal amounts, so the market&apos;s direction should not matter. It logs what that basket would earn and places no orders.
        </p>
        <p className={cn('mt-2 text-sm font-medium', s.weeks >= TARGET ? tone(s.net) : '')}>{verdict(s)}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={TARGET} aria-valuenow={Math.min(s.weeks, TARGET)}
          aria-label="Completed weeks toward the number needed to judge">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (s.weeks / TARGET) * 100)}%` }} />
        </div>

        {s.weeks > 0 && <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          {([['Net so far', s.net, true], ['From funding', s.funding, false], ['From price moves', s.price, false], ['Fees', -s.costs, false]] as const).map(([label, value, strong]) =>
            <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className={cn('tabular-nums', strong && 'font-semibold', tone(value))}>{pct(value)}</dd></div>)}
        </dl>}
        {s.weeks > 0 && <p className="mt-2 text-xs text-muted-foreground">
          {s.positive} of {s.weeks} weeks made money. Funding is the part this idea is built on. Price moves are the swing around it and can be much larger in either direction. All figures are a share of the capital used.
        </p>}

        {report.current && <div className="mt-4 grid grid-cols-2 gap-4">
          <Legs title="Short now" legs={report.current.shorts} hint="Paying the most funding. Yearly rate over the last 30 days." />
          <Legs title="Long now" legs={report.current.longs} hint="Paying the least. A negative rate pays the holder." />
        </div>}

        <p className="mt-3 text-xs text-muted-foreground">
          {report.lastRebalance ? `Basket last set ${date(report.lastRebalance)} (UTC). ` : 'The first basket has not been set yet. '}
          Started {date(report.started)}, the first Monday after the backtest&apos;s data ended. Weeks before this was switched on were worked out afterwards from recorded prices and funding, by the same fixed rule.
          {report.note ? ` Note: ${report.note}.` : ''}
        </p>
        <button type="button" onClick={() => setShowRules(v => !v)} aria-expanded={showRules} className="mt-2 inline-flex items-center gap-1 text-sm text-primary">
          The rule and its limits <ChevronDown size={15} className={cn('transition-transform', showRules && 'rotate-180')} />
        </button>
        {showRules && <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>Every Monday at 00:00 UTC, 16 coins are ranked by their average daily funding on Hyperliquid over the previous 30 days. The top quarter is shorted and the bottom quarter bought, half the capital on each side.</li>
          <li>A coin that stays in the basket is not traded. A 0.1% fee is charged on whatever changes.</li>
          <li>In the backtest this passed its test, but funding earned only about 6% to 8% a year. Most of its best period came from price moves, with one coin held long almost every week.</li>
          <li>The backtest used Binance. This uses Hyperliquid prices and funding, so it is also a test of whether the idea carries over.</li>
          <li>It does not model margin, liquidation or the spread paid when trading.</li>
        </ul>}
      </div>
      {report.weeks.length > 0 && <>
        <h3 className="border-t border-border/70 px-4 pt-3 text-xs font-semibold text-muted-foreground sm:px-5">Week by week</h3>
        <ul className="divide-y divide-border/50">
          {report.weeks.map(week => {
            const net = week.price + week.funding - week.cost;
            return (
              <li key={week.ended} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                <div className="min-w-0">
                  <div className="font-medium">Week to {date(week.ended)}</div>
                  <div className="text-xs text-muted-foreground">Funding {pct(week.funding)} · price {pct(week.price)} · fees {pct(-week.cost)}</div>
                </div>
                <div className={cn('shrink-0 font-semibold tabular-nums', tone(net))}>{pct(net)}</div>
              </li>
            );
          })}
        </ul>
      </>}
    </section>
  );
}
