'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EARNINGS_REBOUND, STOCK_INSTRUMENTS, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, isStockTradeRule, supportsStockTradeRule, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { stockSizingParams, stockSizingSchema, type StockLeverage, type StockOrderOption, type StockSizing } from '@/lib/stocks/leverage';
import { DEFAULT_STOCK_PORTFOLIO, stockPortfolioSchema, type StockPortfolio } from '@/lib/stocks/portfolio';
import type { EtoroClient } from '@/lib/stocks/etoro';
import { StockPortfolioFields } from './StockPortfolioFields';
import { StockRiskSizer } from './StockRiskSizer';
import { formatCurrency } from '@/lib/utils';
import { frameNames, StrategySearch } from '@/components/journey/StrategySearch';
import { SEARCH_FRAMES, type SearchFrame } from '@/lib/strategy-search/model';

export type StockEnvironment = 'demo' | 'real';
type Order = { close_attempts?: Record<string, { state: string; retryAt?: number; detail?: string }>; id: string; symbol: string; state: string; broker_order_id: number | null; strategy_exit_at?: string | null; closed_at?: string | null; leverage?: StockLeverage; protection_state?: string | null };
type Cost = { costType: string; value: number; currency: string };
type Review = { review: Order; amount: number; ask: number; name: string; signal?: string; costs: Cost[];
  leverage: StockLeverage; exposure: number; stopPrice: number | null; estimatedStopLoss: number | null };
type AutoConfig = { symbol: StockTradeSymbol; strategy: string; amount: number; active_environment: StockEnvironment | null; last_run_at: string | null; last_message: string | null; leverage?: StockLeverage; stop_margin_pct?: number | null; portfolio?: StockPortfolio | null };
type Book = Awaited<ReturnType<EtoroClient['portfolio']>>;
const tickerById = new Map(Object.entries(STOCK_INSTRUMENTS).map(([ticker, id]) => [id, ticker]));
const selectClass = 'mt-1 block w-full rounded-md border border-border bg-background px-2 h-10';
const statusLabel: Record<string, string> = { sending: 'Awaiting eToro', submitted: 'Submitted', filled: 'Filled', rejected: 'Rejected', review: 'Check with eToro' };
const costLabel: Record<string, string> = { markup: 'Markup', marketSpread: 'Market spread', transactionFee: 'Transaction fee', overnightFee: 'Overnight fee', overWeekendFee: 'Weekend fee', sdrt: 'Stamp duty' };
const nyTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

function CostBreakdown({ costs }: { costs: Cost[] }) {
  return costs.filter(cost => cost.value !== 0).map((cost, i) => (
    <p key={i} className="text-muted-foreground">{costLabel[cost.costType] ?? cost.costType} · {cost.value.toFixed(2)} {cost.currency}</p>
  ));
}

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

