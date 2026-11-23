import Link from 'next/link';
import { Header } from '@/components/layout/Header';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { FACTOR_SOURCES } from '@/lib/stocks/factor-research';
import evidence from '@/lib/stocks/factor-evidence.json';
import replication from '@/lib/stocks/factor-replication.json';

const number = (value: number | null) => value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
const pct = (n: number, d: number) => d ? (100 * n / d).toFixed(0) + '%' : '—';

export default function StockFactorsPage() {
  const lead = evidence.rows.find(r => r.family === 'earnings')!;
  const leadLater = lead.stages[2];
  const total = evidence.rows.reduce((count, r) => count + r.tested, 0);
  const replayRows = [
    ['Original universe · 2026 H2', leadLater],
    ['Separate universe · to close', replication.result],
    ['Separate universe · 60 minutes', replication.shortResult],
    ['Original universe · gaps without a matched filing', evidence.otherGapControl],
  ] as const;
  return (
    <div className="flex flex-col min-h-full">
      <Header />
      <div className="p-4 lg:p-8 w-full max-w-[1400px] mx-auto space-y-5">
        <section className="surface p-4 lg:p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Earnings gap-down rebound</h2>
            <p className="text-sm text-muted-foreground">Experimental strategy · limited sample</p>
          </div>
          <p className="text-sm text-muted-foreground">After a public earnings filing, require a gap down of at least 1% relative to SPY. Use the 10 a.m. ask with an entry spread of at most 10 bps. The main test exits at the closing bid. The short comparison exits after 60 minutes.</p>
          <p className="text-xs text-muted-foreground">The executable rule attempts to exit at 3:50 p.m. ET to leave time before the closing bell. The results below used the closing bid.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" asChild><Link href={stockHref('trade', { rule: 'earnings-rebound' })}>Review in Trade</Link></Button>
            <Button size="sm" variant="outline" asChild><Link href={stockHref('autopilot', { rule: 'earnings-rebound' })}>Open in Autopilot</Link></Button>
          </div>
          <div className="overflow-x-auto"><table className="min-w-[650px] w-full text-sm tabular-nums">
            <caption className="text-left text-xs text-muted-foreground pb-2">Average net basis points per trade · 10 bps = 0.10%</caption>
            <thead><tr>{['Sample', 'Trades', 'Active days', 'Net bps', 'Higher-cost bps'].map((label, i) => <th key={label} scope="col" className={`p-2 border-b border-border text-xs text-muted-foreground ${i ? 'text-right' : 'text-left'}`}>{label}</th>)}</tr></thead>
            <tbody>{replayRows.map(([label, row]) => (
              <tr key={label} className="border-b border-border last:border-0"><th scope="row" className="p-2 text-left font-medium">{label}</th><td className="p-2 text-right">{row.trades}</td><td className="p-2 text-right">{row.activeDays}</td><td className="p-2 text-right">{number(row.netBps)}</td><td className="p-2 text-right">{number(row.stressBps)}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="text-xs text-muted-foreground">The separate sample uses {replication.symbols.length - replication.unavailable.length} different stocks and {replication.events} matched filings from {replication.from} to November 20, 2026. Both samples share market days. The replication changes the stocks while keeping the rule fixed.</p>
          <p className="text-xs text-muted-foreground">To qualify, the replication needs at least 30 trades, 20 active days, five profitable stocks, and a positive result under higher costs in both periods.</p>
          {replication.result.interval95Bps && <p className="text-xs text-muted-foreground">Resampling whole trading days gives a 95% interval of {number(replication.result.interval95Bps[0])} to {number(replication.result.interval95Bps[1])} bps for the separate sample’s average net trade.</p>}
          <details className="text-sm"><summary className="text-primary cursor-pointer">Replication by period and ticker coverage</summary>
            <p className="mt-2 text-xs text-muted-foreground">Q2 · {replication.q2.trades} trades · {number(replication.q2.netBps)} net bps. H2 · {replication.h2.trades} trades · {number(replication.h2.netBps)} net bps.</p>
            <p className="mt-2 text-xs text-muted-foreground">{replication.symbols.join(', ')}</p>
            {!!replication.unavailable.length && <p className="mt-2 text-xs text-muted-foreground">No unique broker match for {replication.unavailable.join(', ')}.</p>}
          </details>
        </section>
        <section className="surface p-4 lg:p-6 space-y-4">
          <h2 className="text-lg font-semibold">Three signal families</h2>
          <p className="text-sm text-muted-foreground">{total} variants screened across earnings gaps, short-term reversals and the final half-hour. The later sample was checked on one pre-screen choice per family.</p>
          <div className="overflow-x-auto"><table className="min-w-[830px] w-full text-sm tabular-nums">
            <thead><tr>{['Rule', '2025 before costs', '2026 Q2 net', '2026 H2 net', 'Later, higher costs', 'Later trades'].map((label, i) => <th key={label} scope="col" className={`p-2 border-b border-border text-xs text-muted-foreground ${i ? 'text-right' : 'text-left'}`}>{label}</th>)}</tr></thead>
            <tbody>{evidence.rows.map(row => <tr key={row.family} className="border-b border-border last:border-0">
              <th scope="row" className="p-2 text-left font-medium">{row.rule.name}</th><td className="p-2 text-right">{number(row.stages[0].grossBps)}</td><td className="p-2 text-right">{number(row.stages[1].netBps)}</td><td className="p-2 text-right">{number(row.stages[2].netBps)}</td><td className="p-2 text-right">{number(row.stages[2].stressBps)}</td><td className="p-2 text-right">{row.stages[2].trades}</td>
            </tr>)}</tbody>
          </table></div>
          <p className="text-xs text-muted-foreground">When no rule passed the earlier screen, the later result is a diagnostic. Cash fills use eToro’s quoted ask and bid, plus 2 bps extra slippage and $1 per side on a $5,000 slot. Higher costs use 5 bps and $2 per side.</p>
        </section>
        <section className="surface p-4 lg:p-6 space-y-3">
          <h2 className="text-lg font-semibold">Quote quality</h2>
          <ul className="grid gap-3 sm:grid-cols-3">{evidence.quoteAudit.map(row => <li key={row.label} className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">{row.label}</p><p className="text-muted-foreground">{row.medianBps.toFixed(1)} bps median spread</p><p className="text-xs text-muted-foreground">{pct(row.underTen, row.count)} at 10 bps or less</p>
          </li>)}</ul>
          <p className="text-xs text-muted-foreground">The 2025 quotes were much wider. That period is used to examine the price signal. Realistic, spread-limited tests are reported separately for 2026.</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-2 text-xs">{FACTOR_SOURCES.map(source => <li key={source.family}><a className="text-primary underline" href={source.url} target="_blank" rel="noreferrer">{source.name}</a></li>)}</ul>
        </section>
      </div>
    </div>
  );
}
