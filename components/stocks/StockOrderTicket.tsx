'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EARNINGS_REBOUND, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, isStockTradeRule, supportsStockTradeRule, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

export type StockEnvironment = 'demo' | 'real';
type Order = { id: string; symbol: string; state: string; broker_order_id: number | null; strategy_exit_at?: string | null; closed_at?: string | null };
type Review = { review: Order; amount: number; ask: number; name: string; signal?: string; costs: { costType: string; value: number; currency: string }[] };
type AutoConfig = { symbol: StockTradeSymbol; strategy: string; amount: number; active_environment: StockEnvironment | null; last_run_at: string | null; last_message: string | null };
const selectClass = 'mt-1 block w-full rounded-md border border-border bg-background px-2 h-10';
const statusLabel: Record<string, string> = { sending: 'Awaiting eToro', submitted: 'Submitted', filled: 'Filled', rejected: 'Rejected', review: 'Check with eToro' };
const costLabel: Record<string, string> = { markup: 'Markup', marketSpread: 'Market spread', transactionFee: 'Transaction fee', overnightFee: 'Overnight fee', overWeekendFee: 'Weekend fee', sdrt: 'Stamp duty' };
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

async function request<T>(query = '', body?: object): Promise<T> {
  const response = await fetch('/api/stocks/orders' + query, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Stock order request failed');
  return data;
}

async function autopilot(body?: object) {
  const response = await fetch('/api/stocks/autopilot', body ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Stock Autopilot request failed');
  return data.settings as AutoConfig | null;
}

export function StockOrderTicket({ flow, connections, initialEnvironment = 'demo', initialSymbol, initialRule, onConnect }: {
  flow: 'manual' | 'auto'; connections: StockEnvironment[]; initialEnvironment?: StockEnvironment;
  initialSymbol?: StockTradeSymbol; initialRule?: string; onConnect: (mode: StockEnvironment, symbol: StockTradeSymbol, strategy: string) => void;
}) {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [selectedSymbol, setSymbol] = useState<StockTradeSymbol | null>(null);
  const [selectedStrategy, setStrategy] = useState<string | null>(null);
  const [selectedAmount, setAmount] = useState<string | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [auto, setAuto] = useState<AutoConfig | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const connected = connections.includes(environment);
  const saved = flow === 'auto' ? auto : null;
  const savedSymbol = saved?.symbol ?? 'AAPL';
  const defaultSymbol = isStockTradeRule(initialRule) && !supportsStockTradeRule(initialRule, savedSymbol)
    ? STOCK_TRADE_SYMBOLS.find(ticker => supportsStockTradeRule(initialRule, ticker))! : savedSymbol;
  const symbol = selectedSymbol ?? initialSymbol ?? defaultSymbol;
  const choices = STOCK_TRADE_RULES.filter(rule => supportsStockTradeRule(rule.id, symbol));
  const wanted = selectedStrategy ?? initialRule ?? saved?.strategy;
  const activeRule = choices.find(rule => rule.id === wanted) ?? (flow === 'auto' ? choices[0] : undefined);
  const strategy = activeRule?.id ?? '';
  const earnings = strategy === EARNINGS_REBOUND.id;
  const amount = selectedAmount ?? (saved ? String(saved.amount) : '');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!connected) return;
    const result = await request<{ marketOpen: boolean; orders: Order[] }>(`?environment=${environment}`);
    if (signal?.aborted) return;
    setMarketOpen(result.marketOpen);
    setOrders(result.orders);
  }, [environment, connected]);

  useEffect(() => {
    const cancel = new AbortController();
    const load = () => Promise.all([refresh(cancel.signal), autopilot().then(data => { if (!cancel.signal.aborted) setAuto(data); })]).catch(e => { if (!cancel.signal.aborted) setError(e.message); });
    void load();
    const timer = setInterval(load, 30_000);
    return () => { cancel.abort(); clearInterval(timer); };
  }, [refresh]);

  async function perform(action: string, work: () => Promise<void>) {
    setBusy(action); setError(''); setMessage('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Order request failed'); }
    finally { setBusy(''); }
  }

  function preview(event: FormEvent) {
    event.preventDefault();
    if (flow === 'auto') {
      setConfirmAuto(true);
      return;
    }
    void perform('review', async () => {
      setReview(await request<Review>('', { action: 'review', environment, symbol, strategy: strategy || undefined, amount: Number(amount) }));
    });
  }

  return (
    <section className="surface p-4 lg:p-6 space-y-4" aria-label={flow === 'auto' ? 'Autopilot setup' : 'Stock order ticket'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{flow === 'auto' ? 'Choose a strategy' : 'Review a buy'}</h2>
          <p className="text-xs text-muted-foreground mt-1">{environment === 'demo' ? 'Paper uses virtual funds in eToro Demo.' : 'Live uses real money in eToro.'}</p>
        </div>
        <Segmented aria-label="Stock trading mode" value={environment} options={[{ value: 'demo', label: 'Paper' }, { value: 'real', label: 'Live' }]} disabled={!!busy || !!review} onChange={mode => {
          if (mode === environment) return;
          setEnvironment(mode); setOrders([]); setMarketOpen(null); setError(''); setMessage('');
        }} />
      </div>
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {flow === 'auto' && auto?.active_environment && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
        <div>
          <p className="text-xs text-profit">{auto.active_environment === 'demo' ? 'Paper' : 'Live'} Autopilot running</p>
          <p className="text-sm">{auto.symbol} · {STOCK_TRADE_RULES.find(rule => rule.id === auto.strategy)?.name} · {formatCurrency(auto.amount)}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => perform('pause', async () => {
          setAuto(await autopilot({ action: 'pause' }));
          setMessage('New entries paused. Existing strategy positions keep their exit rules.');
        })}>Pause entries</Button>
      </div>}
      {flow === 'auto' && auto?.last_message && <p className="text-sm text-muted-foreground">{auto.last_message}</p>}
      {connected ? <>
        <form onSubmit={preview} className="grid sm:grid-cols-2 lg:grid-cols-4 items-end gap-3">
          <label className="text-sm">Stock<select className={selectClass} value={symbol} onChange={e => setSymbol(e.target.value as StockTradeSymbol)}>{[...STOCK_TRADE_SYMBOLS].sort().map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm min-w-0">Strategy<select className={selectClass} value={strategy} onChange={e => setStrategy(e.target.value)}>
            {flow === 'manual' && <option value="">Manual buy</option>}
            <optgroup label="Daily setups">{choices.filter(rule => rule.id !== EARNINGS_REBOUND.id).map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</optgroup>
            {choices.some(rule => rule.id === EARNINGS_REBOUND.id) && (
              <optgroup label="Experimental intraday"><option value={EARNINGS_REBOUND.id}>{EARNINGS_REBOUND.name}</option></optgroup>
            )}
          </select></label>
          <label className="text-sm">Amount (USD)<Input className="mt-1" type="number" min={flow === 'auto' ? '1' : '0.01'} max={flow === 'auto' ? '10000' : '100000'} step="0.01" inputMode="decimal" value={amount} required onChange={e => setAmount(e.target.value)} /></label>
          <Button type="submit" disabled={!!busy || (flow === 'manual' && marketOpen !== true)}>{flow === 'auto' ? 'Review Autopilot' : busy === 'review' ? 'Checking…' : 'Review buy'}</Button>
        </form>
        {marketOpen === false && <p className="text-sm text-muted-foreground">The regular US market session is closed.</p>}
        {activeRule && <p className="text-xs text-muted-foreground">{earnings ? 'Experimental. Entries from 10:00 to 10:05 a.m. ET. Tideframe attempts the exit at 3:50 p.m. ET.' : activeRule.description}</p>}
        {!earnings && (flow === 'auto' || strategy === 'inside-day') && <p className="text-xs text-muted-foreground">Entry window is 9:30–10:00 a.m. ET.</p>}
        {flow === 'manual' && strategy && !earnings && <p className="text-xs text-muted-foreground">Manage manual exits in eToro.</p>}
        {orders.length > 0 && <div className="border-t pt-3 space-y-2">
          <h3 className="text-sm font-semibold">Recent orders</h3>
          {orders.map(order => <div key={order.id} className="flex items-center flex-wrap justify-between gap-2 text-sm">
            <span>{order.symbol} · {order.closed_at ? 'Closed' : statusLabel[order.state] ?? order.state}{order.broker_order_id ? ` · #${order.broker_order_id}` : ''}
              {order.strategy_exit_at && !order.closed_at && order.state !== 'rejected' && <span className="block text-xs text-muted-foreground">Exit scheduled for {nyTime.format(new Date(order.strategy_exit_at))} ET</span>}
            </span>
            {['sending', 'review', 'submitted'].includes(order.state) && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => perform(order.id, async () => {
              const result = await request<{ brokerMessage: string | null }>('', { action: 'status', id: order.id, environment });
              if (result.brokerMessage) setMessage(result.brokerMessage);
              await refresh();
            })}>Refresh status</Button>}
          </div>)}
        </div>}
      </> : <Button onClick={() => onConnect(environment, symbol, strategy)}>Connect eToro {environment === 'demo' ? 'Demo' : 'Real'}</Button>}

      <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buy {review?.review.symbol} · {environment === 'demo' ? 'Paper' : 'Live'}</DialogTitle>
            <DialogDescription>{review?.name} · eToro market order · {environment === 'demo' ? 'Virtual funds' : 'Real money'}</DialogDescription>
          </DialogHeader>
          {review && <div className="space-y-2 text-sm">
            <p>{formatCurrency(review.amount)} to invest · {formatCurrency(review.ask)} quoted ask</p>
            {review.signal && <p>{review.signal}</p>}
            {review.review.strategy_exit_at && <p>Tideframe will attempt to close the position at {nyTime.format(new Date(review.review.strategy_exit_at))} ET.</p>}
            {review.costs.filter(cost => cost.value !== 0).map((cost, i) => <p key={i} className="text-muted-foreground">{costLabel[cost.costType] ?? cost.costType} · {cost.value.toFixed(2)} {cost.currency}</p>)}
          </div>}
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setReview(null)}>Cancel</Button>
            <Button disabled={!!busy || !review} onClick={() => {
              if (!review) return;
              const id = review.review.id;
              void perform('submit', async () => {
                try {
                  await request('', { action: 'submit', id, environment });
                  setMessage('Order submitted to eToro. Refresh its status to check the fill.');
                } finally {
                  setReview(null);
                  await refresh().catch(() => {});
                }
              });
            }}>{busy === 'submit' ? 'Submitting…' : 'Submit buy'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmAuto} onOpenChange={open => { if (!busy) setConfirmAuto(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start {environment === 'demo' ? 'Paper' : 'Live'} stock Autopilot?</DialogTitle>
            <DialogDescription>{activeRule?.name} can buy {formatCurrency(Number(amount))} of {symbol} per position and manage the exit. Orders use {environment === 'demo' ? 'virtual funds' : 'real money'} in eToro. {earnings ? 'This experimental setup has a limited historical sample.' : 'Existing strategy positions keep their current exit rules.'}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setConfirmAuto(false)}>Cancel</Button>
            <Button disabled={!!busy} onClick={() => perform('start', async () => {
              try { setAuto(await autopilot({ action: 'start', symbol, strategy, amount: Number(amount), environment, confirmed: true })); }
              finally { setConfirmAuto(false); }
            })}>{busy === 'start' ? 'Starting…' : 'Confirm start'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
