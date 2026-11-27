'use client';

import { useEffect, useState } from 'react';
import { Telescope } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Scoreline } from '@/lib/forward-tests/crowded-break';

type Trade = { symbol: string; side: 'long' | 'short'; basket: 'tested' | 'extension'; signal_day: string; entry_day: string; entry_price: number;
  stop_price: number; exit_day: string | null; exit_price: number | null; exit_reason: string | null; net: number | null; status: 'open' | 'closed' };
type Report = { stale?: boolean; startedAfter: string; lastChecked: string | null; coins: { tested: string[]; extension: string[] };
  score: { all: Scoreline; tested: Scoreline; extension: Scoreline }; open: Trade[]; closed: Trade[] };

/** Closed trades wanted before the result is treated as more than noise. */
const TARGET = 30;
const pct = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-profit' : 'text-loss');
const price = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(3) : v.toPrecision(4));
const date = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function status(score: Scoreline, stale: boolean) {
  if (stale) return { label: 'Not updating', tone: 'text-warning' };
  if (score.closed < TARGET) return { label: `Testing · trade ${score.closed} of ${TARGET}`, tone: 'text-muted-foreground' };
  if ((score.mean ?? 0) > 0 && score.tStat != null && score.tStat >= 2) return { label: 'Working', tone: 'text-profit' };
  return (score.mean ?? 0) > 0 ? { label: 'Unproven', tone: 'text-muted-foreground' } : { label: 'Not working', tone: 'text-loss' };
}

function Row({ trade }: { trade: Trade }) {
  const open = trade.status === 'open';
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
      <div className="min-w-0">
        <span className="font-medium">{trade.symbol}</span> <span className={trade.side === 'long' ? 'text-profit' : 'text-loss'}>{trade.side}</span>
        <span className="block text-xs text-muted-foreground">
          {date(trade.entry_day)} at {price(trade.entry_price)}{open ? ` · stop ${price(trade.stop_price)}` : ` → ${date(trade.exit_day!)} at ${price(trade.exit_price!)}`}
        </span>
      </div>
      <span className={cn('shrink-0 font-semibold tabular-nums', open ? 'text-primary' : tone(trade.net))}>{open ? 'Open' : pct(trade.net)}</span>
    </li>
  );
}

/** A frozen rule run on new dates: its result so far and the trades behind it. */
export function ForwardTest({ refresh }: { refresh?: number }) {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/forward-tests', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (!live || !r.ok || !data?.score) return;
      setReport({ ...data, stale: data.lastChecked ? Date.now() - Date.parse(data.lastChecked + 'T00:00:00Z') > 2 * 86_400_000 : false });
    }).catch(() => {});
    return () => { live = false; };
  }, [refresh]);

  if (!report) return null;
  const score = report.score.all, state = status(score, !!report.stale);
  const trades = [...report.open, ...report.closed];

  return (
    <section className="surface overflow-hidden" aria-label="Forward test: crowded break">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Telescope className="text-primary" size={18} />Crowded break</h2>
          <span className={cn('text-xs font-medium', state.tone)}>{state.label}</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={TARGET} aria-valuenow={Math.min(score.closed, TARGET)} aria-label="Trades tested">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (score.closed / TARGET) * 100)}%` }} />
        </div>
        <div className="mt-4">
          <div className={cn('text-3xl font-semibold tabular-nums leading-none', tone(score.closed ? score.total : null))}>{score.closed ? pct(score.total, 1) : '—'}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {score.closed ? `${score.wins} of ${score.closed} trades won · ${pct(score.mean)} a trade` : report.open.length ? `${report.open.length} open, none closed yet` : 'Waiting for its first trade'}
          </div>
        </div>
      </div>

      {trades.length > 0 && <ul className="divide-y divide-border/50 border-t border-border/70">{trades.map(trade => <Row key={trade.symbol + trade.entry_day} trade={trade} />)}</ul>}

      <details className="border-t border-border/70 px-4 py-3 text-sm text-muted-foreground sm:px-5">
        <summary className="cursor-pointer text-primary">About this test</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>It trades a break in price against a crowded futures market: a break up when few accounts are long, a break down when many are, after open interest has built. It records the trade and places no orders.</li>
          <li>Out at a 12% loss or after seven days. Results are after a 0.1% fee each side and funding.</li>
          <li>It was the best of five ideas in a backtest with few trades, so it is being checked on new dates since {date(report.startedAfter)} before anything else.</li>
          <li>Coins from the backtest: {score.closed ? `${report.score.tested.closed} trades, ${pct(report.score.tested.total, 1)}` : 'no trades yet'}. Coins it never saw: {report.score.extension.closed ? `${report.score.extension.closed} trades, ${pct(report.score.extension.total, 1)}` : 'no trades yet'}.</li>
          {report.lastChecked && <li>Last checked {date(report.lastChecked)}.</li>}
        </ul>
      </details>
    </section>
  );
}
