'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Telescope } from 'lucide-react';
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
const REASON: Record<string, string> = { time: 'held 7 days', intraday_stop: 'stop hit', gap_stop: 'gapped through stop' };

function verdict(score: Scoreline) {
  if (!score.closed) return 'No closed trades yet. Setups are rare: the backtest averaged about three a month across six coins.';
  if (score.closed < TARGET) return `${score.closed} of ${TARGET} closed trades. Too few to judge either way.`;
  if (score.tStat != null && score.tStat >= 2 && (score.mean ?? 0) > 0) return 'Enough trades, and the average profit is unlikely to be luck.';
  return (score.mean ?? 0) > 0 ? 'Enough trades and a profit, but not clearly more than luck.' : 'Enough trades, and it has not made money.';
}

function Line({ label, score }: { label: string; score: Scoreline }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-right">
        {score.closed ? <>{score.wins} of {score.closed} won · average <span className={cn('font-medium', tone(score.mean))}>{pct(score.mean)}</span> · total <span className={tone(score.total)}>{pct(score.total, 1)}</span></> : 'no closed trades'}
      </span>
    </div>
  );
}

function Row({ trade }: { trade: Trade }) {
  const open = trade.status === 'open';
  return (
    <li className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
      <div className="min-w-0">
        <div className="font-medium">{trade.symbol} <span className={trade.side === 'long' ? 'text-profit' : 'text-loss'}>{trade.side}</span>
          {trade.basket === 'extension' && <span className="ml-2 text-xs font-normal text-muted-foreground">new coin</span>}</div>
        <div className="text-xs text-muted-foreground">
          In {date(trade.entry_day)} at {price(trade.entry_price)}
          {open ? ` · stop ${price(trade.stop_price)}` : ` · out ${date(trade.exit_day!)} at ${price(trade.exit_price!)} (${REASON[trade.exit_reason ?? ''] ?? trade.exit_reason})`}
        </div>
      </div>
      <div className={cn('shrink-0 font-semibold tabular-nums', open ? 'text-muted-foreground' : tone(trade.net))}>{open ? 'open' : pct(trade.net)}</div>
    </li>
  );
}

/** A frozen rule run on new dates: what it would have done, and whether that is yet more than luck. */
export function ForwardTest({ refresh }: { refresh?: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/forward-tests', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (!live) return;
      if (!r.ok || !data?.score) { setFailed(true); return; }
      const stale = data.lastChecked ? Date.now() - Date.parse(data.lastChecked + 'T00:00:00Z') > 2 * 86_400_000 : false;
      setFailed(false); setReport({ ...data, stale });
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refresh]);

  if (!report) return failed ? <section className="surface p-5 text-sm text-muted-foreground">The forward test could not be loaded.</section> : null;
  const { score } = report;
  const stale = !!report.stale;

  return (
    <section className="surface overflow-hidden" aria-label="Forward test: crowded break">
      <div className="px-4 py-4 sm:px-5">
        <h2 className="flex items-center gap-2 font-semibold"><Telescope className="text-primary" size={18} />Forward test: crowded break</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The strongest lead from earlier backtests, now run on dates it has never seen. It logs the trades the rule would take and places no orders.
        </p>
        <p className={cn('mt-2 text-sm font-medium', score.all.closed >= TARGET ? tone(score.all.mean) : '')}>{verdict(score.all)}</p>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuemin={0} aria-valuemax={TARGET} aria-valuenow={Math.min(score.all.closed, TARGET)}
          aria-label="Closed trades toward the number needed to judge">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (score.all.closed / TARGET) * 100)}%` }} />
        </div>
        <div className="mt-3 divide-y divide-border/60">
          <Line label={`Coins the backtest covered (${report.coins.tested.length})`} score={score.tested} />
          <Line label={`New coins (${report.coins.extension.length})`} score={score.extension} />
          <Line label="All" score={score.all} />
        </div>
        <p className={cn('mt-2 text-xs', stale ? 'text-warning' : 'text-muted-foreground')}>
          {report.lastChecked ? `Last checked ${date(report.lastChecked)} (UTC).${stale ? ' That is more than a day behind, so the daily check may have stopped.' : ''}` : 'Not checked yet. The first check runs shortly after midnight UTC.'}
          {' '}Counting trades entered after {date(report.startedAfter)}. Results are after a 0.1% fee each side and funding.
        </p>
        <button type="button" onClick={() => setShowRules(v => !v)} aria-expanded={showRules} className="mt-2 inline-flex items-center gap-1 text-sm text-primary">
          The rule <ChevronDown size={15} className={cn('transition-transform', showRules && 'rotate-180')} />
        </button>
        {showRules && <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>Setup: on Binance futures, open interest in a coin is up more than about 5% over five days, and the share of accounts that are net long is unusually low (sets up a long) or unusually high (sets up a short) against the previous 60 days.</li>
          <li>Confirmation the next day: the daily close breaks above the previous five daily highs for a long, or below the previous five daily lows for a short. If it does not, the setup expires.</li>
          <li>Entry at the following UTC open on Hyperliquid prices. Exit at a 12% adverse move, or at the open seven days later.</li>
          <li>The rule is frozen. It is the survivor of five candidates on a short history, which is why it is being tested here before anything else.</li>
        </ol>}
      </div>
      {report.open.length > 0 && <><h3 className="border-t border-border/70 px-4 pt-3 text-xs font-semibold text-muted-foreground sm:px-5">Open now</h3>
        <ul className="divide-y divide-border/50">{report.open.map(trade => <Row key={trade.symbol + trade.entry_day} trade={trade} />)}</ul></>}
      {report.closed.length > 0 && <><h3 className="border-t border-border/70 px-4 pt-3 text-xs font-semibold text-muted-foreground sm:px-5">Closed</h3>
        <ul className="divide-y divide-border/50">{report.closed.map(trade => <Row key={trade.symbol + trade.entry_day} trade={trade} />)}</ul></>}
    </section>
  );
}
