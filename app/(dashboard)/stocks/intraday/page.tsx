'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { STOCKS, type StockSymbol } from '@/lib/stocks/research';
import { STOCK_INTRADAY_RULES, type summarizeIntraday } from '@/lib/stocks/intraday';
import report from '@/lib/stocks/intraday-evidence.json';

type Replay = { symbol: StockSymbol; from: string; to: string; sessions: number; results: Array<ReturnType<typeof summarizeIntraday> & { id: string }> };
const bps = (value: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}`;

export default function StockIntradayPage() {
  const [symbol, setSymbol] = useState<StockSymbol>('SPY');
  const [result, setResult] = useState<Replay | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qualified = report.results.filter(r => r.paperCandidate).length;

  async function replay() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch(`/api/stocks?view=intraday&symbol=${symbol}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Replay failed');
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header actions={<Button asChild variant="outline" size="sm"><Link href="/stocks">US Stocks</Link></Button>} />
      <div className="p-4 lg:p-8 space-y-5 w-full max-w-[1400px] mx-auto">
        <section className="surface p-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">Earnings and reversal research</h2><p className="text-sm text-muted-foreground">Test public SEC filing events and compare the same rule on a separate stock universe.</p></div>
          <Button asChild size="sm" variant="outline"><Link href="/stocks/factors">View earnings study</Link></Button>
        </section>
        <section className="surface p-4 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="font-semibold">Broader opening-volume study</h2><p className="text-sm text-muted-foreground">Compare daily stock selection and broker costs across 17 US stocks.</p></div>
          <Button asChild size="sm" variant="outline"><Link href="/stocks/opening">View opening study</Link></Button>
        </section>
        <section className="surface p-4 lg:p-6 space-y-4">
          <div><h2 className="text-lg font-semibold">Intraday strategy results</h2>
            <p className="text-sm text-muted-foreground">{qualified} of {report.results.length} setups qualified for forward paper testing. eToro data from {report.from} to {report.coverage[0].last}.</p></div>
          <div className="overflow-x-auto">
            <table className="min-w-[730px] w-full text-sm tabular-nums">
              <caption className="text-left pb-2 text-xs text-muted-foreground">Average net basis points per trade · 10 bps = 0.10%</caption>
              <thead><tr>{['Setup', ...report.results[0].stages.map(p => p.label), 'Holdout, higher costs', 'Holdout trades', 'Research verdict'].map((label, i) => <th key={label} scope="col" className={`p-2 border-b border-border text-xs text-muted-foreground ${i === 0 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
              <tbody>{report.results.map(row => <tr key={row.id} className="border-b border-border last:border-0">
                <th scope="row" className="p-2 font-medium text-left">{STOCK_INTRADAY_RULES.find(rule => rule.id === row.id)?.name}</th>
                {row.stages.map(p => <td className="p-2 text-right" key={p.label}>{bps(p.netBps)}</td>)}
                <td className="p-2 text-right">{bps(row.stages[2].stressBps)}</td>
                <td className="p-2 text-right">{row.stages[2].trades}</td>
                <td className="p-2 text-right">{row.paperCandidate ? 'Paper candidate' : 'Failed screen'}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Opening and VWAP rules use {report.coverage.map(c => c.symbol).join(', ')}. Two momentum rules test SPY alone. Returns describe individual trades without a shared capital budget.</p>
          <details className="text-sm"><summary className="cursor-pointer text-primary">Holdout by stock and candle coverage</summary>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{report.coverage.map(c => <li key={c.symbol}>{c.symbol} · {c.complete} complete sessions · {c.incomplete} sessions with missing paired bars</li>)}</ul>
            <ul className="mt-3 space-y-1 text-xs">{report.results.map(r => <li key={r.id}>{STOCK_INTRADAY_RULES.find(s => s.id === r.id)?.name} · {r.stages[2].markets.map(m => `${m.symbol} ${bps(m.netBps)} bps (${m.trades})`).join(' · ')}</li>)}</ul>
          </details>
        </section>

        <section className="surface p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap gap-3 items-end justify-between">
            <div><h2 className="text-lg font-semibold">Replay recent eToro sessions</h2><p className="text-sm text-muted-foreground">Run the same rules on one ticker over the last 28 calendar days.</p></div>
            <div className="flex items-end gap-2">
              <div><label htmlFor="intradaySymbol" className="block text-xs text-muted-foreground pb-1">Stock</label>
                <select id="intradaySymbol" value={symbol} disabled={busy} onChange={e => { setSymbol(e.target.value as StockSymbol); setResult(null); setError(''); }} className="rounded-md border border-border bg-background h-9 px-3 text-sm">
                  {STOCKS.map(stock => <option key={stock}>{stock}</option>)}
                </select></div>
              <Button size="sm" disabled={busy} onClick={replay}>{busy ? 'Replaying…' : 'Run 5-minute replay'}</Button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {result && <div aria-live="polite" className="overflow-x-auto">
            <table className="min-w-[500px] w-full text-sm tabular-nums">
              <caption className="text-left pb-2 text-xs text-muted-foreground">{result.symbol} · {result.from} to {result.to} · {result.sessions} complete sessions</caption>
              <thead><tr>{['Setup', 'Trades', 'Avg. minutes', 'Net bps', 'Higher costs bps'].map((label, i) => <th key={label} scope="col" className={`p-2 border-b border-border text-xs text-muted-foreground ${i === 0 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
              <tbody>{result.results.map(row => <tr key={row.id} className="border-b border-border last:border-0">
                <th scope="row" className="p-2 text-left font-medium">{STOCK_INTRADAY_RULES.find(rule => rule.id === row.id)?.name}</th>
                <td className="p-2 text-right">{row.trades}</td><td className="p-2 text-right">{row.averageMinutes?.toFixed(0) ?? '—'}</td><td className="p-2 text-right">{bps(row.netBps)}</td><td className="p-2 text-right">{bps(row.stressBps)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </section>

        <section className="surface p-4 lg:p-6 space-y-3">
          <h2 className="text-lg font-semibold">Rules and costs</h2>
          <ul className="grid gap-3 md:grid-cols-2">{STOCK_INTRADAY_RULES.map(rule => <li key={rule.id} className="rounded-lg border border-border p-3">
            <a className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" href={rule.source} target="_blank" rel="noreferrer">{rule.name}<ExternalLink className="h-3 w-3" /></a>
            <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
          </li>)}</ul>
          <p className="text-xs text-muted-foreground">Long-only research with next-bar ask entries. Stops and targets use the bid, including an opening gap through a stop. If both trigger in one candle, take the stop. Opening and VWAP setups hold up to 60 minutes. The base case adds 2 bps of slippage and $1 per side on $10,000. Higher costs use 5 bps and $2 per side. These are modeled fills.</p>
        </section>
      </div>
    </div>
  );
}
