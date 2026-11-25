'use client';

import { useCallback, useEffect, useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Stat } from '@/components/ui/stat';
import { Segmented } from '@/components/ui/segmented';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertTriangle, Bot, Loader2, Pause, Play, RotateCcw, Save, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn, formatCurrency, formatPrice, formatRelativeTime } from '@/lib/utils';
import type { Settings } from '@/types';
import { DriftPanel } from '@/components/autopilot/DriftPanel';

interface Evidence {
  allowShort: boolean; liveEligible: boolean; gatePassed?: boolean;
  late: { annualReturn: number; avgNetBps: number | null; tradesPerYear: number; winRate: number; maxDrawdown: number; sharpe: number };
  early: { annualReturn: number };
  recent?: { annualReturn: number };
}
interface StrategyInfo {
  id: string; name: string; style: string; description: string; horizon: string; evidence: Evidence[];
  /** Sides automatic Live entries may take with shorts off and on: null = Paper only, false = long only, true = long and short. */
  live: { longOnly: boolean | null; withShorts: boolean | null };
}
interface Position {
  id: string; symbol: string; strategy_id: string; side: 'long' | 'short'; status: 'open' | 'closed';
  recovery_pending?: boolean; entry_price: number; notional_usd: number; stop_price: number; entry_time: string; entry_reason: string | null;
  exit_price: number | null; exit_time: string | null; exit_reason: string | null; pnl: number | null;
}
interface EventRow { id: string; mode: string; level: 'info' | 'trade' | 'warn' | 'error'; symbol: string | null; message: string; created_at: string }
interface Data {
  available: boolean; hasWallet?: boolean; isTestnet?: boolean; evidenceThrough: string; evidenceCoins: string[];
  mode?: 'paper' | 'live';
  strategies: StrategyInfo[];
  scalpSearch?: { tested: number; confirmed: number; through: string };
  state?: { day_start_equity: number | null; peak_equity: number | null; halted_reason: string | null; paper_equity: number; last_run_at: string | null } | null;
  positions?: Position[]; events?: EventRow[];
  /** Current mid price per market with an open position, and when they were read. */
  prices?: Record<string, number>; pricesAt?: number;
}
type AutoSettings = Settings & {
  autopilot_enabled?: boolean; autopilot_mode?: 'paper' | 'live'; autopilot_symbols?: string[]; autopilot_strategies?: string[];
  autopilot_live_rules_confirmed?: boolean;
  autopilot_allow_short?: boolean; autopilot_risk_per_trade_pct?: number; autopilot_max_positions?: number;
  autopilot_max_leverage?: number; autopilot_daily_loss_limit_pct?: number; autopilot_max_drawdown_pct?: number;
};
type ManualSignal = { id: string; name: string; side: 'long' | 'short' | 'long/short'; barT: number; stopPct: number; reason: string; plan?: string };

const pct = (v: number, d = 0) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const LEVEL_STYLE: Record<EventRow['level'], string> = { trade: 'bg-primary', info: 'bg-muted-foreground/50', warn: 'bg-warning', error: 'bg-loss' };
const STALE_MS = 20 * 60_000;
/** The cross-coin basket has no per-position stop; the stored figure is a far-away placeholder. */
const BASKET_ID = 'xs_momentum_90';

/** The side(s) a rule enters automatically in Live, or null when its automatic entries stay on Paper. */
function liveSides(s: StrategyInfo, shorts: boolean): 'long only' | 'long and short' | null {
  const direction = shorts ? s.live.withShorts : s.live.longOnly;
  return direction === null ? null : direction ? 'long and short' : 'long only';
}

/** Mark-to-market result of an open position: price move only, before the cost of closing it. */
function unrealised(p: Position, price: number | undefined): { usd: number; pct: number } | null {
  const entry = Number(p.entry_price);
  if (!(price! > 0) || !(entry > 0)) return null;
  const move = (p.side === 'long' ? 1 : -1) * (price! / entry - 1);
  return { usd: Number(p.notional_usd) * move, pct: move * 100 };
}

