'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { STOCKS, STOCK_RULES, type StockSymbol, type StockRule, type researchStock } from '@/lib/stocks/research';
import type { gradeStock } from '@/lib/stocks/grade';
import type { EtoroClient } from '@/lib/stocks/etoro';

type Environment = 'demo' | 'real';
type PositionBook = Awaited<ReturnType<EtoroClient['portfolio']>>;
type Discovery = NonNullable<ReturnType<typeof gradeStock>> & {
  symbol: StockSymbol; name: string; instrumentId: number;
  quote: { bid: number | null; ask: number | null; date: string | null } | null;
};
type Scan = { rows: Discovery[]; unavailable: string[]; scannedAt: string };
type Simulation = { symbol: StockSymbol; rule: StockRule; result: NonNullable<ReturnType<typeof researchStock>> };
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const money = (n: number | null | undefined) => n == null ? '—' : dollars.format(n);
const pct = (n: number) => `${(100 * n).toFixed(2)}%`;
const selectClass = 'block w-full rounded-md border border-border bg-background px-3 h-10 text-sm';

async function stocksRequest<T>(query = '', init?: RequestInit): Promise<T> {
  const response = await fetch('/api/stocks' + query, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Stock request failed');
  return data;
}

export default function StocksPage() {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [targetEnv, setTargetEnv] = useState<Environment>('demo');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState('discover');
  const [scan, setScan] = useState<Scan | null>(null);
  const [strongOnly, setStrongOnly] = useState(false);
  const [book, setBook] = useState<PositionBook | null>(null);
  const [symbol, setSymbol] = useState<StockSymbol>('AAPL');
  const [rule, setRule] = useState<StockRule>('breakout');
  const [slipBps, setSlipBps] = useState('3');
  const [commission, setCommission] = useState('1');
  const [simulation, setSimulation] = useState<Simulation | null>(null);

  useEffect(() => {
    let active = true;
    stocksRequest<{ environment: Environment | null; discovery: Scan | null }>().then(data => {
      if (!active) return;
      setEnvironment(data.environment);
      setScan(data.discovery);
      if (!data.environment) setTab('portfolio');
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function perform(label: string, work: () => Promise<void>) {
    setBusy(label);
    setError('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Stock request failed'); }
    finally { setBusy(''); }
  }

  function setConnection(mode: Environment | null) {
    setEnvironment(mode);
    setBook(null);
    setScan(null);
    setSimulation(null);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    await perform('connect', async () => {
      const data = await stocksRequest<{ environment: Environment }>('', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: input.get('apiKey'), userKey: input.get('userKey'), environment: targetEnv }),
      });
      form.reset();
      setConnection(data.environment);
    });
  }

  const shown = scan?.rows.filter(row => !strongOnly || row.label === 'Strong buy') ?? [];
  const pending = !!busy || loading;

  return (
    <div className="flex flex-col min-h-full">
      <Header actions={<span className="text-xs text-muted-foreground">{environment ? `eToro ${environment === 'demo' ? 'Demo' : 'Real'} · Read only` : 'eToro'}</span>} />
      <div className="p-4 lg:p-8 space-y-4 max-w-[1400px] w-full mx-auto">
        {loading && <p role="status" className="text-sm text-muted-foreground">Checking eToro connection…</p>}
        {error && <p role="alert" className="surface px-4 py-3 text-sm text-destructive">{error}</p>}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="Stocks tools" className="w-full sm:w-auto grid grid-cols-3">
            <TabsTrigger value="discover">Discover</TabsTrigger>
            <TabsTrigger value="simulation">Simulate</TabsTrigger>
            <TabsTrigger value="portfolio">eToro account</TabsTrigger>
          </TabsList>
          <TabsContent value="discover" className="space-y-3">
            <section className="surface p-4 lg:p-6 space-y-4">
              <div className="flex flex-wrap justify-between items-start gap-3">
                <div><h2 className="text-lg font-semibold">Discover US stocks</h2><p className="text-sm text-muted-foreground">Rank 12 US stocks by trend, relative strength, risk, valuation and SEC filing data.</p></div>
                <Button disabled={!environment || pending} onClick={() => perform('scan', async () => setScan(await stocksRequest<Scan>('?view=discover')))}>{busy === 'scan' ? 'Scanning…' : 'Scan stocks'}</Button>
              </div>
              {!environment && !loading && <p className="text-sm">Connect an eToro account to load market data. <button className="text-primary underline" onClick={() => setTab('portfolio')}>Set up eToro</button></p>}
              {scan && <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <label className="flex gap-2 items-center"><input type="checkbox" checked={strongOnly} onChange={e => setStrongOnly(e.target.checked)} />Strong buy only</label>
                  <span className="text-xs text-muted-foreground">{scan.rows.length} graded · As of {new Date(scan.scannedAt).toLocaleString()}</span>
                </div>
                {scan.unavailable.length > 0 && <p className="text-xs text-muted-foreground">Data unavailable for {scan.unavailable.join(', ')}.</p>}
                {!shown.length && <p className="text-sm text-muted-foreground">No stocks met the Strong buy screen.</p>}
                <div className="grid md:grid-cols-2 gap-3">{shown.map(row => (
                  <article key={row.symbol} className="rounded-lg border border-border p-4 space-y-3">
                    <div className="flex justify-between items-start gap-3">
                      <div className="min-w-0"><h3 className="font-semibold">{row.symbol}</h3><p className="text-xs text-muted-foreground">{row.name}</p></div>
                      <div className="text-right shrink-0"><p className={row.label === 'Strong buy' ? 'font-medium text-success' : 'font-medium'}>{row.label}</p><p className="text-xs text-muted-foreground">{row.score}/100 · {row.coverage}% data</p></div>
                    </div>
                    <p className="text-sm">{money(row.close)} at {row.day} close · {row.quote ? `${money(row.quote.bid)} bid / ${money(row.quote.ask)} ask` : 'Quote unavailable'}</p>
                    {!!row.setups.length && <p className="text-sm">Setup detected: {row.setups.map(id => STOCK_RULES.find(r => r.id === id)?.name).join(', ')}</p>}
                    <details className="text-sm"><summary className="cursor-pointer text-primary">View grading breakdown</summary>
                      <dl className="mt-2 space-y-1">{row.factors.map(f => <div key={f.label} className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs"><dt>{f.label}</dt><dd className="tabular-nums">{f.value == null ? '—' : f.unit === 'percent' ? pct(f.value) : f.value.toFixed(1)}{f.unit === 'multiple' && f.value != null ? '×' : ''}</dd><dd className="text-muted-foreground text-right tabular-nums w-10">{f.points}/{f.max}</dd></div>)}</dl>
                      <p className="text-xs text-muted-foreground mt-2">Annual SEC period {row.fiscalEnd ?? 'unavailable'}. Quote timestamp {row.quote?.date ? new Date(row.quote.date).toLocaleString() : 'unavailable'}.</p>
                    </details>
                    <Button size="sm" variant="outline" onClick={() => { setSymbol(row.symbol); setSimulation(null); setTab('simulation'); }}>Simulate {row.symbol}</Button>
                  </article>
                ))}</div>
              </>}
              <p className="text-xs text-muted-foreground">Strong buy is a research grade. It requires 80 points, 90% data coverage, a fresh spread of 0.30% or less, and at least two percentage points of three-month outperformance versus SPY. Annual revenue growth, net margin and free cash flow margin must all be positive. The grade has no performance track record yet.</p>
            </section>
          </TabsContent>
          <TabsContent value="simulation" className="space-y-3">
            <section className="surface p-4 lg:p-6 space-y-4">
              <h2 className="text-lg font-semibold">Native US stock simulation</h2>
              <form className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3" onSubmit={e => {
                e.preventDefault();
                setSimulation(null);
                void perform('simulate', async () => setSimulation(await stocksRequest<Simulation>(`?view=research&${new URLSearchParams({ symbol, rule, slipBps, commission })}`)));
              }}>
                <label className="text-sm">Stock<select className={selectClass} value={symbol} disabled={pending} onChange={e => setSymbol(e.target.value as StockSymbol)}>{STOCKS.map(s => <option key={s}>{s}</option>)}</select></label>
                <label className="text-sm">Strategy<select className={selectClass} value={rule} disabled={pending} onChange={e => setRule(e.target.value as StockRule)}>{STOCK_RULES.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label className="text-sm">Extra slippage per side (bps)<Input type="number" min="0" max="100" step="0.1" required value={slipBps} disabled={pending} onChange={e => setSlipBps(e.target.value)} /></label>
                <label className="text-sm">Commission per side (USD)<Input type="number" min="0" max="30" step="0.01" required value={commission} disabled={pending} onChange={e => setCommission(e.target.value)} /></label>
                <Button type="submit" disabled={!environment || pending}>{busy === 'simulate' ? 'Running…' : 'Run simulation'}</Button>
              </form>
              <p className="text-sm text-muted-foreground">{STOCK_RULES.find(s => s.id === rule)?.entry}. Exit: {STOCK_RULES.find(s => s.id === rule)?.exit}.</p>
              <p className="text-xs text-muted-foreground">Starts with $10,000 and simulates one long position at a time. Signals use closed daily bars. Trades use the next opening ask or bid, plus your costs. The final 30% starts flat and is replayed again with double extra costs. Returns use broker price candles and exclude dividends.</p>
            </section>
            {simulation && <section className="surface p-4 lg:p-6 space-y-4">
              <h3 className="font-semibold">{simulation.symbol} · {STOCK_RULES.find(r => r.id === simulation.rule)?.name}</h3>
              <p className="text-xs text-muted-foreground">{simulation.result.from} to {simulation.result.to} · Later sample starts {simulation.result.holdoutFrom}</p>
              <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                {[
                  ['Full return', pct(simulation.result.return)], ['Buy and hold', pct(simulation.result.hold)],
                  ['Max drawdown', pct(simulation.result.drawdown)], ['Trades / wins', `${simulation.result.trades} / ${simulation.result.wins}`],
                  ['Early sample', pct(simulation.result.earlyReturn)], ['Later sample', pct(simulation.result.holdoutReturn)],
                  ['Later buy and hold', pct(simulation.result.holdoutHold)], ['Later, higher costs', pct(simulation.result.stressReturn)],
                ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}
              </dl>
              <div className="h-52" aria-label="Simulated equity curve"><ResponsiveContainer width="100%" height="100%"><LineChart data={simulation.result.series}>
                <XAxis dataKey="day" minTickGap={64} tick={{ fontSize: 10 }} /><YAxis width={62} tick={{ fontSize: 10 }} tickFormatter={value => money(value)} domain={['auto', 'auto']} />
                <Tooltip formatter={value => money(Number(value))} contentStyle={{ background: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }} /><Line type="linear" dataKey="equity" dot={false} stroke="var(--series-1)" />
              </LineChart></ResponsiveContainer></div>
              <p className="text-xs text-muted-foreground">{simulation.result.holdoutTrades} closed trades in the later sample.</p>
            </section>}
          </TabsContent>
          <TabsContent value="portfolio" className="space-y-3">
            <section className="surface p-4 lg:p-6 space-y-4">
              <h2 className="text-lg font-semibold">{environment ? `Connected to eToro ${environment === 'demo' ? 'Demo' : 'Real'}` : 'Connect eToro'}</h2>
              <p className="text-sm text-muted-foreground">In eToro, go to Settings → Trading → API Key Management. Create an API key pair with Read permission. Use the same environment below.</p>
              <form onSubmit={connect} autoComplete="off" className="grid sm:grid-cols-3 gap-3">
                <label className="text-sm">Environment<select value={targetEnv} className={selectClass} onChange={e => setTargetEnv(e.target.value as Environment)} disabled={pending}><option value="demo">Demo</option><option value="real">Real</option></select></label>
                <label className="text-sm">Public API key<Input type="password" autoComplete="new-password" name="apiKey" required maxLength={3000} disabled={pending} /></label>
                <label className="text-sm">User key<Input type="password" autoComplete="new-password" name="userKey" required maxLength={3000} disabled={pending} /></label>
                <div className="sm:col-span-3 flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>{busy === 'connect' ? 'Verifying…' : environment ? 'Replace connection' : 'Connect'}</Button>
                  {environment && <><Button type="button" variant="outline" disabled={pending} onClick={() => perform('portfolio', async () => setBook(await stocksRequest<PositionBook>('?view=portfolio')))}>{busy === 'portfolio' ? 'Loading…' : 'Refresh portfolio'}</Button>
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => perform('disconnect', async () => { await stocksRequest('', { method: 'DELETE' }); setConnection(null); })}>Disconnect</Button></>}
                </div>
              </form>
            </section>
            {book && <section className="surface p-4 lg:p-6 space-y-3">
              <h3 className="font-semibold">Direct eToro positions</h3>
              <p className="text-sm text-muted-foreground">Broker credit {money(book.credit)} · {book.pending} pending orders · {book.mirrors} copy portfolios</p>
              {!book.positions.length ? <p className="text-sm text-muted-foreground">No direct positions.</p> : <div className="overflow-x-auto"><table className="text-sm w-full min-w-[590px] text-left">
                <thead><tr>{['Instrument ID', 'Side', 'Units', 'Allocated', 'Leverage', 'Entry', 'Unrealized P&L'].map(label => <th key={label} scope="col" className="p-2 text-xs text-muted-foreground">{label}</th>)}</tr></thead>
                <tbody>{book.positions.map(p => <tr key={p.id} className="border-t border-border">{[p.instrumentId, p.side, p.units, money(p.amount), `${p.leverage}×`, money(p.entry), money(p.pnl)].map((cell, i) => <td key={i} className="p-2">{cell}</td>)}</tr>)}</tbody>
              </table></div>}
            </section>}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
