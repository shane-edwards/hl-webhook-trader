'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { researchRequest, ResearchRequestError } from '@/components/stocks/research-requests';
import { LAB_HOLDOUT, LAB_MARKETS, LAB_SYMBOLS, summarizeStockLab, type StockLabReport } from '@/lib/stocks/intraday-lab';
import { stockMarketClock } from '@/lib/stocks/session';
import firstStudy from '@/lib/stocks/intraday-lab-evidence.json';

type Market = Parameters<typeof summarizeStockLab>[0][number];
type History = { created_at: string; report: StockLabReport };
const bps = (value: number | null) => value == null ? '—' : `${value.toFixed(2)} bps`;

function LabResults({ report }: { report: StockLabReport }) {
  return <section className="surface p-4 lg:p-6 space-y-4" aria-live="polite">
    <h2 className="font-semibold">Trial results</h2>
    <p className="text-sm text-muted-foreground">{report.markets.length} markets · Validation begins {report.validationFrom} · Holdout {report.holdoutFrom} to {report.to} (exclusive) · {report.options.slipBps} bps slippage and ${report.options.fee} fee per side</p>
    {report.reports.map(row => <article key={row.rule} className="border border-border p-3 rounded-lg space-y-2">
      <div className="flex flex-wrap justify-between items-center gap-2"><h3 className="font-semibold">{row.label}</h3><span className={row.status === 'Paper candidate' ? 'text-profit' : 'text-muted-foreground'}>{row.status}</span></div>
      <p className="text-sm text-muted-foreground">Baseline · {row.baseline}</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm whitespace-nowrap">
        <thead><tr>{['Sample', 'Trades', 'Baseline trades', 'Net / trade', 'Higher cost / trade', 'Lift / session', 'Lower bound'].map(label => <th key={label} className="p-2 text-xs text-muted-foreground">{label}</th>)}</tr></thead>
        <tbody>{[
          { label: 'Earlier validation', values: row.validation },
          { label: 'Later dates', values: row.dateHoldout },
          { label: 'Reserved tickers', values: row.tickerHoldout },
        ].map(({ label, values }) => <tr key={label} className="border-t border-border">
          {[label, values.trades, values.baselineTrades, bps(values.netBps), bps(values.stressBps), bps(values.excess), bps(values.lower)]
            .map((value, i) => <td key={i} className="p-2">{value}</td>)}
        </tr>)}</tbody>
      </table></div>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Reserved ticker breakdown</summary>
        {row.tickerHoldout.marketResults.map(stock => <p key={stock.symbol} className="mt-1">{stock.symbol} · {stock.trades} trades · {stock.sessions} sessions · {bps(stock.excess)} lift per session</p>)}
      </details>
    </article>)}
  </section>;
}

export default function StockIntradayLabPage() {
  const [today] = useState(() => stockMarketClock(Date.now()).day);
  const [asOf, setDate] = useState(today);
  const [slip, setSlip] = useState('3');
  const [fee, setFee] = useState('1');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  const [report, setReport] = useState<StockLabReport | null>(firstStudy as StockLabReport);
  const [history, setHistory] = useState<History[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void researchRequest<{ history: History[] }>('/api/stocks/lab', abort.signal)
      .then(data => setHistory(data.history)).catch(() => {});
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  async function run(event: FormEvent) {
    event.preventDefault();
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setReport(null); setError(''); setMissing([]);
    try {
      const markets: Market[] = [], unavailable: string[] = [];
      const options = { slipBps: Number(slip), fee: Number(fee) };
      for (const [index, symbol] of LAB_SYMBOLS.entries()) {
        setProgress(`Replaying ${symbol} · ${index + 1} of ${LAB_SYMBOLS.length}`);
        const query = new URLSearchParams({ symbol, asOf, slipBps: slip, fee });
        try {
          const market = await researchRequest<Market>(`/api/stocks/lab?${query}`, abort.signal);
          if (market.days.length) markets.push(market);
          else unavailable.push(symbol);
        } catch (error) {
          if (abort.signal.aborted || !(error instanceof ResearchRequestError) || [401, 409].includes(error.status)) throw error;
          unavailable.push(symbol);
        }
      }
      if (!markets.length) throw new Error('No complete market samples were available.');
      setMissing(unavailable);
      const result = summarizeStockLab(markets, asOf, options);
      setReport(result);
      const response = await fetch('/api/stocks/lab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result), signal: abort.signal });
      if (!response.ok) throw new Error('The results are available, but this run could not be saved.');
      setHistory(previous => [{ report: result, created_at: new Date().toISOString() }, ...previous].slice(0, 12));
    } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : 'The study could not finish.'); }
    finally { controller.current = null; setProgress(''); }
  }

  return <><Header /><div className="p-4 lg:p-8 space-y-4 max-w-[1400px] w-full mx-auto">
    <section className="surface p-4 lg:p-6 space-y-4">
      <h2 className="font-semibold">Test intraday strategies against a baseline</h2>
      <p className="text-sm text-muted-foreground">Five-minute eToro bid and ask bars. Each trial compares the volume filter with the same setup, stop, target and exit without the filter.</p>
      <form onSubmit={run}><fieldset disabled={!!progress} className="grid grid-cols-2 gap-3 items-end sm:grid-cols-4">
        <label className="text-sm">End date (exclusive)<Input required type="date" min="2025-06-01" max={today} value={asOf} onChange={e => setDate(e.target.value)} /></label>
        <label className="text-sm">Slippage (bps each side)<Input required type="number" min="0" max="100" step="0.1" value={slip} onChange={e => setSlip(e.target.value)} /></label>
        <label className="text-sm">Fee (USD each side)<Input required type="number" min="0" max="30" step="0.01" value={fee} onChange={e => setFee(e.target.value)} /></label>
        <Button type="submit">Run paired trials</Button>
      </fieldset></form>
      {progress && <div role="status" className="text-sm flex flex-wrap items-center gap-2">{progress}<Button size="sm" variant="outline" onClick={() => controller.current?.abort()}>Cancel</Button></div>}
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {missing.length > 0 && <p className="text-sm text-loss">Unavailable markets · {missing.join(', ')}</p>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">How a trial reaches Paper candidate</summary>
        <p className="mt-2">Requires positive results under higher costs, a positive lower bound for daily lift versus the baseline, and positive lift in at least three tickers in each sample. Minimum coverage is four tickers with 15 sessions each, 20 trades and 12 active trade days per sample.</p>
        <p className="mt-2">Earlier and later samples use {LAB_MARKETS.join(', ')}. Reserved ticker results use {LAB_HOLDOUT.join(', ')} in the later period. Lift per session includes days where a rule stays in cash. The lower bound groups trades by day and applies a stricter cutoff for the two trials.</p>
      </details>
      <Button size="sm" variant="ghost" disabled={!!progress} onClick={() => { setMissing([]); setReport(firstStudy as StockLabReport); }}>View initial 12-market study</Button>
    </section>
    {report && <LabResults report={report} />}
    <section className="surface p-4 lg:p-6 space-y-2">
      <h2 className="font-semibold">Saved trials</h2>
      {history.length === 0 ? <p className="text-sm text-muted-foreground">Completed trials appear here.</p> : history.map(item => <div className="flex flex-wrap items-center justify-between gap-2" key={item.created_at}>
        <span className="text-sm">{new Date(item.created_at).toLocaleString()} · {item.report.to} · {item.report.reports.map(row => row.status).join(' / ')}</span>
        <Button size="sm" variant="outline" disabled={!!progress} onClick={() => { setMissing([]); setReport(item.report); }}>View trial</Button>
      </div>)}
    </section>
  </div></>;
}