export default function AutopilotPage() {
  const [data, setData] = useState<Data | null>(null);
  const [settings, setSettings] = useState<AutoSettings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState<'start' | null>(null);
  const [manualSymbol, setManualSymbol] = useState('');
  const [signals, setSignals] = useState<ManualSignal[] | null>(null);
  const [review, setReview] = useState<ManualSignal | null>(null);
  // The clock is state so the stale-scan warning is computed from a value React knows about.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(id); }, []);
  // Refresh positions and prices every minute. Settings are left alone, so a half-edited form is not reset.
  useEffect(() => {
    const id = setInterval(() => { fetch('/api/autopilot').then(r => (r.ok ? r.json() : null)).then(a => { if (a) setData(current => current?.mode === a.mode ? a : current); }).catch(() => {}); }, 60_000);
    return () => clearInterval(id);
  }, []);
  // form
  const [symbols, setSymbols] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [allowShort, setAllowShort] = useState(false);
  const [risk, setRisk] = useState({ perTrade: '0.5', maxPositions: '3', maxLeverage: '2', dailyLoss: '3', maxDrawdown: '15' });

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [a, s] = await Promise.all([fetch('/api/autopilot').then(r => r.json()), fetch('/api/settings').then(r => r.json())]);
      setData(a);
      const st = s.settings as AutoSettings | null;
      setSettings(st);
      if (st && st.autopilot_enabled !== undefined) {
        setSymbols((st.autopilot_symbols ?? []).join(', '));
        setSelected(st.autopilot_strategies ?? []);
        setAllowShort(st.autopilot_allow_short ?? false);
        setManualSymbol(current => st.autopilot_symbols?.includes(current) || (current === 'BASKET' && st.autopilot_strategies?.includes(BASKET_ID)) ? current : st.autopilot_symbols?.[0] ?? '');
        setRisk({
          perTrade: String(st.autopilot_risk_per_trade_pct ?? 0.5), maxPositions: String(st.autopilot_max_positions ?? 3),
          maxLeverage: String(st.autopilot_max_leverage ?? 2), dailyLoss: String(st.autopilot_daily_loss_limit_pct ?? 3),
          maxDrawdown: String(st.autopilot_max_drawdown_pct ?? 15),
        });
      }
    } catch {
      toast.error('Could not load the autopilot');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function put(body: Record<string, unknown>, okMessage: string) {
    setBusy('save');
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedAutopilotMode: mode }),
      });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error ?? 'Could not save'); return; }
      setSignals(null);
      await load();
      toast.success(okMessage);
    } catch {
      toast.error('Could not save Autopilot settings');
    } finally {
      setBusy(null);
    }
  }

  async function action(name: 'scan' | 'reset' | 'reset_paper', okMessage: string) {
    setBusy(name);
    try {
      const res = await fetch('/api/autopilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, mode, isTestnet: data?.isTestnet }) });
      const d = await res.json();
      if (!res.ok) { toast.error(d.error ?? 'Request failed', { duration: 10000 }); return; }
      toast.success(name === 'scan' ? `Scan done: ${d.result.events.length} event${d.result.events.length === 1 ? '' : 's'}${d.result.haltReason ? ` · ${d.result.haltReason}` : ''}` : okMessage);
      await load();
    } catch {
      toast.error('Request failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveConfig() {
    await put({
      autopilot_symbols: symbols.split(/[\s,]+/).filter(Boolean),
      autopilot_strategies: selected,
      autopilot_allow_short: allowShort,
      autopilot_risk_per_trade_pct: parseFloat(risk.perTrade),
      autopilot_max_positions: parseInt(risk.maxPositions, 10),
      autopilot_max_leverage: parseFloat(risk.maxLeverage),
      autopilot_daily_loss_limit_pct: parseFloat(risk.dailyLoss),
      autopilot_max_drawdown_pct: parseFloat(risk.maxDrawdown),
    }, mode === 'live' && enabled ? 'Saved. Confirm Start live to resume new entries.' : 'Autopilot settings saved');
  }

  async function findSignals() {
    setBusy('signals');
    setSignals(null);
    try {
      const response = await fetch(`/api/autopilot?${new URLSearchParams({ mode, symbol: manualSymbol })}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      setSignals(payload.signals);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not look up signals');
    } finally {
      setBusy(null);
    }
  }

  async function openSignal(signal: ManualSignal) {
    setBusy('trade');
    try {
      const response = await fetch('/api/autopilot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'manual_entry', mode, isTestnet: data?.isTestnet, signal: { ...signal, symbol: manualSymbol } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error);
      toast.success(mode === 'paper' ? 'Paper position opened' : 'Exchange position opened');
      setSignals(null);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Check positions before retrying');
      setSignals(null);
    } finally {
      setReview(null);
      setBusy(null);
    }
  }

  const loading = !data || !settings;
  const available = data?.available === true;
  const mode = settings?.autopilot_mode ?? 'paper';
  const enabled = settings?.autopilot_enabled === true;
  const state = data?.state;
  const open = (data?.positions ?? []).filter(p => p.status === 'open');
  const closed = (data?.positions ?? []).filter(p => p.status === 'closed');
  const openMarks = open.map(p => unrealised(p, data?.prices?.[p.symbol]));
  const openPnl = openMarks.some(m => m) ? openMarks.reduce((a, m) => a + (m?.usd ?? 0), 0) : null;
  const strategyName = (id: string) => (id === BASKET_ID ? 'Momentum basket' : data?.strategies.find(x => x.id === id)?.name ?? id);
  const closedPnl = closed.reduce((a, p) => a + Number(p.pnl ?? 0), 0);
  const wins = closed.filter(p => Number(p.pnl) > 0).length;
  const lastRun = state?.last_run_at ? new Date(state.last_run_at).getTime() : null;
  const stale = enabled && (lastRun === null || now - lastRun > STALE_MS);
  const supportedByEvidence = (s: StrategyInfo) => liveSides(s, allowShort) !== null;
  const savedIds = settings?.autopilot_strategies ?? [];
  const ready = (data?.strategies ?? []).filter(s => savedIds.includes(s.id));
  // Automatic Live entries are limited to rules that passed the backtest. The rest of the selection only trades on Paper.
  const savedShorts = settings?.autopilot_allow_short ?? false;
  const liveReady = ready.filter(s => liveSides(s, savedShorts) !== null);
  const paperOnly = ready.filter(s => liveSides(s, savedShorts) === null);
  const liveNames = liveReady.map(s => `${s.name} (${liveSides(s, savedShorts)})`).join(', ');
  const paperOnlyNames = paperOnly.map(s => s.name).join(', ');
  const label = mode === 'paper' ? 'Paper' : data?.isTestnet ? 'Live · Testnet' : 'Live';
  const changes = symbols !== (settings?.autopilot_symbols ?? []).join(', ')
    || JSON.stringify(selected) !== JSON.stringify(savedIds) || allowShort !== (settings?.autopilot_allow_short ?? false)
    || Object.entries({ perTrade: settings?.autopilot_risk_per_trade_pct ?? 0.5, maxPositions: settings?.autopilot_max_positions ?? 3, maxLeverage: settings?.autopilot_max_leverage ?? 2, dailyLoss: settings?.autopilot_daily_loss_limit_pct ?? 3, maxDrawdown: settings?.autopilot_max_drawdown_pct ?? 15 }).some(([key, value]) => risk[key as keyof typeof risk] !== String(value));

  return (
    <div className="flex flex-col min-h-full">
      <Header onRefresh={() => load(true)} refreshing={refreshing} />

      <div className="p-4 lg:p-8 space-y-4 lg:space-y-6 flex-1 w-full max-w-[1400px] mx-auto">
        {loading ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : !available ? (
          <div className="surface p-6 text-sm text-muted-foreground">
            Run <code className="bg-secondary px-1 rounded">supabase/migrations/004_autopilot.sql</code> in the Supabase SQL editor to enable the autopilot, then reload.
          </div>
        ) : (
          <>
            {/* Control */}
            <section className="surface p-5" aria-label="Autopilot control">
              {/* On a phone the title and strategy list take the full width and the controls drop below them. */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                <div className="flex items-center gap-3 min-w-0 basis-full sm:basis-0 sm:flex-1">
                  <div className={cn('flex items-center justify-center w-11 h-11 rounded-xl shrink-0', enabled ? (mode === 'live' ? 'bg-profit/10 text-profit' : 'bg-warning/10 text-warning') : 'bg-secondary text-muted-foreground')}>
                    <Bot className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold">{label} Autopilot</h2>
                      <Badge variant={!enabled || state?.halted_reason ? 'secondary' : mode === 'live' ? 'profit' : 'warning'}>{!enabled || state?.halted_reason ? 'Paused' : 'Running'}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {(mode === 'live' && ready.length ? liveNames || 'No selected strategy can trade Live' : ready.map(s => s.name).join(', ')) || 'Choose a strategy below'} · {settings.autopilot_symbols?.length ?? 0} markets
                      {mode === 'live' && paperOnly.length > 0 && ` · Paper only: ${paperOnlyNames}`}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented
                    aria-label="Mode"
                    value={mode}
                    onChange={m => { if (!busy && !changes && m !== mode) void put({ autopilot_mode: m }, 'Mode switched. New entries are paused.'); }}
                    disabled={busy !== null || changes}
                    options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]}
                  />
                  <Button onClick={() => enabled ? put({ autopilot_enabled: false }, 'New entries paused') : mode === 'live' ? setConfirmLive('start') : put({ autopilot_enabled: true }, 'Paper Autopilot started')} disabled={busy !== null || (!enabled && (changes || !ready.length || !!state?.halted_reason || (mode === 'live' && (!data.hasWallet || !liveReady.length))))}>
                    {enabled ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                    {enabled ? 'Pause entries' : mode === 'paper' ? 'Start paper' : 'Start live'}
                  </Button>
                </div>
              </div>
              {mode === 'live' && !data.hasWallet && <p className="mt-3 text-sm text-muted-foreground"><Link className="text-primary underline" href="/settings">Connect a Hyperliquid wallet</Link> to trade on the exchange.</p>}
              {mode === 'paper' && !enabled && !changes && <p className="mt-3 text-sm text-muted-foreground">Review your strategy below, then choose Start paper to practice with simulated funds.</p>}
              {mode === 'live' && ready.length > 0 && !liveReady.length && <p className="mt-3 text-sm text-warning">None of the selected strategies has passed the backtest required for automatic Live entries. Select one marked Live eligible, or continue in Paper.</p>}
              {mode === 'live' && liveReady.length > 0 && paperOnly.length > 0 && <p className="mt-3 text-sm text-muted-foreground">Live places automatic orders for {liveNames} only. {paperOnlyNames} {paperOnly.length === 1 ? 'has' : 'have'} not passed the backtest and will not open automatic Live trades.</p>}
              {changes && <p className="mt-3 text-sm text-warning">Save or discard your changes below before starting or switching modes.</p>}

              {state?.halted_reason && (
                <div className="mt-4 rounded-lg border border-loss/30 bg-loss/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-loss flex gap-2"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />Paused by the drawdown limit: {state.halted_reason}. No new trades until you reset.</p>
                  <Button variant="outline" size="sm" onClick={() => action('reset', 'Pause cleared')} disabled={busy !== null}><RotateCcw className="w-3.5 h-3.5" />Reset and resume</Button>
                </div>
              )}
              {stale && (
                <p className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{lastRun ? 'Last scan was more than 20 minutes ago. Check Activity for errors.' : 'Waiting for the first scheduled scan.'}</span>
                </p>
              )}
            </section>

            <section className="surface p-5 space-y-3" aria-label="Trade a strategy manually">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 className="text-sm font-semibold self-center">Trade a strategy manually</h2>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-muted-foreground">Market
                    <select value={manualSymbol} disabled={busy !== null} onChange={e => { setManualSymbol(e.target.value); setSignals(null); }} className="block h-9 mt-1 rounded-md border bg-background px-2 text-sm text-foreground">
                      {(settings.autopilot_symbols ?? []).map(symbol => <option key={symbol}>{symbol}</option>)}
                      {savedIds.includes(BASKET_ID) && <option value="BASKET">Momentum basket</option>}
                    </select>
                  </label>
                  <Button variant="outline" disabled={busy !== null || changes || !manualSymbol || !ready.length} onClick={findSignals}>{busy === 'signals' ? 'Checking…' : 'Find signals'}</Button>
                </div>
              </div>
              {mode === 'live' && paperOnly.length > 0 && <p className="text-xs text-muted-foreground">A manual Live trade can use any selected rule, including Paper-only ones. You review each order before it is sent.</p>}
              {signals?.length === 0 && <p role="status" className="text-sm text-muted-foreground">{manualSymbol === 'BASKET' ? 'No basket available. Check the open positions and position limit.' : `No current setup for ${manualSymbol}.`}</p>}
              {signals?.map(signal => (
                <div key={signal.id} className="flex flex-wrap justify-between items-center gap-2 border-t pt-3">
                  <div><p className="text-sm font-medium">{signal.name} · {signal.side}</p><p className="text-xs text-muted-foreground">{(signal.stopPct * 100).toFixed(2)}% stop · {signal.reason}</p></div>
                  <Button size="sm" disabled={busy !== null || changes || (mode === 'live' && !data.hasWallet)} onClick={() => setReview(signal)}>Review {label} trade</Button>
                </div>
              ))}
            </section>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
              <Stat label={mode === 'paper' ? 'Paper balance' : 'Day-start equity'} value={mode === 'paper' ? formatCurrency(Number(state?.paper_equity ?? 10000)) : state?.day_start_equity ? formatCurrency(Number(state.day_start_equity)) : '—'} hint={mode === 'paper' ? 'Started at $10,000' : 'Live account'} />
              <Stat label="Closed trades" value={String(closed.length)} hint={closed.length ? `${wins} won · ${closed.length - wins} lost` : 'None yet'} />
              <Stat label="Realised P&L" value={formatCurrency(closedPnl)} hint="After fees, this mode" tone={closedPnl > 0 ? 'up' : closedPnl < 0 ? 'down' : 'neutral'} />
              <Stat label="Open positions" value={String(open.length)} />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6 items-start">
              {/* Strategies */}
              <section className="xl:col-span-2 space-y-3" aria-label="Strategies">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">Strategies</h2>
                  <p className="text-xs text-muted-foreground text-right">Paper trades every selected rule. Automatic Live entries use only rules marked Live eligible.</p>
                </div>
                {[...data.strategies].sort((a, b) => Number(supportedByEvidence(b)) - Number(supportedByEvidence(a))).map(s => {
                  const e = s.evidence.find(x => x.allowShort === allowShort);
                  const on = selected.includes(s.id);
                  const sides = liveSides(s, allowShort);
                  return (
                    <div key={s.id} className={cn('surface p-4 transition-colors', on && 'border-primary/40')}>
                      <div className="flex items-start gap-3">
                        <Switch checked={on} onCheckedChange={v => setSelected(prev => (v ? [...prev, s.id] : prev.filter(x => x !== s.id)))} aria-label={`Enable ${s.name}`} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold">{s.name}</h3>
                            <Badge variant={sides ? 'profit' : 'secondary'} className="text-[10px] py-0">{!sides ? 'Paper only' : allowShort ? `Live eligible · ${sides}` : 'Live eligible'}</Badge>
                            <span className="text-[11px] text-muted-foreground">{s.horizon}</span>
                          </div>
                          <details className="mt-2 text-xs text-muted-foreground">
                            <summary className="cursor-pointer hover:text-foreground">Rule and test results</summary>
                            <p className="mt-2">{s.description}</p>
                            {e && <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3">
                              {[
                                ['Return / yr since 2023', pct(e.late.annualReturn), e.late.annualReturn],
                                ['Of which 2025 on', e.recent ? pct(e.recent.annualReturn) : '—', e.recent?.annualReturn ?? 0],
                                ['Avg trade after costs', e.late.avgNetBps == null ? '—' : `${e.late.avgNetBps.toFixed(0)} bps`, e.late.avgNetBps ?? 0],
                                ['Worst drawdown', `-${(e.late.maxDrawdown * 100).toFixed(0)}%`, 0],
                              ].map(([k, v, sign]) => (
                                <div key={k as string}>
                                  <dt className="eyebrow">{k}</dt>
                                  <dd className={cn('num text-sm font-medium mt-0.5', (sign as number) > 0 && 'text-profit', (sign as number) < 0 && 'text-loss')}>{v}</dd>
                                </div>
                              ))}
                            </dl>}
                            <p className="mt-2">Backtest through {data.evidenceThrough} on {data.evidenceCoins.join(', ')}.</p>
                          </details>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </section>

              {/* Risk */}
              <section className="surface p-5 space-y-4" aria-label="Risk settings">
                <h2 className="text-sm font-semibold">Setup</h2>
                <div className="space-y-1.5">
                  <Label htmlFor="auto-markets">Markets to scan</Label>
                  <Input id="auto-markets" value={symbols} onChange={e => setSymbols(e.target.value.toUpperCase())} placeholder="BTC, ETH, SOL" className="font-mono text-xs" />
                </div>
                <details>
                <summary className="cursor-pointer text-sm font-medium">Risk limits and short selling</summary>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['perTrade', 'Risk per trade %', 'Lost if a stop is hit'],
                    ['maxPositions', 'Max positions', 'Open at once'],
                    ['maxLeverage', 'Max leverage ×', 'Per position'],
                    ['dailyLoss', 'Daily loss limit %', 'Stops new trades today'],
                    ['maxDrawdown', 'Max drawdown %', 'Pauses the autopilot'],
                  ] as const).map(([key, label, hint]) => (
                    <div key={key} className="space-y-1">
                      <Label htmlFor={`auto-${key}`}>{label}</Label>
                      <Input id={`auto-${key}`} type="number" inputMode="decimal" step="any" value={risk[key]} onChange={e => setRisk(r => ({ ...r, [key]: e.target.value }))} />
                      <p className="text-[11px] text-muted-foreground">{hint}</p>
                    </div>
                  ))}
                </div>
                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="text-sm font-medium block">Allow shorts</span>
                  </span>
                  <Switch checked={allowShort} onCheckedChange={setAllowShort} />
                </label>
                </details>
                <Button className="w-full" onClick={saveConfig} disabled={busy !== null || !changes}>
                  {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save strategies and limits
                </Button>
                {changes && <Button variant="ghost" className="w-full" disabled={busy !== null} onClick={() => load(true)}>Discard changes</Button>}
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Maintenance</summary>
                  <Button variant="ghost" size="sm" onClick={() => action('scan', '')} disabled={busy !== null || changes}>Scan now</Button>
                  {mode === 'paper' && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { if (window.confirm('Clear your paper positions and balance history?')) void action('reset_paper', 'Paper account reset to $10,000'); }} disabled={busy !== null || enabled}>
                    <RotateCcw className="w-3.5 h-3.5" />Reset paper account
                  </Button>}
                </details>
              </section>
            </div>

            {/* Positions */}
            <section className="surface overflow-hidden" aria-label="Autopilot positions">
              <div className="px-5 pt-5 pb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Positions · {mode}</h2>
                <p className="text-xs text-muted-foreground text-right">
                  {open.length} open · {closed.length} closed
                  {open.length > 0 && openPnl != null && <> · open positions <span className={cn('num', openPnl >= 0 ? 'text-profit' : 'text-loss')}>{formatCurrency(openPnl)}</span></>}
                </p>
              </div>
              {open.length > 0 && (
                <p className="px-5 pb-3 -mt-1 text-[11px] text-muted-foreground">
                  {data.pricesAt && Object.keys(data.prices ?? {}).length
                    ? `Open positions are valued at the price as of ${new Date(data.pricesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, refreshed every minute. The figure is the price move only: closing costs about 0.07% more.`
                    : 'Current prices could not be loaded, so open positions show no running figure.'}
                </p>
              )}
              {(data.positions ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10 px-6">No positions yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>Market</th><th>Strategy</th><th>Side</th><th className="hidden sm:table-cell">Size</th><th>Entry</th><th>Now / exit</th><th className="hidden lg:table-cell">Stop</th><th className="hidden xl:table-cell">Why</th><th>P&amp;L</th></tr></thead>
                    <tbody>
                      {(data.positions ?? []).map(p => {
                        const isOpen = p.status === 'open';
                        const price = data.prices?.[p.symbol];
                        const live = isOpen && !p.recovery_pending ? unrealised(p, price) : null;
                        const pnl = isOpen ? live?.usd ?? null : p.pnl == null ? null : Number(p.pnl);
                        return (
                          <tr key={p.id}>
                            <td><span className="font-medium text-foreground">{p.symbol}</span>{isOpen && <Badge variant={p.recovery_pending ? 'warning' : 'open'} className="ml-2 text-[10px] py-0">{p.recovery_pending ? 'RECOVERING' : 'OPEN'}</Badge>}</td>
                            <td className="text-xs text-muted-foreground whitespace-nowrap">{strategyName(p.strategy_id)}</td>
                            <td className={p.side === 'long' ? 'text-profit' : 'text-loss'}>{p.side}</td>
                            <td className="num hidden sm:table-cell">{formatCurrency(Number(p.notional_usd), 0)}</td>
                            <td className="num">${formatPrice(Number(p.entry_price))}</td>
                            <td className="num">{isOpen ? (price ? `$${formatPrice(price)}` : '—') : <span className="text-muted-foreground">${formatPrice(Number(p.exit_price ?? 0))}</span>}</td>
                            <td className="num text-muted-foreground hidden lg:table-cell">{!isOpen || p.recovery_pending || !Number(p.stop_price) ? '—' : `$${formatPrice(Number(p.stop_price))}`}</td>
                            <td className="hidden xl:table-cell text-xs text-muted-foreground max-w-[240px] truncate">{isOpen ? p.entry_reason : p.exit_reason}</td>
                            <td className={cn('num whitespace-nowrap', pnl == null ? 'text-muted-foreground' : pnl >= 0 ? 'text-profit' : 'text-loss')}>
                              {pnl == null ? '—' : formatCurrency(pnl)}
                              {live && <span className="block text-[10px] font-normal opacity-80">{live.pct >= 0 ? '+' : ''}{live.pct.toFixed(2)}% · open</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Activity */}
            <details className="surface p-5" aria-label="Activity">
              <summary className="cursor-pointer text-sm font-semibold">Activity {lastRun ? `· Last scan ${formatRelativeTime(state!.last_run_at!)}` : ''}</summary>
              <div className="mt-3">
              {(data.events ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet. Press “Scan now” to run one pass.</p>
              ) : (
                <ul className="space-y-2">
                  {(data.events ?? []).map(e => (
                    <li key={e.id} className="flex items-start gap-2.5 text-xs">
                      <span className={cn('w-1.5 h-1.5 rounded-full mt-1.5 shrink-0', LEVEL_STYLE[e.level])} aria-hidden />
                      <span className="flex-1 min-w-0 break-words"><span className="text-muted-foreground uppercase tracking-wide text-[10px] mr-1.5">{e.level}</span>{e.symbol && <span className="font-medium mr-1.5">{e.symbol}</span>}<span className="text-muted-foreground">{e.message}</span></span>
                      <span className="text-muted-foreground shrink-0">{formatRelativeTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              </div>
              {mode === 'paper' && <DriftPanel refreshKey={data.positions?.length ?? 0} />}
            </details>
          </>
        )}
      </div>

      <Dialog open={!!confirmLive} onOpenChange={open => { if (!open) setConfirmLive(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start {label} Autopilot?</DialogTitle>
            <DialogDescription>
              {liveNames} can place orders automatically on Hyperliquid {data?.isTestnet ? 'testnet' : 'with real money'}. {paperOnly.length > 0 && `${paperOnlyNames} ${paperOnly.length === 1 ? 'has' : 'have'} not passed the backtest and will not open automatic Live trades. `}Confirming does not add any other rule. The configured risk per trade is {settings?.autopilot_risk_per_trade_pct}%.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLive(null)}>Cancel</Button>
            <Button variant="destructive" disabled={!data?.hasWallet || !liveReady.length || busy !== null} onClick={() => { setConfirmLive(null); void put({ autopilot_enabled: true, confirmLiveAutopilot: true, isTestnet: data?.isTestnet }, 'Live Autopilot started'); }}>Confirm start</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!review} onOpenChange={open => { if (!open && busy !== 'trade') setReview(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{manualSymbol === 'BASKET' ? 'Momentum basket' : `${manualSymbol} ${review?.side}`} · {label}</DialogTitle>
            <DialogDescription>{review?.name} sets the stop and manages the exit. Size uses your Autopilot limits, with up to {settings?.autopilot_risk_per_trade_pct}% account risk and a {((review?.stopPct ?? 0) * 100).toFixed(2)}% stop. {mode === 'live' && !data?.isTestnet ? 'This sends real orders.' : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)} disabled={busy === 'trade'}>Cancel</Button>
            <Button disabled={busy !== null || !review} onClick={() => { if (review) void openSignal(review); }}>{busy === 'trade' ? 'Opening…' : mode === 'paper' ? 'Open paper trade' : 'Submit order'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
