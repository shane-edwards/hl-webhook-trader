import type { ComparisonSummary } from '@/lib/automation/crypto-paper-comparison';

const pct = (v: number) => `${(100 * v).toFixed(2)}%`;
export function CryptoPaperComparison({ result, paused }: { result?: ComparisonSummary | null; paused: boolean }) {
  return <details className="surface px-4 py-3">
    <summary className="cursor-pointer text-sm font-semibold">Compare crypto paper portfolios</summary>
    {!result ? <p className="mt-3 text-sm text-muted-foreground">{result === undefined ? 'Comparison unavailable.' : paused ? 'Paper entries paused.' : 'Waiting for the first scan.'}</p> : <div className="mt-4 space-y-4">
      <p className="text-xs text-muted-foreground">{result.capital.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0})} each · {result.riskPct}% total stop risk · {result.signals} signals
        {result.pending > 0 && ` · ${result.pending} pending`}</p>
      {paused && <p className="text-xs">New paper entries paused.</p>}
      {result.missing.length > 0 && <p className="text-xs">Waiting for {result.missing.join(', ')} signal data.</p>}
      <table className="w-full text-right text-sm tabular-nums"><thead><tr className="border-b">
        <th scope="col" className="py-2 text-left">Portfolio</th><th scope="col">One position</th><th scope="col">Shared budget</th>
      </tr></thead><tbody>
        {([['Net return',pct(result.one.net),pct(result.shared.net)],['Largest drop',pct(result.one.drawdown),pct(result.shared.drawdown)],
          ['Open positions',result.one.open,result.shared.open],['Closed trades',result.one.closed,result.shared.closed],
          ['Skipped entries',result.one.skipped,result.shared.skipped]] as const).map(([label,a,b]) =>
          <tr key={label} className="border-b last:border-0"><th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">{label}</th><td>{a}</td><td>{b}</td></tr>)}
      </tbody></table>
      {result.recent.length > 0 && <details><summary className="cursor-pointer text-sm">Recent signals</summary>
        <ul className="divide-y">{result.recent.map(e => <li key={e.id} className="py-2 text-xs">
          <p className="font-medium">{e.symbol} · {e.name} · {new Date(e.at).toLocaleString()}</p>
          <p>One position · {e.one} / Shared budget · {e.shared}</p><p>Signal return · {e.net == null ? 'Open' : pct(e.net)}</p>
        </li>)}</ul></details>}
      {result.trials.length > 0 && <details><summary className="cursor-pointer text-sm">Independent strategy results</summary>
        <ul className="divide-y">{result.trials.map(t => <li key={t.symbol + t.name} className="py-2 text-xs">{t.symbol} · {t.name}
          <span className="block text-muted-foreground">{t.closed} of {t.count} signals closed · {t.closed ? pct(t.totalReturn / t.closed) : '—'} average net return</span>
        </li>)}</ul></details>}
      <p className="text-xs text-muted-foreground">Simulated fills include fees, slippage and funding. Updated {new Date(result.through).toLocaleString()}.</p>
    </div>}
  </details>;
}
