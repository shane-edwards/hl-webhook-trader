'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { journeyHref } from '@/components/layout/journey';
import { stockHref } from '@/components/layout/workspaces';
import type { Evidence } from '@/lib/automation/model';
import { paperTradingStatus, RULE_INTERPRETER_VERSION, ruleKey, ruleName, searchOutcomes, searchPair, type SearchMarket, type SearchPair, type SearchReport, type SearchFrame } from '@/lib/strategy-search/model';

type SearchState = { status: string; report: SearchReport | null; canStart: boolean; fresh: boolean; completedAt: string | null; detail?: string };
export const frameNames: Record<SearchFrame, string> = { '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '4h': '4 hours', '1d': 'Daily' };
type Recommendation = { id: string; evidence: Evidence };

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

function researchStatus(payload: SearchState | null) {
  if (!payload) return 'Checking research…';
  if (payload.status === 'unsupported') return 'Research unavailable for this timeframe';
  if (payload.status === 'connect') return 'Waiting for eToro market data';
  if (payload.status === 'paused') return 'Automatic research paused';
  if (payload.status === 'failed') return 'Data unavailable · Tideframe will retry';
  if (payload.status === 'busy' || payload.status === 'queued') return 'Queued for automatic testing';
  if (payload.status === 'running') return 'Automatic backtest running';
  if (payload.status === 'new') return 'Waiting for the first automatic backtest';
  if (payload.report?.verdict === 'insufficient-history') return 'Waiting for more price history';
  if (payload.report?.verdict === 'venue-failed') return 'No setup passed the Hyperliquid check';
  if (payload.report?.verdict === 'holdout-failed') return 'No setup passed on later data';
  if (payload.report?.verdict === 'paper-candidate') {
    if (!payload.fresh) return 'Older backtest · Refresh due';
    const rule = payload.report.rule;
    const book = rule && payload.report.forward?.find(b => b.version === RULE_INTERPRETER_VERSION && ruleKey(b.rule) === ruleKey(rule));
    return paperTradingStatus(book?.count, book?.state);
  }
  return payload.report ? 'No setup passed the backtest' : 'Waiting for research results';
}

export function StrategySearch({ market, symbol, frame, active = true, compact = false, recommendation, selectedRule }: {
  market: SearchMarket; symbol: string; frame: SearchFrame; active?: boolean; compact?: boolean; recommendation?: Recommendation;
  selectedRule?: string | null;
}) {
  const pair = searchPair(market, symbol, frame);
  const key = pair ? `${market}/${symbol}/${frame}` : null;
  const [data, setData] = useState<{ key: string; payload: SearchState }>();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !key) return;
    const match: SearchPair = { market, symbol, frame };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const request = async (initial = false) => {
      try {
        const autoQueue = () => fetch('/api/strategy-search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(match), signal: controller.signal });
        const response = await (initial && !compact ? autoQueue() :
          fetch(`/api/strategy-search?${new URLSearchParams(match)}`, { signal: controller.signal, cache: 'no-store' }));
        if (!response.ok) throw new Error();
        let payload = await response.json() as SearchState;
        if (!initial && !compact && payload.canStart) {
          const queued = await autoQueue();
          if (!queued.ok) throw new Error();
          payload = await queued.json();
        }
        if (!controller.signal.aborted) { setData({ key, payload }); setFailed(null); }
      } catch {
        if (!controller.signal.aborted) setFailed(key);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void request(), 15_000);
      }
    };
    timer = setTimeout(() => void request(true), 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [market, symbol, frame, key, active, compact]);
  if (!active) return null;
  const payload = key ? data?.key === key ? data.payload : null :
    { status: 'unsupported', report: null, canStart: false, fresh: false, completedAt: null };
  const { report } = payload ?? {};
  const outcomes = report ? searchOutcomes(report) : [];
  const selected = selectedRule && outcomes.find(o => o.rule && ruleKey(o.rule) === selectedRule);
  const books = report?.forward?.filter(b => !selectedRule || ruleKey(b.rule) === selectedRule);
  const selectedBook = selectedRule ? books?.find(b => b.version === RULE_INTERPRETER_VERSION) : undefined;
  const bookState = (state: NonNullable<typeof selectedBook>['state'] | undefined) =>
    state === 'tracking' && (payload?.status === 'paused' || payload?.status === 'connect') ? 'paused' : state;
  const lead = payload?.fresh && report?.verdict === 'paper-candidate' && report.rule ? ruleName(report.rule) : null;
  const message = failed === key && key ? 'Research temporarily unavailable' : researchStatus(payload);
  const waiting = !report || report.verdict === 'insufficient-history';
  const heading = selectedRule ? (selected && selected.rule ? ruleName(selected.rule) : payload ? 'Selected strategy unavailable' : 'Loading strategy…') :
    recommendation?.evidence.name ?? lead ??
    (waiting ? 'Researching this market' : 'Wait for a stronger setup');
  return <section className={compact ? 'rounded-lg border border-border p-3 space-y-1' : 'surface p-4 sm:p-5 space-y-3'} aria-label={compact ? 'Strategy research' : 'Recommendation'}>
    {!compact && <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium text-muted-foreground">
        <span>{selectedRule ? 'Selected strategy' : 'Asset research'}</span><span>{symbol} · {frameNames[frame]}</span>
      </div>
      <h2 className="text-lg font-semibold tracking-tight">{heading}</h2>
      {selected && selected.verdict === 'paper-candidate' && <p className="text-sm font-medium">{paperTradingStatus(selectedBook?.count, bookState(selectedBook?.state))}</p>}
    </>}
    {!compact && recommendation && !selectedRule ? <div className="flex flex-wrap items-center gap-2">
      <span className="mr-auto text-sm text-profit">Passed backtest</span>
      <Button asChild variant="outline" size="sm"><Link href={journeyHref('test', market, recommendation.id)}>View results</Link></Button>
      <Button asChild size="sm"><Link href={journeyHref('trade', market, recommendation.id)}>Trade setup <ArrowRight size={15} /></Link></Button>
    </div> : (!selectedRule || failed === key) && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {!compact && payload?.status === 'connect' && <Button asChild variant="outline" size="sm"><Link href={stockHref('account')}>Connect eToro</Link></Button>}
    {!!report?.tried && <p className="text-xs text-muted-foreground">{report.tried.toLocaleString()} setups tested · Prices through {report.through}</p>}
    {report && (!selectedRule || selected) && <details key={selectedRule ?? 'all'} open={selectedRule ? true : undefined} className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium">{selectedRule ? 'Strategy results' : 'Automatic search results'}</summary>
      <div className="space-y-1 mt-2">
        {payload?.completedAt && <p>Checked {new Date(payload.completedAt).toLocaleString()}</p>}
        <p>{report.source} · {report.bars.toLocaleString()} candles{report.from && ` · From ${report.from}`}</p>
        <p>{report.validationPassed} qualified for the final test · {report.testedOnLaterData} tested on later data</p>
        {report.generation && <p>{report.generation.tried} evolved rules tested across {report.generation.uniquePairs} setup and trigger combinations · {report.generation.validated} passed validation</p>}
        {report.generation?.exactRepeats !== undefined && <p>{report.generation.exactRepeats} exact repeats · {report.generation.similar} with similar historical trades</p>}
        {report.note && !report.rule && <p>{report.note}</p>}
        {(selected ? [selected] : outcomes).map(outcome => outcome.rule && <div key={ruleKey(outcome.rule)} className="mt-2 space-y-1 border-t pt-2">
          <p className="font-medium text-foreground">{outcome.rule.side === 'short' ? 'Short' : 'Long'} · {ruleName(outcome.rule)} · {outcome.verdict === 'paper-candidate' ? 'Passed backtest' : 'Did not qualify'}</p>
          {outcome.holdout && <p>{outcome.holdout.trades} later trades · {pct(outcome.holdout.net)} after costs · {pct(outcome.stress?.net ?? 0)} with higher costs · {pct(outcome.stress?.drawdown ?? 0)} drawdown</p>}
          {outcome.venue && <p>Hyperliquid check · {outcome.venue.trades} trades · {pct(outcome.venue.net)} after costs and funding</p>}
          {outcome.robustness && <p>One-bar delay {pct(outcome.robustness.delayed.net)} · lower resampled mean per time group {pct(outcome.robustness.lowerGroupReturn)}</p>}
          {outcome.note && <p>{outcome.note}</p>}
          {outcome.verdict === 'paper-candidate' && <p>{outcome.rule.recipe ? `Confirm within ${outcome.rule.recipe.within} bars` : `${outcome.rule.setting}-bar setting`} · {outcome.rule.stop}× ATR stop · {outcome.rule.reward}× risk target · {outcome.rule.maxBars} bars max</p>}
        </div>)}
      </div>
    </details>}
    {!!books?.length && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium">Paper trading results ({books.length})</summary>
      {books.map(book => <div key={book.version + ruleKey(book.rule)} className="mt-2 space-y-1 border-t pt-2">
        <p>{book.rule.side ?? 'long'} · {ruleName(book.rule)} · {paperTradingStatus(book.count, bookState(book.state))}</p>
        <p>Started {new Date(book.started).toLocaleDateString()} · {pct(book.equity - 1)} net · {pct(book.drawdown)} realized drawdown</p>
        {book.pending && <p>Simulated entry {book.pending.price.toPrecision(6)} · stop {book.pending.stop.toPrecision(6)} · target {book.pending.target.toPrecision(6)}</p>}
        {book.recent.map(fill => <p key={fill.entry}>{new Date(fill.entry).toLocaleString()} → {new Date(fill.exit).toLocaleString()} · {pct(fill.net)}</p>)}
      </div>)}
    </details>}
  </section>;
}
