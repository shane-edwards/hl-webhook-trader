'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Hand, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StockOrderTicket, type StockEnvironment } from '@/components/stocks/StockOrderTicket';
import { stockHref } from '@/components/layout/workspaces';
import { journeyHref } from '@/components/layout/journey';
import { automationVersion, type AutomationProfile, type Evidence } from '@/lib/automation/model';
import type { PaperResults } from '@/lib/automation/policy';
import type { StrategyIdea } from '@/lib/automation/ideas';
import { isStockTradeSymbol } from '@/lib/stocks/trade-rules';
import type { StockSizing } from '@/lib/stocks/leverage';
import { formatCurrency } from '@/lib/utils';

type Plan = Pick<AutomationProfile, 'mode' | 'live_version' | 'paper_version' | 'entries_paused' | 'enabled'>;
type Signal = { id: string; barT: number; side: 'long'; stopPct: number; reason: string };
type TradeState = {
  ready: Evidence | null;
  paper: PaperResults | null;
  profile?: Plan;
  connections: StockEnvironment[];
  hasWallet: boolean;
  isTestnet: boolean;
};

async function readResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Request failed.');
  return data;
}

function SignalOrder({ idea, hasWallet, isTestnet }: { idea: StrategyIdea; hasWallet: boolean; isTestnet: boolean }) {
  const [mode, setMode] = useState<'paper' | 'live'>('paper');
  const [signal, setSignal] = useState<Signal | null>(null);
  const [checked, setChecked] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  async function act(submit: boolean) {
    setBusy(true); setError(''); setStatus('');
    try {
      if (submit && signal) {
        await readResponse(await fetch('/api/autopilot', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'manual_entry', mode, isTestnet, idea: idea.id, confirmed: true, signal: { ...signal, symbol: idea.symbol } }) }));
        setSignal(null); setReview(false); setChecked(false);
        setStatus(mode === 'paper' ? 'Paper position opened.' : 'Order opened on Hyperliquid.');
      } else {
        setSignal(null);
        const query = new URLSearchParams({ mode, symbol: idea.symbol, idea: idea.id });
        const data = await readResponse(await fetch(`/api/autopilot?${query}`));
        setSignal(data.signals?.[0] ?? null); setChecked(true);
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not check the trade.'); }
    finally { setBusy(false); }
  }

  const liveLabel = isTestnet ? 'Testnet' : 'Live';
  return <section className="surface p-4 sm:p-5 space-y-4">
    <Segmented aria-label="Order environment" value={mode} options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: liveLabel }]}
      onChange={value => { setMode(value); setSignal(null); setChecked(false); setStatus(''); setError(''); }} />
    {mode === 'live' && !hasWallet ? <Button asChild><Link href="/settings">Connect Hyperliquid</Link></Button> :
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={signal ? 'outline' : 'default'} disabled={busy} onClick={() => void act(false)}>{busy ? 'Checking…' : checked ? 'Check again' : 'Check current signal'}</Button>
        {signal && <Button onClick={() => setReview(true)} disabled={busy}>Review buy</Button>}
        {checked && !signal && !busy && <span role="status" className="text-sm text-muted-foreground">No active entry signal</span>}
        {signal && <span role="status" className="text-sm text-profit">Buy signal</span>}
      </div>}
    {status && <p role="status" className="text-sm">{status}</p>}
    {error && <p role="alert" className="text-sm text-loss">{error}</p>}
    <Dialog open={review} onOpenChange={open => { if (!busy) setReview(open); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Buy {idea.symbol} · {mode === 'paper' ? 'Paper' : liveLabel}</DialogTitle>
          <DialogDescription>{idea.name} · {mode === 'paper' || isTestnet ? 'Simulated funds' : 'Real money'}</DialogDescription>
        </DialogHeader>
        {signal && <p className="text-sm">Stop distance {Number(signal.stopPct * 100).toFixed(2)}% · Up to 1× exposure</p>}
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setReview(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void act(true)}>{busy ? 'Submitting…' : 'Confirm buy'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

export function TradeActions({ idea, state, refresh, initialMethod, initialEnvironment, initialSizing }: {
  idea: StrategyIdea; state: TradeState; refresh: () => Promise<void>; initialMethod: 'manual' | 'automated'; initialEnvironment?: StockEnvironment; initialSizing?: StockSizing;
}) {
  const router = useRouter();
  const [method, setMethod] = useState(initialMethod);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'paper' | 'live' | null>(null);
  const [budget, setBudget] = useState('25');
  const [maxOrder, setMaxOrder] = useState('500');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const { profile, ready, paper } = state;
  const version = automationVersion(idea.market, idea.symbol, idea.rule);
  const active = !profile ? null : profile.mode === 'live' ? profile.live_version === version ? 'Live' : null
    : profile.mode === 'paper' && profile.paper_version === version ? 'Paper' : null;
  const running = !!active && !profile?.entries_paused && profile?.enabled && !!ready;
  const needsDemo = idea.market === 'stocks' && !state.connections.includes('demo');
  const activeOther = !!profile && profile.mode !== 'research' && !active && !profile.entries_paused;
  const realConnected = idea.market === 'stocks' ? state.connections.includes('real') : state.hasWallet && !state.isTestnet;
  const connect = (mode: StockEnvironment, params?: Record<string, string>) => stockHref('account', {
    ...params, mode, returnTo: 'journey-trade', idea: idea.id, method,
  });

  async function change(payload: object) {
    setBusy(true); setStatus(''); setError('');
    try {
      const response = await readResponse(await fetch('/api/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market: idea.market, ...payload }) }));
      setConfirm(null);
      await refresh();
      setStatus(response.message);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not update the plan.'); }
    finally { setBusy(false); }
  }

  function apply(event: FormEvent) {
    event.preventDefault();
    if (confirm === 'paper') void change({ action: 'paper', idea: idea.id });
    if (confirm === 'live') void change({ action: 'approve', version, budget: Number(budget), maxOrder: Number(maxOrder), confirmed: true });
  }

  if (!idea.executable) return <div className="surface p-5 flex flex-wrap items-center justify-between gap-3">
    <span className="text-sm font-medium">Research-only strategy</span>
    <Button asChild><Link href={journeyHref('find', idea.market)}>Find a tradeable strategy</Link></Button>
  </div>;

  return <div className="space-y-4">
    <div className="grid gap-2 grid-cols-2" aria-label="How to trade">
      {([{ id: 'manual', label: 'Manual', icon: Hand }, { id: 'automated', label: 'Automated', icon: Bot }] as const).map(({ id, label, icon: Icon }) =>
        <Button key={id} aria-pressed={method === id} variant={method === id ? 'default' : 'outline'} className="h-12" onClick={() => { setMethod(id); setError(''); setStatus(''); }}><Icon className="w-4 h-4" />{label}</Button>)}
    </div>
    {method === 'manual' ? idea.market === 'stocks' && isStockTradeSymbol(idea.symbol)
      ? <StockOrderTicket flow="manual" connections={state.connections} initialSymbol={idea.symbol} initialRule={idea.rule} initialEnvironment={initialEnvironment} initialSizing={initialSizing} compact
          onConnect={(environment, symbol, rule, size) => router.push(connect(environment, { symbol, rule, ...size }))} />
      : <SignalOrder idea={idea} hasWallet={state.hasWallet} isTestnet={state.isTestnet} />
    : <section className="surface p-4 sm:p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="font-semibold">{running ? `${active} automation active` : active ? `${active} automation on hold` : activeOther ? 'Another setup is automated' : 'Automate this setup'}</h2>
          {!!paper?.closed && <p className="mt-1 text-xs text-muted-foreground">{paper.closed} closed Paper trades · {formatCurrency(paper.net)} net</p>}
        </div>
        {active && !profile?.entries_paused && <Button variant="outline" disabled={busy} onClick={() => void change({ action: 'entries', paused: true })}><Pause size={16} />Pause entries</Button>}
        {active && profile?.entries_paused && ready && profile.enabled && (active !== 'Live' || paper?.passed) &&
          <Button variant="outline" disabled={busy} onClick={() => void change({ action: 'entries', paused: false })}><Play size={16} />Resume {active}</Button>}
      </div>
      {!ready ? <Button asChild variant="outline"><Link href={journeyHref('test', idea.market, idea.id)}>Review backtest</Link></Button>
        : activeOther ? <Button asChild variant="outline"><Link href="/automation">Manage active setup</Link></Button>
          : <div className="flex flex-wrap items-center gap-3">
            {!active && (needsDemo ? <Button asChild><Link href={connect('demo')}>Connect eToro Demo</Link></Button>
              : <Button disabled={busy} onClick={() => setConfirm('paper')}>Start Paper automation</Button>)}
            {active !== 'Live' && (paper?.passed
              ? realConnected ? <Button variant="outline" disabled={busy} onClick={() => setConfirm('live')}>Review Live approval</Button>
                : <Button asChild variant="outline"><Link href={idea.market === 'stocks' ? connect('real') : '/settings'}>Connect Live account</Link></Button>
              : <span className="text-xs text-muted-foreground">Live review opens after Paper qualifies</span>)}
          </div>}
      {status && <p role="status" className="text-sm">{status}</p>}
      {error && <p role="alert" className="text-sm text-loss">{error}</p>}
    </section>}
    <Dialog open={!!confirm} onOpenChange={open => { if (!open && !busy) setConfirm(null); }}>
      <DialogContent><form className="space-y-4" onSubmit={apply}>
        <DialogHeader>
          <DialogTitle>{confirm === 'live' ? 'Approve Live automation' : 'Start Paper automation'}</DialogTitle>
          <DialogDescription>{idea.name} · {idea.symbol} · {confirm === 'live' ? 'Real-money orders' : 'Simulated funds'}</DialogDescription>
        </DialogHeader>
        {confirm === 'live' && <div className="space-y-3">
          <label className="block text-sm">Loss budget per trade (USD)<Input value={budget} onChange={e => setBudget(e.target.value)} type="number" min="1" max="10000" step=".01" required /></label>
          <label className="block text-sm">Maximum order size (USD)<Input value={maxOrder} onChange={e => setMaxOrder(e.target.value)} type="number" min="10" max="10000" step=".01" required /></label>
          <p className="text-xs text-muted-foreground">{idea.market === 'stocks' ? 'Cash sizing assumes the full investment plus fees is at risk.' : 'Actual losses can exceed the budget if price gaps through the stop.'}</p>
        </div>}
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : confirm === 'live' ? 'Confirm Live' : 'Confirm Paper'}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  </div>;
}
