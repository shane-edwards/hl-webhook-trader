'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { StockBacktestResult } from '@/lib/stocks/backtest';
import { EARNINGS_REBOUND, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, supportsStockTradeRule, type StockTradeRule, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

const selectClass = 'mt-1 block w-full rounded-md border border-border bg-background px-3 h-10 text-sm';
const pct = (value: number) => `${(100 * value).toFixed(2)}%`;

export function StockBacktest({ connected, loading, initialRule = 'breakout', initialSymbol = 'AAPL' }: {
  connected: boolean; loading: boolean; initialRule?: StockTradeRule; initialSymbol?: StockTradeSymbol;
}) {
  const [rule, setRule] = useState(initialRule);
  const [preferredTicker, setTicker] = useState(initialSymbol);
  const [slipBps, setSlipBps] = useState('3');
  const [commission, setCommission] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StockBacktestResult | null>(null);
  const tickers = [...STOCK_TRADE_SYMBOLS].sort().filter(ticker => supportsStockTradeRule(rule, ticker));
  const symbol = tickers.includes(preferredTicker) ? preferredTicker : tickers[0];
  const activeRule = STOCK_TRADE_RULES.find(candidate => candidate.id === rule)!;
  const earnings = rule === EARNINGS_REBOUND.id;
  const locked = loading || busy;

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setError('');
    setBusy(true);
    try {
      const query = new URLSearchParams({ view: 'research', symbol, rule, slipBps, commission });
      const response = await fetch(`/api/stocks?${query}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not run the backtest.');
      setResult(data.result);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not run the backtest.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="surface p-4 lg:p-6 space-y-4" id="stock-backtest">
        <h2 className="text-lg font-semibold">Backtest a stock strategy</h2>
        {!loading && !connected && <p className="text-sm text-muted-foreground"><Link className="text-primary underline" href={stockHref('account')}>Connect eToro</Link> to load historical quotes.</p>}
        <form className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end" onSubmit={run}>
          <label className="text-sm">Strategy<select className={selectClass} value={rule} disabled={locked} onChange={e => { setRule(e.target.value as StockTradeRule); setResult(null); setError(''); }}>
            {STOCK_TRADE_RULES.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === EARNINGS_REBOUND.id ? ' (Experimental)' : ''}</option>)}
          </select></label>
          <label className="text-sm">Stock<select className={selectClass} value={symbol} disabled={locked} onChange={e => { setTicker(e.target.value as StockTradeSymbol); setResult(null); setError(''); }}>{tickers.map(ticker => <option key={ticker}>{ticker}</option>)}</select></label>
          <label className="text-sm">Extra slippage per side (bps)<Input className="mt-1" type="number" min="0" max="100" step="0.1" required value={slipBps} disabled={locked} onChange={e => { setSlipBps(e.target.value); setResult(null); }} /></label>
          <label className="text-sm">Commission per side (USD)<Input className="mt-1" type="number" min="0" max="30" step="0.01" required value={commission} disabled={locked} onChange={e => { setCommission(e.target.value); setResult(null); }} /></label>
          <Button type="submit" disabled={!connected || locked}>{busy ? 'Running…' : 'Run backtest'}</Button>
        </form>
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <p className="text-sm text-muted-foreground">{earnings ? 'Uses qualifying SEC earnings filings and the market-adjusted opening gap. Buys at 10:00 a.m. ET and exits at 3:50 p.m. ET.' : activeRule.description}</p>
        <p className="text-xs text-muted-foreground">$10,000 starting balance · 1× cash positions · The later sample is replayed at double the entered costs.</p>
      </section>
      {result && <section className="surface p-4 lg:p-6 space-y-4" aria-live="polite">
        <h3 className="font-semibold">{symbol} · {activeRule.name}</h3>
        <p className="text-xs text-muted-foreground">{result.from} to {result.to} · Later sample starts {result.holdoutFrom}</p>
        {result.kind === 'earnings' && <p className="text-sm text-muted-foreground">{result.windows} eligible filing windows · {result.missing} skipped for missing quotes · {result.trades} traded{result.trades === 0 ? '. No entries met the replay rules with the available quotes.' : '.'}</p>}
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          {[
            ['Full return', pct(result.return)],
            ...(result.hold == null ? [] : [['Buy and hold', pct(result.hold)]]),
            [result.kind === 'earnings' ? 'Closed-trade drawdown' : 'Max drawdown', pct(result.drawdown)],
            ['Trades / wins', `${result.trades} / ${result.wins}`],
            ['Early sample', pct(result.earlyReturn)], ['Later sample', pct(result.holdoutReturn)],
            ...(result.holdoutHold == null ? [] : [['Later buy and hold', pct(result.holdoutHold)]]),
            ['Later, higher costs', pct(result.stressReturn)],
          ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}
        </dl>
        <div className="h-52" aria-label="Simulated equity curve">
          <ResponsiveContainer width="100%" height="100%"><LineChart data={result.series}>
            <XAxis dataKey="day" minTickGap={64} tick={{ fontSize: 10 }} /><YAxis width={62} tick={{ fontSize: 10 }} tickFormatter={value => formatCurrency(Number(value), 0)} domain={['auto', 'auto']} />
            <Tooltip formatter={value => formatCurrency(Number(value))} contentStyle={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} /><Line type={result.kind === 'earnings' ? 'stepAfter' : 'linear'} dataKey="equity" dot={false} stroke="var(--series-1)" />
          </LineChart></ResponsiveContainer>
        </div>
        <p className="text-xs text-muted-foreground">{result.holdoutTrades} closed trades in the later sample.</p>
        {result.kind === 'earnings' && result.rows.length > 0 && <div className="overflow-x-auto">
          <table className="w-full text-sm text-left tabular-nums">
            <thead><tr>{['Date', 'Entry ask', 'Exit bid', 'Net P&L'].map(label => <th key={label} scope="col" className="p-2 text-xs text-muted-foreground">{label}</th>)}</tr></thead>
            <tbody>{result.rows.map(row => <tr key={row.day} className="border-t border-border">
              {[row.day, formatCurrency(row.ask), formatCurrency(row.bid), formatCurrency(row.pnl)].map((value, i) => <td key={i} className="p-2 whitespace-nowrap">{value}</td>)}
            </tr>)}</tbody>
          </table>
        </div>}
      </section>}
    </>
  );
}
