'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PAPER_REQUIREMENT, PAPER_REQUIREMENT_TEXT, type AutomationMarket, type Evidence, type RunReport } from '@/lib/automation/model';
import type { AutomationDecision, PaperResults } from '@/lib/automation/policy';
import type { StockLabReport } from '@/lib/stocks/intraday-lab';
import type { replayStockPortfolio } from '@/lib/stocks/portfolio-replay';
import { formatCurrency } from '@/lib/utils';

type Run = { id: string; kind: 'daily' | 'weekly'; status: string; cursor: number; plan: string[]; detail: string | null;
  report: RunReport | null; created_at: string; completed_at: string | null };
type Market = { market: AutomationMarket; policy: AutomationDecision; candidate: Evidence | null; paper: PaperResults | null; runs: Run[] };
type Overview = { markets: Market[]; health: { key: string; ok: boolean; detail: string | null }[];
  shadow: { session_day: string; completed_at: string; summary: { rows: number } } | null;
  legacy: { stocks: string | null; crypto: string | null };
  cryptoShadow: { symbol: string; strategy: string; signal_bar: string; decision: string; detail: string; outcome?: { pnlUsd?: number; exit: string } }[] };
const names = { stocks: 'Stocks', crypto: 'Crypto' };
const time = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
const labels: Record<string, string> = { queued: 'Queued', running: 'Testing', completed: 'Completed', failed: 'Needs attention', cancelled: 'Cancelled' };

function ResearchDetails({ report }: { report: RunReport }) {
  const portfolio = report.data.portfolio as ReturnType<typeof replayStockPortfolio> | undefined;
  const lab = report.data.report as StockLabReport | undefined;
  const journal = report.data.journal as { updated: number; awaitingBroker: number } | undefined;
  return <>
    {portfolio && <p>Portfolio net {percent(portfolio.return)} · higher costs {percent(portfolio.stressedReturn)} · exposure-matched SPY {percent(portfolio.spy)} · drawdown {percent(portfolio.drawdown)} · {portfolio.trades} trades</p>}
    {journal && <p>eToro journal · {journal.updated} refreshed · {journal.awaitingBroker} awaiting broker records</p>}
    {lab?.reports.map(row => <p key={row.rule}>{row.label} · {row.status} · {row.dateHoldout.trades} later trades · {row.tickerHoldout.trades} reserved-ticker trades</p>)}
    {report.evidence.map(row => <p key={row.version}>{row.symbol} · {row.name} · later {percent(row.later)} · higher costs {percent(row.stress)} · benchmark {percent(row.benchmark)} · {row.holdoutTrades} holdout trades · {row.reason}</p>)}
  </>;
}

