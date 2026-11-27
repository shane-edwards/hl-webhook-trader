'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, Grid3x3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CellStatus, PaperCell, PaperLine, PaperMatrix as Matrix } from '@/lib/automation/paper-matrix';

const money = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2)}`;
const tone = (v: number) => (v > 0 ? 'text-profit' : v < 0 ? 'text-loss' : 'text-muted-foreground');

const STATUS: Record<CellStatus, string> = {
  qualified: 'Meets the Paper requirement',
  ahead: 'In profit so far',
  behind: 'Losing so far',
  'over-drawdown': 'Over the drawdown limit',
  'did-not-qualify': 'Enough trades, but did not qualify',
  'open-only': 'No closed trades yet',
};

/** Green or red, stronger the further the result is from zero relative to the largest on the page. */
function tint(net: number, largest: number) {
  if (!net || !largest) return undefined;
  const strength = 10 + Math.round(30 * Math.min(1, Math.abs(net) / largest));
  return { backgroundColor: `color-mix(in srgb, ${net > 0 ? '#22c55e' : '#ef4444'} ${strength}%, transparent)` };
}

function Detail({ line, cell, matrix }: { line: PaperLine; cell: PaperCell; matrix: Matrix }) {
  const need = matrix.requirement;
  const checks: Array<[string, string, boolean]> = [
    ['Closed trades', `${Math.min(cell.closed, need.trades)} of ${need.trades}`, cell.closed >= need.trades],
    ['Different dates', `${cell.days} of ${need.dates}`, cell.days >= need.dates],
    ['Net result', money(cell.net), cell.net > 0],
    ['Largest drop', `$${cell.drawdown.toFixed(2)} (limit $${need.maxDrawdownUsd})`, cell.drawdown <= need.maxDrawdownUsd],
    ['Unlikely to be luck', cell.tStat == null ? 'Not enough trades to tell' : `t-statistic ${cell.tStat.toFixed(2)} (needs ${need.tStat})`, cell.tStat != null && cell.tStat >= need.tStat],
  ];
  const tested = matrix.backtestCoins.includes(cell.symbol);
  return (
    <div className="border-t border-border/70 px-4 py-4 sm:px-5" aria-live="polite">
      <h3 className="text-sm font-semibold">{line.name} · {line.side === 'long' ? 'Long' : 'Short'} · {cell.symbol}</h3>
      <p className={cn('mt-0.5 text-sm', cell.status === 'qualified' ? 'text-profit' : 'text-muted-foreground')}>
        {STATUS[cell.status]}. {cell.closed ? `${cell.wins} of ${cell.closed} closed trades made money.` : ''} {cell.open ? `${cell.open} still open.` : ''}
      </p>
      <ul className="mt-3 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        {checks.map(([label, value, met]) => (
          <li key={label} className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className="tabular-nums">{value} <span className={met ? 'text-profit' : 'text-muted-foreground'}>{met ? '✓' : '·'}</span></span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Backtest for this rule and direction: {line.backtest === 'passed' ? 'passed' : line.backtest === 'failed' ? 'did not pass' : 'not run'}.
        {tested ? '' : ` It covered ${matrix.backtestCoins.join(', ')} only, so ${cell.symbol} has no backtest of its own.`}
        {cell.closed > need.trades ? ` Only the most recent ${need.trades} closed trades are judged.` : ''}
      </p>
    </div>
  );
}

/** Crypto paper results as a strategy-by-coin grid: colour for profit or loss, and progress toward the Paper requirement. */
export function PaperMatrix({ refresh }: { refresh?: number }) {
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<{ rule: string; side: string; symbol: string } | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/paper-matrix', { cache: 'no-store' }).then(async r => {
      const data = await r.json().catch(() => null);
      if (!live) return;
      if (!r.ok || !data?.lines) { setError(data?.error ?? 'Could not load the paper results.'); return; }
      setError(''); setMatrix(data);
    }).catch(() => { if (live) setError('Could not load the paper results.'); });
    return () => { live = false; };
  }, [refresh]);

  if (error && !matrix) return <section className="surface p-5 text-sm text-destructive" role="alert">{error}</section>;
  if (!matrix || !matrix.totals.pairs) return null;

  const lines = matrix.lines.filter(line => line.closed || line.open);
  const largest = Math.max(...lines.flatMap(line => Object.values(line.cells).map(cell => Math.abs(cell.net))), 0);
  const line = picked && lines.find(l => l.rule === picked.rule && l.side === picked.side);
  const cell = line && picked ? line.cells[picked.symbol] : undefined;
  const t = matrix.totals;

  return (
    <section className="surface overflow-hidden" aria-label="Paper results by strategy and coin">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Grid3x3 className="text-primary" size={18} />Paper results</h2>
          <span className={cn('text-lg font-semibold tabular-nums', tone(t.net))}>{money(t.net)}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span><span className="font-semibold text-profit">{t.profitable}</span> <span className="text-muted-foreground">in profit</span></span>
          <span><span className="font-semibold text-loss">{t.losing}</span> <span className="text-muted-foreground">losing</span></span>
          <span><span className={cn('font-semibold', t.qualified ? 'text-profit' : '')}>{t.qualified}</span> <span className="text-muted-foreground">ready for Live review</span></span>
        </div>
      </div>
      <div className="overflow-x-auto border-t border-border/70">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground sm:px-5">Strategy</th>
              {matrix.symbols.map(symbol => <th key={symbol} scope="col" className="px-1 py-2 text-center text-xs font-medium text-muted-foreground">{symbol}</th>)}
              <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-muted-foreground">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(row => (
              <tr key={`${row.rule}-${row.side}`}>
                <th scope="row" className="sticky left-0 z-10 bg-card border-t border-border/50 px-3 py-2 text-left font-medium sm:px-5">
                  <span className="block whitespace-nowrap">{row.name}</span>
                  <span className="block whitespace-nowrap text-xs font-normal text-muted-foreground">{row.side === 'long' ? 'Long' : 'Short'}</span>
                </th>
                {matrix.symbols.map(symbol => {
                  const c = row.cells[symbol];
                  if (!c) return <td key={symbol} className="border-t border-border/50 px-1 py-1 text-center text-muted-foreground/40">·</td>;
                  const active = picked?.rule === row.rule && picked.side === row.side && picked.symbol === symbol;
                  return (
                    <td key={symbol} className="border-t border-border/50 p-1">
                      <button type="button" onClick={() => setPicked(active ? null : { rule: row.rule, side: row.side, symbol })} aria-pressed={active}
                        aria-label={`${row.name} ${row.side} on ${symbol}: ${c.closed ? money(c.net) : 'no closed trades'}, ${c.closed} of ${matrix.requirement.trades} closed trades. ${STATUS[c.status]}.`}
                        style={tint(c.net, largest)}
                        className={cn('flex min-w-[4.25rem] flex-col items-center rounded-md px-1.5 py-1.5 tabular-nums transition-shadow hover:ring-1 hover:ring-border',
                          active && 'ring-2 ring-primary hover:ring-primary', c.status === 'qualified' && 'ring-1 ring-profit')}>
                        <span className={cn('flex items-center gap-1 text-[13px] font-semibold leading-tight', tone(c.net))}>
                          {c.status === 'qualified' && <CircleCheck size={12} aria-hidden="true" />}{c.closed ? money(c.net) : 'open'}
                        </span>
                        {/* How far along it is: closed trades toward the number needed. */}
                        <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-foreground/10" aria-hidden="true">
                          <span className="block h-full rounded-full bg-foreground/50" style={{ width: `${Math.min(100, (c.closed / matrix.requirement.trades) * 100)}%` }} />
                        </span>
                      </button>
                    </td>
                  );
                })}
                <td className={cn('border-t border-border/50 px-3 py-2 text-right font-semibold tabular-nums whitespace-nowrap', tone(row.net))}>
                  {row.closed ? money(row.net) : '—'}
                  <span className="block text-[11px] font-normal text-muted-foreground">{row.closed} trades</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {line && cell && <Detail line={line} cell={cell} matrix={matrix} />}
    </section>
  );
}