export function StockOrderTicket({ flow, connections, initialEnvironment = 'demo', initialSymbol, initialRule, initialSizing, onConnect, compact = false }: {
  flow: 'manual' | 'auto'; connections: StockEnvironment[]; initialEnvironment?: StockEnvironment;
  initialSymbol?: StockTradeSymbol; initialRule?: string; initialSizing?: StockSizing;
  onConnect: (mode: StockEnvironment, symbol: StockTradeSymbol, strategy: string, size: Record<string, string>) => void;
  compact?: boolean;
}) {
  const [environment, setEnvironment] = useState(initialEnvironment);
  const [selectedSymbol, setSymbol] = useState<StockTradeSymbol | null>(null);
  const [selectedStrategy, setStrategy] = useState<string | null>(null);
  const [selectedAmount, setAmount] = useState<string | null>(null);
  const [selectedLeverage, setLeverage] = useState<StockLeverage | null>(null);
  const [selectedStop, setStop] = useState<string | null>(null);
  const [eligibility, setEligibility] = useState<{ key: string; options: StockOrderOption[]; error?: string } | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [marketOpen, setMarketOpen] = useState<boolean | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [auto, setAuto] = useState<AutoConfig | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [autoCosts, setAutoCosts] = useState<Cost[] | null>(null);
  const [book, setBook] = useState<{ mode: StockEnvironment; value: Book | null } | null>(null);
  const [portfolioMode, setPortfolioMode] = useState<boolean | null>(null);
  const [portfolioDraft, setPortfolioDraft] = useState<StockPortfolio | null>(null);
  const [researchFrame, setResearchFrame] = useState<SearchFrame>('1d');
  const connected = connections.includes(environment);
  const saved = flow === 'auto' ? auto : null;
  const savedSymbol = saved?.symbol ?? 'AAPL';
  const defaultSymbol = isStockTradeRule(initialRule) && !supportsStockTradeRule(initialRule, savedSymbol)
    ? STOCK_TRADE_SYMBOLS.find(ticker => supportsStockTradeRule(initialRule, ticker))! : savedSymbol;
  const ticketSymbol = selectedSymbol ?? initialSymbol ?? defaultSymbol;
  const usePortfolio = flow === 'auto' && (portfolioMode ?? (!initialSymbol && !!saved?.portfolio));
  const portfolio = portfolioDraft ?? saved?.portfolio ?? DEFAULT_STOCK_PORTFOLIO;
  const portfolioSymbol = portfolio.symbols.find(ticker => portfolio.strategies.some(rule => supportsStockTradeRule(rule, ticker)));
  const symbol = usePortfolio && portfolioSymbol ? portfolioSymbol : ticketSymbol;
  const choices = STOCK_TRADE_RULES.filter(rule => supportsStockTradeRule(rule.id, symbol));
  const wanted = usePortfolio ? portfolio.strategies.find(rule => supportsStockTradeRule(rule, symbol))
    : selectedStrategy ?? initialRule ?? saved?.strategy;
  const activeRule = choices.find(rule => rule.id === wanted) ?? (flow === 'auto' ? choices[0] : undefined);
  const strategy = activeRule?.id ?? '';
  const earnings = strategy === EARNINGS_REBOUND.id;
  const amount = selectedAmount ?? (initialSizing ? String(initialSizing.amount) : saved ? String(saved.amount) : '');
  const leverage = selectedLeverage ?? initialSizing?.leverage ?? saved?.leverage ?? 1;
  const eligibilityKey = `${environment}:${symbol}`;
  const currentEligibility = eligibility?.key === eligibilityKey ? eligibility : null;
  const options = currentEligibility?.options ?? [];
  const leverageOption = options.find(option => option.leverage === leverage);
  const stopRange = leverageOption?.stopMargin;
  const leveraged = leverage > 1;
  const stop = selectedStop ?? (initialSizing?.stopMarginPct != null ? String(initialSizing.stopMarginPct) : saved?.stop_margin_pct != null
    ? String(saved.stop_margin_pct) : String(stopRange ? Math.max(stopRange.min, Math.min(10, stopRange.max)) : 10));
  const validLeverage = !leveraged || (!!stopRange && Number(stop) > 0 && Number(stop) >= stopRange.min && Number(stop) <= stopRange.max);
  const sizing = { leverage, ...(leveraged ? { stopMarginPct: Number(stop) } : {}) };
  const configuredSize = stockSizingSchema.safeParse({ amount: Number(amount), ...sizing });
  const handoff = configuredSize.success ? stockSizingParams(configuredSize.data) : {};
  const currentBook = book?.mode === environment ? book : null;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!connected) return;
    await Promise.all([
      request<{ marketOpen: boolean; orders: Order[] }>(`?environment=${environment}`).then(result => {
        if (signal?.aborted) return;
        setMarketOpen(result.marketOpen);
        setOrders(result.orders);
      }),
      fetch(`/api/stocks?view=portfolio&environment=${environment}`, { signal }).then(async response => response.ok ? await response.json() as Book : null)
        .catch(() => null).then(value => { if (!signal?.aborted) setBook({ mode: environment, value }); }),
    ]);
  }, [environment, connected]);

  useEffect(() => {
    const cancel = new AbortController();
    const load = () => Promise.all([refresh(cancel.signal), autopilot().then(data => { if (!cancel.signal.aborted) setAuto(data); })]).catch(e => { if (!cancel.signal.aborted) setError(e.message); });
    void load();
    const timer = setInterval(load, 30_000);
    return () => { cancel.abort(); clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!connected) return;
    let current = true;
    request<{ options: StockOrderOption[] }>(`?${new URLSearchParams({ environment, symbol })}`).then(result => {
      if (current) setEligibility({ key: eligibilityKey, options: result.options });
    }).catch(() => {
      if (current) setEligibility({ key: eligibilityKey, options: [], error: 'eToro leverage options are unavailable right now.' });
    });
    return () => { current = false; };
  }, [connected, environment, symbol, eligibilityKey]);

  async function perform(action: string, work: () => Promise<void>) {
    setBusy(action); setError(''); setMessage('');
    try { await work(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Order request failed'); }
    finally { setBusy(''); }
  }

  function preview(event: FormEvent) {
    event.preventDefault();
    if (flow === 'auto') {
      if (usePortfolio) {
        if (!stockPortfolioSchema.safeParse(portfolio).success) { setError('Choose compatible stocks and strategies, with valid portfolio limits.'); return; }
        if (portfolio.maxGroup < Number(amount) * leverage || portfolio.maxExposure < Number(amount) * leverage) {
          setError('The gross exposure and group limits must cover at least one position.'); return;
        }
        setError(''); setAutoCosts(null); setConfirmAuto(true); return;
      }
      if (!leveraged) { setConfirmAuto(true); return; }
      void perform('estimate', async () => {
        const estimate = await request<{ costs: Cost[] }>('', { action: 'estimate', environment, symbol, amount: Number(amount), ...sizing }).catch(() => null);
        setAutoCosts(estimate?.costs ?? null);
        setConfirmAuto(true);
      });
      return;
    }
    void perform('review', async () => {
      setReview(await request<Review>('', { action: 'review', environment, symbol, strategy: strategy || undefined, amount: Number(amount), ...sizing }));
    });
  }

  return (
    <section className="surface p-4 lg:p-6 space-y-4" aria-label={flow === 'auto' ? 'Autopilot setup' : 'Stock order ticket'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{flow === 'auto' ? 'Set up Autopilot' : 'Review a buy'}</h2>
          {!compact && <p className="text-xs text-muted-foreground mt-1">{environment === 'demo' ? 'Paper uses virtual funds in eToro Demo.' : 'Live uses real money in eToro.'}</p>}
        </div>
        <Segmented aria-label="Stock trading mode" value={environment} options={[{ value: 'demo', label: 'Paper' }, { value: 'real', label: 'Live' }]} disabled={!!busy || !!review} onChange={mode => {
          if (mode === environment) return;
          setEnvironment(mode); setOrders([]); setBook(null); setMarketOpen(null); setError(''); setMessage('');
        }} />
      </div>
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {!compact && flow === 'manual' && <div className="space-y-2">
        <Segmented<SearchFrame> aria-label="Research timeframe" value={researchFrame} onChange={setResearchFrame}
          options={SEARCH_FRAMES.stocks.map(frame => ({ value: frame, label: frameNames[frame] }))} />
        <StrategySearch market="stocks" symbol={symbol} frame={researchFrame} compact />
      </div>}
      {flow === 'auto' && auto?.active_environment && <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
        <div>
          <p className="text-xs text-profit">{auto.active_environment === 'demo' ? 'Paper' : 'Live'} Autopilot running</p>
          <p className="text-sm">{auto.portfolio ? `${auto.portfolio.symbols.length} stocks · ${auto.portfolio.strategies.length} strategies`
            : `${auto.symbol} · ${STOCK_TRADE_RULES.find(rule => rule.id === auto.strategy)?.name}`} · {formatCurrency(auto.amount)} per trade{auto.leverage && auto.leverage > 1 ? ` · ${auto.leverage}× CFD` : ''}</p>
        </div>
        <Button variant="outline" size="sm" disabled={!!busy} onClick={() => perform('pause', async () => {
          setAuto(await autopilot({ action: 'pause' }));
          setMessage('New entries paused. Existing strategy positions keep their exit rules.');
        })}>Pause entries</Button>
      </div>}
      {flow === 'auto' && !auto?.active_environment && <p className="text-sm text-muted-foreground">Autopilot paused</p>}
      {flow === 'auto' && auto?.last_message && <p className="text-sm text-muted-foreground">{auto.last_message}{auto.last_run_at && ` · ${nyTime.format(new Date(auto.last_run_at))} ET`}</p>}
      {flow === 'auto' && <Segmented aria-label="Autopilot scope" value={usePortfolio ? 'portfolio' : 'single'}
        options={[{ value: 'single', label: 'One strategy' }, { value: 'portfolio', label: 'Portfolio' }]} disabled={!!busy} onChange={value => setPortfolioMode(value === 'portfolio')} />}
      {!compact && activeRule && !usePortfolio && <Link className="inline-block text-sm text-primary hover:underline" href={stockHref('research', { symbol, rule: activeRule.id, ...handoff })}>Backtest this strategy</Link>}
      {usePortfolio && <Link className="block text-sm text-primary hover:underline" href="/stocks/portfolio">Replay the portfolio</Link>}
      {flow === 'auto' && <Link className="block text-sm text-primary hover:underline" href={`/stocks/scorecard?mode=${environment}`}>Strategy scorecard and guard</Link>}
      {connected ? <>
        <form onSubmit={preview} className="grid sm:grid-cols-2 lg:grid-cols-3 items-end gap-3">
          {usePortfolio ? <StockPortfolioFields settings={portfolio} onChange={setPortfolioDraft} /> : !compact && <>
          <label className="text-sm">Stock<select aria-label="Stock" className={selectClass} value={symbol} onChange={e => setSymbol(e.target.value as StockTradeSymbol)}>{[...STOCK_TRADE_SYMBOLS].sort().map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="text-sm min-w-0">Strategy<select aria-label="Strategy" className={selectClass} value={strategy} onChange={e => setStrategy(e.target.value)}>
            {flow === 'manual' && <option value="">Manual buy</option>}
            <optgroup label="Daily setups">{choices.filter(rule => rule.id !== EARNINGS_REBOUND.id).map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</optgroup>
            {choices.some(rule => rule.id === EARNINGS_REBOUND.id) && (
              <optgroup label="Experimental intraday"><option value={EARNINGS_REBOUND.id}>{EARNINGS_REBOUND.name}</option></optgroup>
            )}
          </select></label>
          </>}
          <label className="text-sm">{leveraged ? 'Margin (USD)' : 'Amount (USD)'}<Input className="mt-1" type="number" min={Math.max(flow === 'auto' ? 1 : 0.01, leverageOption?.minimum ?? 0)} max={flow === 'auto' ? '10000' : '100000'} step="0.01" inputMode="decimal" value={amount} required onChange={e => setAmount(e.target.value)} /></label>
          <label className="text-sm">Leverage<select aria-label="Leverage" className={selectClass} value={leverage} disabled={!!busy} onChange={e => {
            setLeverage(Number(e.target.value) as StockLeverage);
            setStop(null);
          }}>
            <option value={1}>1× · Cash</option>
            {options.filter(option => option.leverage !== 1).map(option => <option key={option.leverage} value={option.leverage}>{option.leverage}× · CFD</option>)}
            {leveraged && !leverageOption && <option value={leverage} disabled>{leverage}× · {currentEligibility ? 'Unavailable' : 'Checking eligibility…'}</option>}
          </select></label>
          {leveraged && <label className="text-sm">Stop loss (% of margin)<Input className="mt-1" type="number" min={Math.max(0.01, stopRange?.min ?? 0)} max={stopRange?.max ?? 50} step="any" inputMode="decimal" value={stop} required onChange={e => setStop(e.target.value)} /></label>}
          <Button type="submit" disabled={!!busy || !validLeverage || (flow === 'manual' && marketOpen !== true)}>{busy === 'review' || busy === 'estimate' ? 'Checking…' : flow === 'auto' ? 'Review Autopilot' : 'Review buy'}</Button>
        </form>
        {flow === 'manual' && <StockRiskSizer key={`${environment}:${symbol}:${leverage}:${stop}`} symbol={symbol} environment={environment} leverage={leverage}
          stopMarginPct={Number(stop)} marketOpen={marketOpen === true} onUse={value => { setAmount(String(value)); setMessage('Suggested margin copied. Review the latest quote before buying.'); }} />}
        {currentEligibility?.error && <p className="text-xs text-muted-foreground">{currentEligibility.error}</p>}
        {leveraged && currentEligibility && !leverageOption && <p className="text-xs text-loss">Choose leverage available for this stock and account.</p>}
        {leveraged && stopRange && <p className="text-xs text-muted-foreground">
          {Number(amount) > 0 ? `${formatCurrency(Number(amount) * leverage)} exposure · ${formatCurrency(Number(amount) * Number(stop) / 100)} estimated loss at the stop, before fees. ` : ''}
        </p>}
        {marketOpen === false && <p className="text-sm text-muted-foreground">The regular US market session is closed.</p>}
        {!compact && activeRule && !usePortfolio && <p className="text-xs text-muted-foreground">{earnings ? 'Experimental. Entries from 10:00 to 10:05 a.m. ET. Tideframe attempts the exit at 3:50 p.m. ET.' : activeRule.description}</p>}
        {!usePortfolio && !earnings && (flow === 'auto' || strategy === 'inside-day') && <p className="text-xs text-muted-foreground">Entry window is 9:30–10:00 a.m. ET.</p>}
        {flow === 'manual' && strategy && !earnings && <p className="text-xs text-muted-foreground">Manage manual exits in eToro.</p>}
        <div className="border-t pt-3 space-y-2">
          <h3 className="text-sm font-semibold">eToro positions and pending orders</h3>
          <Link className="text-xs text-primary hover:underline" href={`/stocks/journal?mode=${environment}`}>Execution journal</Link>
          {currentBook?.value ? <>
            <p className="text-xs text-muted-foreground">{formatCurrency(currentBook.value.availableCash)} available · {currentBook.value.positions.length} direct {currentBook.value.positions.length === 1 ? 'position' : 'positions'} · {currentBook.value.pending} pending {currentBook.value.pending === 1 ? 'order' : 'orders'}{currentBook.value.mirrors > 0 && ` · ${currentBook.value.mirrors} copy portfolios`}</p>
            {currentBook.value.positions.map(position => <div key={position.id} className="flex flex-wrap justify-between gap-2 text-sm">
              <span>{tickerById.get(position.instrumentId) ?? `Instrument ${position.instrumentId}`} · {position.side} · {position.leverage}× · {formatCurrency(position.amount)} allocated</span>
              <span className="tabular-nums">{position.pnl == null ? 'P&L unavailable' : `${formatCurrency(position.pnl)} P&L`}</span>
            </div>)}
          </> : <p className="text-xs text-muted-foreground">{currentBook ? 'eToro portfolio is temporarily unavailable.' : 'Checking eToro portfolio…'}</p>}
        </div>
        {orders.length > 0 && <div className="border-t pt-3 space-y-2">
          <h3 className="text-sm font-semibold">Recent orders</h3>
          {orders.map(order => <div key={order.id} className="flex items-center flex-wrap justify-between gap-2 text-sm">
            <span>{order.symbol} {order.leverage && order.leverage > 1 ? `· ${order.leverage}× CFD ` : ''}· {order.closed_at ? 'Closed' : statusLabel[order.state] ?? order.state}{order.broker_order_id ? ` · #${order.broker_order_id}` : ''}
              {!order.closed_at && Object.entries(order.close_attempts ?? {}).map(([id, attempt]) =>
                <span key={id} className="block text-xs text-muted-foreground">Position {id} · Exit {attempt.state}
                  {attempt.retryAt && ` · Next retry ${nyTime.format(new Date(attempt.retryAt))} ET`}{attempt.detail && ` · ${attempt.detail}`}</span>)}
              {order.protection_state === 'exit_required' && !order.closed_at && <span className="block text-xs text-loss">Stop unconfirmed · Tideframe is checking the position for closure</span>}
              {order.strategy_exit_at && !order.closed_at && order.state !== 'rejected' && <span className="block text-xs text-muted-foreground">Exit scheduled for {nyTime.format(new Date(order.strategy_exit_at))} ET</span>}
            </span>
            {['sending', 'review', 'submitted'].includes(order.state) && <Button variant="outline" size="sm" disabled={!!busy} onClick={() => perform(order.id, async () => {
              const result = await request<{ brokerMessage: string | null }>('', { action: 'status', id: order.id, environment });
              if (result.brokerMessage) setMessage(result.brokerMessage);
              await refresh();
            })}>Refresh status</Button>}
          </div>)}
        </div>}
      </> : <Button onClick={() => onConnect(environment, symbol, strategy, handoff)}>Connect eToro {environment === 'demo' ? 'Demo' : 'Real'}</Button>}

      <Dialog open={!!review} onOpenChange={open => { if (!open && !busy) setReview(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Buy {review?.review.symbol} · {environment === 'demo' ? 'Paper' : 'Live'}</DialogTitle>
            <DialogDescription>{review?.name} · {review && review.leverage > 1 ? `${review.leverage}× CFD` : 'Cash stock'} · {environment === 'demo' ? 'Virtual funds' : 'Real money'}</DialogDescription>
          </DialogHeader>
          {review && <div className="space-y-2 text-sm">
            <p>{formatCurrency(review.amount)} {review.leverage > 1 ? 'margin' : 'to invest'} · {formatCurrency(review.ask)} quoted ask</p>
            {review.stopPrice != null && review.estimatedStopLoss != null && <>
              <p>{formatCurrency(review.exposure)} exposure · Stop at {formatCurrency(review.stopPrice)}</p>
              <p className="text-muted-foreground">{formatCurrency(review.estimatedStopLoss)} estimated loss at the stop before fees. A gap or slippage can increase the loss.</p>
            </>}
            {review.signal && <p>{review.signal}</p>}
            {review.review.strategy_exit_at && <p>Tideframe will attempt to close the position at {nyTime.format(new Date(review.review.strategy_exit_at))} ET.</p>}
            <CostBreakdown costs={review.costs} />
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
            <DialogDescription>
              {usePortfolio ? `${portfolio.strategies.length} strategies can trade across ${portfolio.symbols.length} stocks` : `${activeRule?.name} can open ${symbol} positions`} in eToro with {environment === 'demo' ? 'virtual funds' : 'real money'}.
              {leveraged ? ` ${leverage}× CFD · ${formatCurrency(Number(amount))} margin · ${formatCurrency(Number(amount) * leverage)} exposure.` : ` ${formatCurrency(Number(amount))} per cash position.`}
              {(usePortfolio ? portfolio.strategies.includes(EARNINGS_REBOUND.id) : earnings) ? ' The experimental earnings setup has a limited historical sample.' : ''}
            </DialogDescription>
          </DialogHeader>
          {usePortfolio && <p className="text-sm">Up to {portfolio.maxPositions} instruments · {formatCurrency(portfolio.maxExposure)} gross · {formatCurrency(portfolio.maxGroup)} per group · {formatCurrency(portfolio.dailyLoss)} daily equity loss · {portfolio.maxCostBps} bps entry cost limit</p>}
          {leveraged && <div className="space-y-2 text-sm">
            <p>Stop at {stop}% of margin · {formatCurrency(Number(amount) * Number(stop) / 100)} estimated loss before fees. Gaps and slippage can increase the loss.</p>
            <p className="text-muted-foreground">{autoCosts ? 'Indicative costs from eToro’s latest quote. Tideframe checks again at entry.' : 'Tideframe checks the eToro cost estimate before each entry.'}</p>
            {autoCosts && <CostBreakdown costs={autoCosts} />}
          </div>}
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setConfirmAuto(false)}>Cancel</Button>
            <Button disabled={!!busy} onClick={() => perform('start', async () => {
              try { setAuto(await autopilot({ action: 'start', symbol, strategy, amount: Number(amount), environment, confirmed: true, ...sizing, ...(usePortfolio ? { portfolio } : {}) })); }
              finally { setConfirmAuto(false); }
            })}>{busy === 'start' ? 'Starting…' : 'Confirm start'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
