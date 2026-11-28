'use client';

import { useEffect, useState } from 'react';
import { Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Scoreboard as Board, ScoreRow } from '@/lib/automation/scoreboard';

const pct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`);
const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 })}`;
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'text-muted-foreground' : v > 0 ? 'text-profit' : 'text-loss');

function Row({ row }: { row: ScoreRow }) {
  const facts = [
    row.detail,
    row.started && `since ${row.started}`,
    row.closed > 0 && `${row.closed} ${row.unit} closed`,
    row.open > 0 && `${row.open} open`,
    row.netUsd != null && row.capitalUsd != null && `${money(row.netUsd)} on $${row.capitalUsd.toLocaleString('en-US')}`,
  ].filter(Boolean).join(' · ');
  return (
    <li>
      <details>
        <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 sm:px-5 [&::-webkit-details-marker]:hidden">
          <div className="min-w-0">
            <div className="font-medium">{row.name}</div>
            <div className={cn('text-xs', row.ready ? 'text-profit' : 'text-muted-foreground')}>
              {row.verdict}{row.missing.length > 0 && !row.unavailable ? ` · needs ${row.missing.join(' and ')}` : ''}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className={cn('font-semibold tabular-nums', tone(row.ret))}>{pct(row.ret)}</div>
            <div className="text-xs tabular-nums text-muted-foreground">HLP {pct(row.hlp)}</div>
          </div>
        </summary>
        <div className="space-y-3 px-4 pb-4 sm:px-5">
          {facts && <p className="text-xs text-muted-foreground">{facts}</p>}
          <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            {row.checks.map(check => (
              <li key={check.label} className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{check.label}</span>
                <span className="text-right tabular-nums">{check.value} <span className={check.met ? 'text-profit' : 'text-muted-foreground'}>{check.met ? '✓' : '·'}</span></span>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

/** Every forward test on one footing: closed results as a share of the capital each needs, ranked, against HLP over the same dates. */
export function Scoreboard({ market = 'all', refresh }: { market?: string; refresh?: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/scoreboard', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (!live) return;
      if (r.ok && Array.isArray(data?.rows)) { setBoard(data); setFailed(false); } else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [refresh]);

  if (!board) return failed ? <section className="surface px-4 py-4 text-sm text-muted-foreground sm:px-5">The scoreboard could not be loaded.</section> : null;
  return <ScoreboardCard board={board} market={market} />;
}

export function ScoreboardCard({ board, market = 'all' }: { board: Board; market?: string }) {
  const rows = board.rows.filter(row => market === 'all' || row.market === market);
  if (!rows.length) return null;
  const leader = rows.find(row => row.ret != null && !row.unavailable);
  const ready = rows.filter(row => row.ready).length;
  const bar = board.bar;

  return (
    <section className="surface overflow-hidden" aria-label="Scoreboard">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Trophy className="text-primary" size={18} />Scoreboard</h2>
          <span className="text-xs font-medium text-muted-foreground">Forward tests · closed results</span>
        </div>
        {leader ? (
          <div className="mt-4">
            <div className={cn('text-3xl font-semibold tabular-nums leading-none', tone(leader.ret))}>{pct(leader.ret)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {leader.name}, the most so far · HLP {pct(leader.hlp)} over the same {Math.max(1, Math.round(leader.days))} days
            </div>
          </div>
        ) : <p className="mt-3 text-sm text-muted-foreground">Nothing has closed yet.</p>}
        <p className="mt-3 text-sm text-muted-foreground">
          {ready ? `${ready} ${ready === 1 ? 'test meets' : 'tests meet'} the bar for real money.` : 'No test meets the bar for real money yet.'}
          {board.hlpAnnual != null && ` HLP is paying about ${pct(board.hlpAnnual)} a year now.`}
        </p>
      </div>

      <ul className="divide-y divide-border/50 border-t border-border/70">
        {rows.map(row => <Row key={row.id} row={row} />)}
      </ul>

      <details className="border-t border-border/70 px-4 py-3 text-sm text-muted-foreground sm:px-5">
        <summary className="cursor-pointer text-primary">How this is judged</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>The return is the closed results added up, as a share of the capital each test needs: a Paper rule&apos;s stake for every coin it may trade, the most the momentum basket had open at once, and the capital the record-only tests&apos; own rules assume. Open positions count once they close.</li>
          <li>HLP is what the vault&apos;s current yearly rate would have paid over the same dates: the return for simply depositing.</li>
          <li>The bar for real money: at least {bar.days} days, {bar.trades} closed trades ({bar.weeks} weeks for a weekly test, {bar.events} events for an event test), ahead of HLP, a worst drop under {Math.round(bar.maxDrawdown * 100)}% of capital, still profitable without its best coin, and a t-statistic of {bar.tStat} or more so the average is unlikely to be luck. Trades are judged by day, because coins move together.</li>
          <li>Paper rules count one position per rule and coin. Entries an earlier version stacked on a coin that already had a position are left out.</li>
          <li>Meeting the bar does not switch anything on. Live keeps its own checks.</li>
        </ul>
      </details>
    </section>
  );
}
