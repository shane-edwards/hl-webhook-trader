import { Header } from '@/components/layout/Header';
import report from '@/lib/stocks/opening-evidence.json';
import { OPENING_RULES } from '@/lib/stocks/opening-research';

function bps(n: number | null) {
  return n == null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

export default function OpeningResearchPage() {
  const qualified = report.rows.filter(row => row.paperCandidate).length;
  return (
    <div className="flex flex-col min-h-full">
      <Header />
      <div className="p-4 lg:p-8 w-full max-w-[1400px] mx-auto space-y-5">
        <section className="surface p-4 lg:p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Opening volume as a stock selector</h2>
            <p className="text-sm text-muted-foreground">{report.coverage.length - 1} US stocks on eToro. {qualified} setups qualified for forward paper testing.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[950px] text-sm tabular-nums">
              <caption className="text-left text-xs text-muted-foreground pb-2">Average basis points per trade · 10 bps = 0.10%</caption>
              <thead><tr>{['Setup', '2025 net', '2026 H1 net', 'Holdout gross', 'Holdout net', 'Higher costs', 'CFD costs', 'Holdout trades', 'Verdict'].map((label, i) => <th key={label} scope="col" className={`p-2 border-b border-border text-xs text-muted-foreground ${i ? 'text-right' : 'text-left'}`}>{label}</th>)}</tr></thead>
              <tbody>{report.rows.map(row => {
                const hold = row.stages[2];
                return <tr key={row.id} className="border-b border-border last:border-0">
                  <th scope="row" className="p-2 font-medium text-left">{OPENING_RULES.find(rule => rule.id === row.id)?.name}</th>
                  <td className="p-2 text-right">{bps(row.stages[0].netBps)}</td><td className="p-2 text-right">{bps(row.stages[1].netBps)}</td>
                  <td className="p-2 text-right">{bps(hold.grossBps)}</td><td className="p-2 text-right">{bps(hold.netBps)}</td>
                  <td className="p-2 text-right">{bps(hold.stressBps)}</td><td className="p-2 text-right">{bps(hold.cfdBps)}</td>
                  <td className="p-2 text-right">{hold.trades}</td><td className="p-2 text-right">{row.diagnostic ? 'Comparison' : row.paperCandidate ? 'Paper candidate' : 'Failed screen'}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">The holdout runs from July 1 through November 20, 2026. The CFD and higher-cost columns use the same holdout trades. Gross uses bid prices before spread and fees. The five-minute comparison uses the five stocks from the prior study.</p>
        </section>
        <section className="surface p-4 lg:p-6 space-y-3">
          <h2 className="text-lg font-semibold">What the study models</h2>
          <p className="text-sm text-muted-foreground">After the first regular-session bar, select up to three stocks by current opening volume against their last 14 opens. The control uses usual dollar volume. Compare a full-session breakout, a 90-minute exit, a 90-minute entry at the next ask, and a SPY trend filter. The next-ask variant uses a timed exit.</p>
          <p className="text-sm text-muted-foreground">The $10,000 budget is split across the strategy’s slots. Stock costs include the spread, $1 per side, and 2 bps extra slippage. Higher costs use $2 and 5 bps. The CFD comparison uses a 15 bps charge and 2 bps slippage per side. Stop-based tests take an adverse fill when the entry and stop share an ambiguous candle.</p>
          <details className="text-sm">
            <summary className="text-primary cursor-pointer">Symbols and data coverage</summary>
            <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 mt-2 text-xs text-muted-foreground">{report.coverage.map(row => <li key={row.symbol}>{row.symbol} · {row.complete} sessions</li>)}</ul>
          </details>
          <p className="text-xs text-muted-foreground">This adapts a published strategy to a fixed set of currently listed eToro stocks, using long positions and a smaller set of signals. <a className="text-primary underline" href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284" target="_blank" rel="noreferrer">Read the original opening-range study</a>.</p>
        </section>
      </div>
    </div>
  );
}
