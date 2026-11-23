'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import report from '@/lib/scalp-study-evidence.json';
import { SCALP_MARKETS, SCALP_RULES, type ScalpInterval, type ScalpMarket, type summarizeScalps } from '@/lib/scalp-study';

type Replay = {
  coin: ScalpMarket; interval: ScalpInterval; from: string; to: string;
  results: (ReturnType<typeof summarizeScalps> & { id: string })[];
};

function Bps({ value }: { value: number | null }) {
  if (value == null) return <>—</>;
  return <span className={value > 0 ? 'text-success' : value < 0 ? 'text-destructive' : ''}>{value > 0 ? '+' : ''}{value.toFixed(1)}</span>;
}

const selectClass = 'rounded-md border border-border bg-background px-3 py-2 text-sm';

export default function ScalpingPage() {
  const [interval, setInterval] = useState<ScalpInterval>('5m');
  const [coin, setCoin] = useState<ScalpMarket>('BTC');
  const [replay, setReplay] = useState<Replay | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const count = report.results.filter(row => row.paperCandidate).length;
  const results = report.results.filter(row => row.interval === interval);

  async function run() {
    setRunning(true);
    setError('');
    setReplay(null);
    try {
      const response = await fetch(`/api/lab/scalp?coin=${coin}&interval=${interval}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Replay failed');
      setReplay(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Replay failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header actions={<Button asChild variant="outline" size="sm"><Link href="/lab">Strategy Lab</Link></Button>} />
      <div className="p-4 lg:p-8 space-y-5 w-full max-w-[1400px] mx-auto">
        <section className="surface p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Candidate results</h2>
              <p className="text-sm text-muted-foreground mt-1">{count} of {report.results.length} variants qualified for forward paper testing. Study through {report.generatedAt.slice(0, 10)}.</p>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <label htmlFor="scalp-interval">Candle interval</label>
              <select id="scalp-interval" className={selectClass} value={interval} disabled={running} onChange={e => { setInterval(e.target.value as ScalpInterval); setReplay(null); setError(''); }}>
                <option value="5m">5 minutes</option><option value="15m">15 minutes</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[740px] text-sm tabular-nums">
              <caption className="text-left text-xs text-muted-foreground pb-2">Average net basis points per trade. 10 basis points = 0.10%.</caption>
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="text-left p-2">Strategy</th>
                  {results[0].slices.map(slice => <th key={slice.label} scope="col" className="text-right p-2">{slice.label}</th>)}
                  <th scope="col" className="text-right p-2">Hyperliquid</th>
                  <th scope="col" className="text-right p-2">Higher costs</th>
                  <th scope="col" className="text-right p-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {results.map(row => (
                  <tr key={row.id} className="border-b border-border last:border-b-0">
                    <th scope="row" className="text-left p-2 font-medium">{SCALP_RULES.find(rule => rule.id === row.id)?.name}</th>
                    {row.slices.map(slice => <td key={slice.label} className="text-right p-2"><Bps value={slice.netBps} /></td>)}
                    <td className="text-right p-2"><Bps value={row.recent.netBps} /> <span className="block text-xs text-muted-foreground">{row.recent.trades} trades</span></td>
                    <td className="text-right p-2"><Bps value={row.recent.stressBps} /></td>
                    <td className="text-right p-2">{row.paperCandidate ? 'Paper candidate' : 'Failed screen'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">The three historical periods use Binance USDⓈ‑M BTC, ETH and SOL perps through October 2026. The Hyperliquid check uses {results[0].recent.from.slice(0, 10)} to {results[0].recent.to.slice(0, 10)} UTC on the same markets.</p>
        </section>

        <section className="surface p-4 lg:p-6 space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Replay recent Hyperliquid candles</h2>
              <p className="text-sm text-muted-foreground mt-1">Compare the market move, trading costs and net result for each setup on one coin.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 text-sm">
                <label htmlFor="scalp-market">Market</label>
                <select id="scalp-market" className={selectClass} value={coin} disabled={running} onChange={e => { setCoin(e.target.value as ScalpMarket); setReplay(null); setError(''); }}>
                  {SCALP_MARKETS.map(symbol => <option key={symbol}>{symbol}</option>)}
                </select>
              </div>
              <Button onClick={run} disabled={running}>{running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Replaying</> : `Run ${interval} replay`}</Button>
            </div>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {replay && <div aria-live="polite" className="space-y-3">
            <p className="text-xs text-muted-foreground">{replay.coin} · {replay.interval} · {replay.from.slice(0, 10)} to {replay.to.slice(0, 10)} UTC · average basis points per trade</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm tabular-nums">
                <thead className="border-b border-border text-xs text-muted-foreground"><tr>{['Strategy', 'Trades', 'Gross', 'Costs', 'Net', 'Higher costs'].map((label, i) => <th key={label} scope="col" className={`p-2 ${i === 0 ? 'text-left' : 'text-right'}`}>{label}</th>)}</tr></thead>
                <tbody>{replay.results.map(row => <tr key={row.id} className="border-b border-border last:border-b-0">
                  <th scope="row" className="text-left p-2 font-medium">{SCALP_RULES.find(rule => rule.id === row.id)?.name}</th>
                  <td className="text-right p-2">{row.trades}</td>
                  <td className="text-right p-2"><Bps value={row.grossBps} /></td>
                  <td className="text-right p-2">{row.costBps?.toFixed(1) ?? '—'}</td>
                  <td className="text-right p-2"><Bps value={row.netBps} /></td>
                  <td className="text-right p-2"><Bps value={row.stressBps} /></td>
                </tr>)}</tbody>
              </table>
            </div>
          </div>}
        </section>

        <section className="surface p-4 lg:p-6 space-y-3">
          <h2 className="text-lg font-semibold">Rules and fill assumptions</h2>
          <ul className="grid gap-3 lg:grid-cols-3">
            {SCALP_RULES.map(rule => <li key={rule.id} className="rounded-lg border border-border p-3">
              <a className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline" href={rule.source} target="_blank" rel="noreferrer">{rule.name}<ExternalLink className="h-3 w-3" /></a>
              <p className="mt-1 text-sm text-muted-foreground">{rule.description}</p>
            </li>)}
          </ul>
          <p className="text-xs text-muted-foreground leading-relaxed">These rules adapt the linked concepts for 24-hour crypto perps. Signals need 1.5× recent volume. Entries use the next open, a 1.5 ATR stop and a 2.25 ATR target, with a 60-minute time exit. Fills model 4.5 bps in fees and 2 bps in slippage per side, plus 3 bps on stops and a 1 bp hourly funding allowance. Higher costs add 3 bps per side. When both price levels are touched in one candle, the stop takes priority.</p>
        </section>
      </div>
    </div>
  );
}
