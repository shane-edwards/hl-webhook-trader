'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { stockHref, stockSection } from '@/components/layout/workspaces';
import { STOCKS, STOCK_RULES, type StockSymbol, type StockRule, type researchStock } from '@/lib/stocks/research';
import type { gradeStock } from '@/lib/stocks/grade';
import type { EtoroClient } from '@/lib/stocks/etoro';
import { StockOrderTicket } from '@/components/stocks/StockOrderTicket';
import { INSIDE_BREAKOUT, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS } from '@/lib/stocks/trade-rules';
import insideDayEvidence from '@/lib/stocks/inside-day-evidence.json';

type Environment = 'demo' | 'real';
type PositionBook = Awaited<ReturnType<EtoroClient['portfolio']>>;
type Discovery = NonNullable<ReturnType<typeof gradeStock>> & {
  symbol: StockSymbol; name: string; instrumentId: number;
  quote: { bid: number | null; ask: number | null; date: string | null; quoteType?: 'realtime' | 'delayed' | null } | null;
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
  const router = useRouter();
  const query = useSearchParams();
  const tab = stockSection(query.get('tab'));
  const requestedSymbol = STOCK_TRADE_SYMBOLS.find(value => value === query.get('symbol'));
  const requestedRule = STOCK_TRADE_RULES.find(value => value.id === query.get('rule'))?.id;
  const mode = query.get('mode');
  const requestedMode = mode === 'real' || mode === 'demo' ? mode : undefined;
  const returnView = query.get('returnTo') === 'autopilot' ? 'autopilot' : 'trade';
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [connections, setConnections] = useState<Environment[]>([]);
  const targetEnv = requestedMode ?? environment ?? 'demo';
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [scan, setScan] = useState<Scan | null>(null);
  const [strongOnly, setStrongOnly] = useState(false);
  const [portfolio, setPortfolio] = useState<{ mode: Environment; book: PositionBook } | null>(null);
  const [selectedSymbol, setSymbol] = useState<StockSymbol | null>(null);
  const symbol = selectedSymbol ?? STOCKS.find(value => value === requestedSymbol) ?? 'AAPL';
  const [rule, setRule] = useState<StockRule>('breakout');
  const [slipBps, setSlipBps] = useState('3');
  const [commission, setCommission] = useState('1');
  const [simulation, setSimulation] = useState<Simulation | null>(null);

  useEffect(() => {
    let active = true;
    stocksRequest<{ environment: Environment | null; discovery: Scan | null; connections: Environment[] }>().then(data => {
      if (!active) return;
      setEnvironment(data.environment);
      setScan(data.discovery);
      setConnections(data.connections ?? []);
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

  async function refreshConnections() {
    const data = await stocksRequest<{ environment: Environment | null; discovery: Scan | null; connections: Environment[] }>();
    setEnvironment(data.environment);
    setConnections(data.connections);
    setScan(data.discovery);
    setPortfolio(null);
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    await perform('connect', async () => {
      await stocksRequest<{ environment: Environment }>('', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: input.get('apiKey'), userKey: input.get('userKey'), environment: targetEnv }),
      });
      form.reset();
      await refreshConnections();
      router.push(stockHref(returnView, {
        mode: targetEnv,
        ...(requestedSymbol ? { symbol: requestedSymbol } : {}),
        ...(requestedRule ? { rule: requestedRule } : {}),
      }));
    });
  }

  const shown = scan?.rows.filter(row => !strongOnly || row.label === 'Strong buy') ?? [];
  const pending = !!busy || loading;
  const connected = connections.includes(targetEnv);
  const book = portfolio?.mode === targetEnv ? portfolio.book : null;
  const connectionForm = (
    <form onSubmit={connect} autoComplete="off" className="grid sm:grid-cols-2 gap-3">
      <p className="text-xs text-muted-foreground sm:col-span-2">In eToro, open Settings → Trading → API Key Management. Create a key for {targetEnv === 'demo' ? 'Demo' : 'Real'} with Write permission to place orders.</p>
      <label className="text-sm">Public API key<Input type="password" autoComplete="new-password" name="apiKey" required maxLength={3000} disabled={pending} /></label>
      <label className="text-sm">User key<Input type="password" autoComplete="new-password" name="userKey" required maxLength={3000} disabled={pending} /></label>
      <div className="sm:col-span-2 flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>{busy === 'connect' ? 'Verifying…' : connected ? 'Replace connection' : `Connect eToro ${targetEnv === 'demo' ? 'Demo' : 'Real'}`}</Button>
        {connected && <Button type="button" variant="ghost" disabled={pending} onClick={() => perform('disconnect', async () => { await stocksRequest(`?environment=${targetEnv}`, { method: 'DELETE' }); await refreshConnections(); })}>Disconnect</Button>}
      </div>
    </form>
  );

  return (
    <div className="flex flex-col min-h-full">
      <Header />
      <div className="p-4 lg:p-8 space-y-4 max-w-[1400px] w-full mx-auto">
        {loading && <p role="status" className="text-sm text-muted-foreground">Checking eToro connection…</p>}
        {error && <p role="alert" className="surface px-4 py-3 text-sm text-destructive">{error}</p>}
          {tab === 'discover' && (
            <section className="surface p-4 lg:p-6 space-y-4">
              <div className="flex flex-wrap justify-between items-start gap-3">
                <div><h2 className="text-lg font-semibold">Find stocks to review</h2><p className="text-sm text-muted-foreground">Filter for Strong buy or open a stock to review a trade.</p></div>
                {!loading && !environment ? <Button asChild><Link href={stockHref('account')}>Connect eToro</Link></Button>
                  : <Button disabled={pending} onClick={() => perform('scan', async () => setScan(await stocksRequest<Scan>('?view=discover')))}>{busy === 'scan' ? 'Scanning…' : 'Scan stocks'}</Button>}
              </div>
              {!scan && !loading && environment && <p className="text-sm text-muted-foreground">Scan the watchlist to see rankings and strategy setups.</p>}
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
                    <p className="text-sm">{money(row.close)} at {row.day} close · {row.quote ? `${money(row.quote.bid)} bid / ${money(row.quote.ask)} ask${row.quote.quoteType === 'delayed' ? ' (delayed)' : ''}` : 'Quote unavailable'}</p>
                    {!!row.setups.length && <p className="text-sm">Setup detected: {row.setups.map(id => STOCK_RULES.find(r => r.id === id)?.name).join(', ')}</p>}
                    <details className="text-sm"><summary className="cursor-pointer text-primary">View grading breakdown</summary>
                      <dl className="mt-2 space-y-1">{row.factors.map(f => <div key={f.label} className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs"><dt>{f.label}</dt><dd className="tabular-nums">{f.value == null ? '—' : f.unit === 'percent' ? pct(f.value) : f.value.toFixed(1)}{f.unit === 'multiple' && f.value != null ? '×' : ''}</dd><dd className="text-muted-foreground text-right tabular-nums w-10">{f.points}/{f.max}</dd></div>)}</dl>
                      <p className="text-xs text-muted-foreground mt-2">Annual SEC period {row.fiscalEnd ?? 'unavailable'}. Quote timestamp {row.quote?.date ? new Date(row.quote.date).toLocaleString() : 'unavailable'}.</p>
                    </details>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" asChild><Link href={stockHref('trade', { symbol: row.symbol, ...(row.setups[0] ? { rule: row.setups[0] } : {}) })}>Review {row.symbol}</Link></Button>
                      <Button size="sm" variant="outline" asChild><Link href={stockHref('research', { symbol: row.symbol })} onClick={() => { setSymbol(null); setSimulation(null); }}>Simulate</Link></Button>
                    </div>
                  </article>
                ))}</div>
              </>}
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer text-primary">How Strong buy is graded</summary>
                <p className="mt-2">Requires 80 points, 90% data coverage, a fresh spread of 0.30% or less, and at least two percentage points of three-month outperformance versus SPY. Revenue growth, net margin and free cash flow margin must each be positive. The grade is still under evaluation.</p>
              </details>
            </section>
          )}
          {(tab === 'trade' || tab === 'autopilot') && !loading && (
            <StockOrderTicket
              key={`${tab}:${requestedMode}:${requestedSymbol}:${requestedRule}`}
              flow={tab === 'autopilot' ? 'auto' : 'manual'}
              connections={connections}
              initialEnvironment={requestedMode}
              initialSymbol={requestedSymbol}
              initialRule={requestedRule}
              onConnect={(nextMode, ticker, strategy) => router.push(stockHref('account', {
                mode: nextMode, symbol: ticker, returnTo: tab, ...(strategy ? { rule: strategy } : {}),
              }))}
            />
          )}
          {tab === 'research' && <div className="space-y-3">
            <section className="surface p-4 lg:p-6 space-y-3">
              <h2 className="text-base font-semibold">{INSIDE_BREAKOUT.name}</h2>
              <p className="text-sm text-muted-foreground">{insideDayEvidence.stages[2].trades} holdout trades across {insideDayEvidence.symbols.length} eligible stocks. Average net return {pct((insideDayEvidence.stages[2].netBps ?? 0) / 10_000)} per trade, or {pct((insideDayEvidence.stages[2].stressBps ?? 0) / 10_000)} with higher costs.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild><Link href={stockHref('trade', { rule: INSIDE_BREAKOUT.id })}>Review in Trade</Link></Button>
                <Button size="sm" variant="outline" asChild><Link href={stockHref('autopilot', { rule: INSIDE_BREAKOUT.id })}>Open in Autopilot</Link></Button>
              </div>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Replay assumptions</summary>
                <p className="mt-2">Signals use regular-session bars. Trades fill at the next opening ask or bid on a $10,000 position. Base costs add 3 bps and $1 per side. Higher costs double both. {insideDayEvidence.stages[2].positiveMarkets} stocks finished positive under higher costs.</p>
              </details>
            </section>
            <section className="surface p-4 lg:p-6 space-y-4">
              <h2 className="text-lg font-semibold">Daily strategy simulator</h2>
              {!loading && !environment && <p className="text-sm text-muted-foreground"><Link className="text-primary underline" href={stockHref('account')}>Connect eToro</Link> to load historical quotes.</p>}
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
          </div>}
          {tab === 'account' && <div className="space-y-3">
            <section className="surface p-4 lg:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{targetEnv === 'demo' ? 'eToro Demo' : 'eToro Real'}</h2>
                <Segmented aria-label="eToro account type" value={targetEnv} options={[{ value: 'demo', label: 'Paper (Demo)' }, { value: 'real', label: 'Live (Real)' }]} disabled={pending} onChange={mode => {
                  if (mode === targetEnv) return;
                  setPortfolio(null);
                  const params = new URLSearchParams(query.toString());
                  params.set('mode', mode);
                  router.replace(`/stocks?${params}`, { scroll: false });
                }} />
              </div>
              {!loading && <>
                <p className="text-sm text-muted-foreground">{connected ? 'Connected' : 'Connect this account'} · {targetEnv === 'demo' ? 'Virtual funds for paper trading' : 'Real money for live trading'}</p>
                {connected ? <>
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={pending} onClick={() => perform('portfolio', async () => setPortfolio({
                      mode: targetEnv, book: await stocksRequest<PositionBook>(`?view=portfolio&environment=${targetEnv}`),
                    }))}>{busy === 'portfolio' ? 'Loading…' : book ? 'Refresh portfolio' : 'View portfolio'}</Button>
                    <Button asChild variant="outline"><Link href={stockHref(returnView, {
                      mode: targetEnv,
                      ...(requestedSymbol ? { symbol: requestedSymbol } : {}),
                      ...(requestedRule ? { rule: requestedRule } : {}),
                    })}>{returnView === 'autopilot' ? 'Open Autopilot' : 'Open trade ticket'}</Link></Button>
                  </div>
                  <details key={targetEnv}>
                    <summary className="cursor-pointer text-sm font-medium">Manage connection</summary>
                    <div className="mt-3">{connectionForm}</div>
                  </details>
                </> : connectionForm}
              </>}
            </section>
            {book && <section className="surface p-4 lg:p-6 space-y-3">
              <h3 className="font-semibold">Direct eToro positions</h3>
              <p className="text-sm text-muted-foreground">Broker credit {money(book.credit)} · {book.pending} pending orders · {book.mirrors} copy portfolios</p>
              {!book.positions.length ? <p className="text-sm text-muted-foreground">No direct positions.</p> : <div className="overflow-x-auto"><table className="text-sm w-full min-w-[590px] text-left">
                <thead><tr>{['Instrument ID', 'Side', 'Units', 'Allocated', 'Leverage', 'Entry', 'Unrealized P&L'].map(label => <th key={label} scope="col" className="p-2 text-xs text-muted-foreground">{label}</th>)}</tr></thead>
                <tbody>{book.positions.map(p => <tr key={p.id} className="border-t border-border">{[p.instrumentId, p.side, p.units, money(p.amount), `${p.leverage}×`, money(p.entry), money(p.pnl)].map((cell, i) => <td key={i} className="p-2">{cell}</td>)}</tr>)}</tbody>
              </table></div>}
            </section>}
          </div>}
      </div>
    </div>
  );
}