export default function AutomationCenter() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pending, setPending] = useState<AutomationMarket | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [approval, setApproval] = useState<Market | null>(null);
  const [budget, setBudget] = useState('25');
  const [maximum, setMaximum] = useState('500');
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/automation', { signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not read automation status.');
    if (!signal?.aborted) setOverview(data);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const refresh = () => void load(abort.signal).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    refresh();
    const poll = setInterval(refresh, 20_000);
    return () => { abort.abort(); clearInterval(poll); };
  }, [load]);

  async function act(market: AutomationMarket, action: object) {
    setPending(market); setNotice(''); setError('');
    try {
      const response = await fetch('/api/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, ...action }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not update automation.');
      setNotice(result.message); setApproval(null);
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update automation.'); }
    finally { setPending(null); }
  }

  function approve(event: FormEvent) {
    event.preventDefault();
    if (!approval?.candidate) return;
    void act(approval.market, { action: 'approve', version: approval.candidate.version, budget: Number(budget), maxOrder: Number(maximum), confirmed: true });
  }

  const worker = overview?.health.find(item => item.key === 'automation');
  const needingAttention = overview?.markets.filter(item => item.runs[0]?.status === 'failed').map(item => names[item.market]) ?? [];
  return <><Header /><div className="w-full max-w-[1400px] mx-auto space-y-4 p-4 lg:p-8">
    <div className="surface p-4 lg:p-6">
      <h2 className="font-semibold">Today</h2>
      <p className="mt-1 text-sm text-muted-foreground">{!overview ? 'Checking automation…' : worker?.ok
        ? (needingAttention.length ? `${needingAttention.join(' and ')} needs attention.` : 'The research worker is checking schedules automatically.')
        : 'Waiting for the research worker’s next confirmed check.'}</p>
      {notice && <p role="status" className="mt-2 text-sm">{notice}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-loss">{error}</p>}
    </div>
    <div className="grid xl:grid-cols-2 gap-4">
      {overview?.markets.map(item => {
        const { market, policy, runs, candidate, paper } = item;
        const profile = policy.profile;
        const busy = pending != null;
        const mode = profile?.mode ?? 'research';
        const current = runs.find(run => run.status === 'running' || run.status === 'queued');
        const last = runs.find(run => run.kind === 'daily' && run.status === 'completed');
        const legacy = policy.decision === 'legacy' ? overview.legacy?.[market] : null;
        return <section key={market} className="surface p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap gap-2 justify-between"><h2 className="font-semibold">{names[market]}</h2>
            <span className="text-xs text-muted-foreground">{profile?.entries_paused ? 'Entries paused' : mode === 'live' ? 'Live' : mode === 'paper' ? 'Paper' : 'Research'}</span>
          </div>
          <p className="text-sm">{policy.detail}</p>
          {legacy && <p className="text-xs text-muted-foreground">Existing {legacy === 'real' || legacy === 'live' ? 'Live' : 'Paper'} Autopilot is active.</p>}
          <p className="text-xs text-muted-foreground">
            {current ? `${current.kind === 'daily' ? 'Daily' : 'Weekly'} run · ${current.cursor} of ${current.plan.length} markets checked`
              : last?.completed_at ? `Last completed ${time(last.completed_at)} · ${last.detail}` : 'Waiting for the first completed run.'}
          </p>
          {market === 'stocks' && overview.shadow && <p className="text-xs text-muted-foreground">Last shadow capture {overview.shadow.session_day} · {overview.shadow.summary.rows} observations</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !!current} onClick={() => void act(market, { action: 'run', kind: 'daily' })}>Run now</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(market, { action: 'entries', paused: !profile?.entries_paused })}>
              {profile?.entries_paused ? 'Resume entries' : 'Pause new entries'}
            </Button>
            <Button size="sm" variant="ghost" asChild><Link href={market === 'stocks' ? '/stocks?tab=trade' : '/dashboard'}>Manual trade</Link></Button>
          </div>
          <div className="border-t border-border pt-3 space-y-3">
            <div className="flex flex-wrap gap-2 items-center">
              <label className="text-sm flex items-center gap-2">
                <input type="checkbox" checked={profile?.enabled ?? false} disabled={busy}
                  onChange={e => void act(market, { action: 'schedule', enabled: e.target.checked })} />
                Run tests on schedule
              </label>
              {mode === 'research' ? <Button size="sm" disabled={busy} variant="outline" onClick={() => void act(market, { action: 'mode', mode: 'paper' })}>Enable automatic Paper</Button>
                : <Button size="sm" disabled={busy} variant="outline" onClick={() => void act(market, { action: 'mode', mode: 'research' })}>Switch to Research</Button>}
            </div>
            {candidate ? <div className="rounded-md border border-border p-3 space-y-1">
              <p className="text-sm font-medium">{candidate.symbol} · {candidate.name}</p>
              <p className="text-xs text-muted-foreground">{paper?.closed ?? 0} of {PAPER_REQUIREMENT.trades} closed Paper trades · {paper?.days ?? 0} of {PAPER_REQUIREMENT.dates} session dates · {paper?.closed ? formatCurrency(paper.net) + ' net' : 'Gathering evidence'}
                {paper?.tStat != null && ` · t-statistic ${paper.tStat.toFixed(2)} (needs ${PAPER_REQUIREMENT.tStat} or more)`}</p>
              <p className="text-xs text-muted-foreground">{paper?.blocked ?? `Live review needs ${PAPER_REQUIREMENT_TEXT}.${market === 'crypto' ? ' Crypto rules must also have passed the long-history backtest.' : ''}`}</p>
              {paper?.passed && mode !== 'live' && <Button size="sm" disabled={busy} variant="outline" onClick={() => { setError(''); setApproval(item); }}>Review Live approval</Button>}
            </div> : <p className="text-sm text-muted-foreground">No strategy version has passed the current research checks.</p>}
          </div>
          <details className="border-t pt-3 text-sm">
            <summary className="cursor-pointer font-medium">Run history and evidence</summary>
            <div className="mt-3 space-y-2">
              <Button size="sm" variant="outline" disabled={busy || !!current} onClick={() => void act(market, { action: 'run', kind: 'weekly' })}>Run weekly study now</Button>
              {runs.map(run => <details key={run.id} className="rounded-md border p-2">
                <summary className={`cursor-pointer ${run.status === 'failed' ? 'text-loss' : ''}`}>{time(run.created_at)} · {run.kind === 'daily' ? 'Daily' : 'Weekly'} · {labels[run.status] ?? run.status}</summary>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <p>{run.detail ?? `${run.cursor} of ${run.plan.length} checked`}</p>
                  {run.report?.data.missing?.map(row => <p className="text-loss" key={row.symbol}>{row.symbol} · {row.detail ?? 'Data was unavailable'}</p>)}
                  {run.report && <ResearchDetails report={run.report} />}
                </div>
              </details>)}
              {market === 'crypto' && !!overview.cryptoShadow?.length && <details className="rounded-md border p-2">
                <summary className="cursor-pointer">Recent Crypto shadow checks</summary>
                {overview.cryptoShadow.map(row => <p key={`${row.symbol}:${row.strategy}:${row.signal_bar}`} className="mt-1 text-xs text-muted-foreground">
                  {time(row.signal_bar)} · {row.symbol} · {row.decision === 'quiet' ? 'No signal' : row.decision} · {row.detail}
                  {typeof row.outcome?.pnlUsd === 'number' && ` · ${formatCurrency(row.outcome.pnlUsd)} simulated net`}
                </p>)}
              </details>}
            </div>
          </details>
        </section>;
      })}
    </div>
    <Dialog open={!!approval} onOpenChange={open => { if (!open && !pending) setApproval(null); }}>
      <DialogContent><form onSubmit={approve} className="space-y-4">
        <DialogHeader><DialogTitle>Approve this version for Live</DialogTitle><DialogDescription>
          {approval?.candidate?.symbol} · {approval?.candidate?.name}. Tideframe can submit real orders for this version within your limits.
        </DialogDescription></DialogHeader>
        <label className="block text-sm">Loss budget per trade (USD)<Input type="number" min="1" max="10000" step="0.01" value={budget} required onChange={e => setBudget(e.target.value)} /></label>
        <label className="block text-sm">Maximum order exposure (USD)<Input type="number" min="10" max="10000" step="0.01" value={maximum} required onChange={e => setMaximum(e.target.value)} /></label>
        <p className="text-xs text-muted-foreground">{approval?.market === 'stocks'
          ? 'Cash-stock sizing assumes the full amount plus fees could be lost.' : 'Crypto sizing includes a modeled allowance for fees and execution. A gap through the stop can increase the loss.'}</p>
        {error && <p className="text-sm text-loss" role="alert">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setApproval(null)} disabled={!!pending}>Cancel</Button>
          <Button type="submit" disabled={!!pending}>Confirm Live approval</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  </div></>;
}
