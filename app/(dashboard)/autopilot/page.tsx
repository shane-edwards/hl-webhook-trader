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
import { AlertTriangle, Bot, Loader2, Play, RotateCcw, Save, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { cn, formatCurrency, formatPrice, formatRelativeTime } from '@/lib/utils';
import type { Settings } from '@/types';

interface Evidence {
  allowShort: boolean; liveEligible: boolean;
  late: { annualReturn: number; avgNetBps: number | null; tradesPerYear: number; winRate: number; maxDrawdown: number; sharpe: number };
  early: { annualReturn: number };
  recent?: { annualReturn: number };
}
interface StrategyInfo { id: string; name: string; style: string; description: string; horizon: string; evidence: Evidence[] }
interface Position {
  id: string; symbol: string; strategy_id: string; side: 'long' | 'short'; status: 'open' | 'closed';
  entry_price: number; notional_usd: number; stop_price: number; entry_time: string; entry_reason: string | null;
  exit_price: number | null; exit_time: string | null; exit_reason: string | null; pnl: number | null;
}
interface EventRow { id: string; mode: string; level: 'info' | 'trade' | 'warn' | 'error'; symbol: string | null; message: string; created_at: string }
interface Data {
  available: boolean; hasWallet?: boolean; isTestnet?: boolean; evidenceThrough: string; evidenceCoins: string[];
  strategies: StrategyInfo[];
  scalpSearch?: { tested: number; confirmed: number; through: string };
  state?: { day_start_equity: number | null; peak_equity: number | null; halted_reason: string | null; paper_equity: number; last_run_at: string | null } | null;
  positions?: Position[]; events?: EventRow[];
}
type AutoSettings = Settings & {
  autopilot_enabled?: boolean; autopilot_mode?: 'paper' | 'live'; autopilot_symbols?: string[]; autopilot_strategies?: string[];
  autopilot_allow_short?: boolean; autopilot_risk_per_trade_pct?: number; autopilot_max_positions?: number;
  autopilot_max_leverage?: number; autopilot_daily_loss_limit_pct?: number; autopilot_max_drawdown_pct?: number;
};

const pct = (v: number, d = 0) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const LEVEL_STYLE: Record<EventRow['level'], string> = { trade: 'bg-primary', info: 'bg-muted-foreground/50', warn: 'bg-warning', error: 'bg-loss' };
const STALE_MS = 20 * 60_000;

export default function AutopilotPage() {
  const [data, setData] = useState<Data | null>(null);
  const [settings, setSettings] = useState<AutoSettings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
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
    const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) { toast.error(d.error ?? 'Could not save'); return false; }
    setSettings(d.settings);
    toast.success(okMessage);
    return true;
  }

  async function action(name: 'scan' | 'reset' | 'reset_paper', okMessage: string) {
    setBusy(name);
    try {
      const res = await fetch('/api/autopilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name }) });
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
    setBusy('save');
    await put({
      autopilot_symbols: symbols.split(/[\s,]+/).filter(Boolean),
      autopilot_strategies: selected,
      autopilot_allow_short: allowShort,
      autopilot_risk_per_trade_pct: parseFloat(risk.perTrade),
      autopilot_max_positions: parseInt(risk.maxPositions, 10),
      autopilot_max_leverage: parseFloat(risk.maxLeverage),
      autopilot_daily_loss_limit_pct: parseFloat(risk.dailyLoss),
      autopilot_max_drawdown_pct: parseFloat(risk.maxDrawdown),
    }, 'Autopilot settings saved');
    setBusy(null);
  }

  const loading = !data || !settings;
  const available = data?.available === true;
  const mode = settings?.autopilot_mode ?? 'paper';
  const enabled = settings?.autopilot_enabled === true;
  const state = data?.state;
  const open = (data?.positions ?? []).filter(p => p.status === 'open');
  const closed = (data?.positions ?? []).filter(p => p.status === 'closed');
  const closedPnl = closed.reduce((a, p) => a + Number(p.pnl ?? 0), 0);
  const wins = closed.filter(p => Number(p.pnl) > 0).length;
  const lastRun = state?.last_run_at ? new Date(state.last_run_at).getTime() : null;
  const stale = enabled && (lastRun === null || Date.now() - lastRun > STALE_MS);
  const eligible = (s: StrategyInfo) => s.evidence.find(e => e.allowShort === allowShort)?.liveEligible === true;
  const liveBlocked = selected.filter(id => { const s = data?.strategies.find(x => x.id === id); return s && !eligible(s); });

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
              <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className={cn('flex items-center justify-center w-11 h-11 rounded-xl shrink-0', enabled ? (mode === 'live' ? 'bg-profit/10 text-profit' : 'bg-warning/10 text-warning') : 'bg-secondary text-muted-foreground')}>
                    <Bot className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-semibold">Autopilot</h2>
                      <Badge variant={!enabled ? 'secondary' : mode === 'live' ? 'profit' : 'warning'}>{!enabled ? 'OFF' : mode === 'live' ? `LIVE${data.isTestnet ? ' · TESTNET' : ''}` : 'PAPER'}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Scans {settings.autopilot_symbols?.length ?? 0} markets on hourly candles and trades by rule.{' '}
                      {lastRun ? `Last scan ${formatRelativeTime(state!.last_run_at!)}.` : 'Not scanned yet.'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented
                    aria-label="Mode"
                    value={mode}
                    onChange={m => (m === 'live' ? setConfirmLive(true) : put({ autopilot_mode: 'paper' }, 'Switched to paper trading'))}
                    options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live' }]}
                  />
                  <Button variant="outline" size="sm" onClick={() => action('scan', '')} disabled={busy !== null}>
                    {busy === 'scan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}Scan now
                  </Button>
                  <Switch checked={enabled} onCheckedChange={v => put({ autopilot_enabled: v }, v ? 'Autopilot on' : 'Autopilot off')} aria-label="Enable autopilot" />
                </div>
              </div>

              {state?.halted_reason && (
                <div className="mt-4 rounded-lg border border-loss/30 bg-loss/10 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-loss flex gap-2"><ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />Paused by the drawdown limit: {state.halted_reason}. No new trades until you reset.</p>
                  <Button variant="outline" size="sm" onClick={() => action('reset', 'Pause cleared')} disabled={busy !== null}><RotateCcw className="w-3.5 h-3.5" />Reset and resume</Button>
                </div>
              )}
              {stale && (
                <p className="mt-4 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning flex gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>Nothing has triggered a scan in the last 20 minutes. The autopilot only runs when a scheduler calls it: follow the scheduling steps at the bottom of <code className="bg-background/50 px-1 rounded">004_autopilot.sql</code>.</span>
                </p>
              )}
              {mode === 'live' && liveBlocked.length > 0 && (
                <p className="mt-4 text-xs text-muted-foreground">
                  {liveBlocked.length} selected strateg{liveBlocked.length === 1 ? 'y is' : 'ies are'} paper-only and will not trade in live mode.
                </p>
              )}
            </section>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
              <Stat label={mode === 'paper' ? 'Paper balance' : 'Day-start equity'} value={mode === 'paper' ? formatCurrency(Number(state?.paper_equity ?? 10000)) : state?.day_start_equity ? formatCurrency(Number(state.day_start_equity)) : '—'} hint={mode === 'paper' ? 'Started at $10,000' : 'Live account'} />
              <Stat label="Closed trades" value={String(closed.length)} hint={closed.length ? `${wins} won · ${closed.length - wins} lost` : 'None yet'} />
              <Stat label="Realised P&L" value={formatCurrency(closedPnl)} hint="After fees, this mode" tone={closedPnl > 0 ? 'up' : closedPnl < 0 ? 'down' : 'neutral'} />
              <Stat label="Open positions" value={`${open.length} / ${settings.autopilot_max_positions ?? 3}`} hint="Each has a stop-loss" />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6 items-start">
              {/* Strategies */}
              <section className="xl:col-span-2 space-y-3" aria-label="Strategies">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold">Strategies</h2>
                  <p className="text-xs text-muted-foreground">Backtested on {data.evidenceCoins.join(', ')} through {data.evidenceThrough}</p>
                </div>
                {data.strategies.map(s => {
                  const e = s.evidence.find(x => x.allowShort === allowShort);
                  const on = selected.includes(s.id);
                  const ok = eligible(s);
                  return (
                    <div key={s.id} className={cn('surface p-4 transition-colors', on && 'border-primary/40')}>
                      <div className="flex items-start gap-3">
                        <Switch checked={on} onCheckedChange={v => setSelected(prev => (v ? [...prev, s.id] : prev.filter(x => x !== s.id)))} aria-label={`Enable ${s.name}`} className="mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold">{s.name}</h3>
                            <Badge variant={ok ? 'profit' : 'secondary'} className="text-[10px] py-0">{ok ? 'LIVE-ELIGIBLE' : 'PAPER ONLY'}</Badge>
                            <span className="text-[11px] text-muted-foreground">{s.horizon}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{s.description}</p>
                          {e && (
                            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 mt-3">
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
                            </dl>
                          )}
                          {!ok && <p className="text-[11px] text-muted-foreground mt-2">{e && e.late.annualReturn > 0 && (e.recent?.annualReturn ?? 0) > 0 ? 'Promising in testing but not yet proven, so it can only paper trade for now.' : 'Lost money after costs in testing, so it can only paper trade.'} That is a safeguard, not a setting.</p>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {data.scalpSearch && (
                  <div className="surface p-4 text-xs text-muted-foreground leading-relaxed">
                    <span className="text-foreground font-medium">Scalping search:</span> {data.scalpSearch.tested} short-term
                    configurations (wick fades with resting orders, 15-minute breakouts, stop-run reversals, BTC lead-lag, pairs) were
                    tested on 15-minute data through {data.scalpSearch.through}.{' '}
                    <span className={data.scalpSearch.confirmed > 0 ? 'text-profit font-medium' : 'text-foreground font-medium'}>
                      {data.scalpSearch.confirmed} held up on unseen data
                    </span>
                    {data.scalpSearch.confirmed === 0 && ', so none has been added here'}. Details in <code className="bg-secondary px-1 rounded">backtest/SCALPING.md</code>.
                  </div>
                )}
              </section>

              {/* Risk */}
              <section className="surface p-5 space-y-4" aria-label="Risk settings">
                <h2 className="text-sm font-semibold">Risk limits</h2>
                <div className="space-y-1.5">
                  <Label>Markets to scan</Label>
                  <Input value={symbols} onChange={e => setSymbols(e.target.value.toUpperCase())} placeholder="BTC, ETH, SOL" className="font-mono text-xs" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['perTrade', 'Risk per trade %', 'Lost if a stop is hit'],
                    ['maxPositions', 'Max positions', 'Open at once'],
                    ['maxLeverage', 'Max leverage ×', 'Per position'],
                    ['dailyLoss', 'Daily loss limit %', 'Stops new trades today'],
                    ['maxDrawdown', 'Max drawdown %', 'Pauses the autopilot'],
                  ] as const).map(([key, label, hint]) => (
                    <div key={key} className="space-y-1">
                      <Label>{label}</Label>
                      <Input type="number" inputMode="decimal" step="0.1" value={risk[key]} onChange={e => setRisk(r => ({ ...r, [key]: e.target.value }))} />
                      <p className="text-[11px] text-muted-foreground">{hint}</p>
                    </div>
                  ))}
                </div>
                <label className="flex items-start justify-between gap-3 cursor-pointer">
                  <span>
                    <span className="text-sm font-medium block">Allow shorts</span>
                    <span className="text-xs text-muted-foreground">Short versions tested worse; none is live-eligible</span>
                  </span>
                  <Switch checked={allowShort} onCheckedChange={setAllowShort} />
                </label>
                <Button className="w-full" onClick={saveConfig} disabled={busy !== null}>
                  {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save strategies and limits
                </Button>
                {mode === 'paper' && (
                  <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => action('reset_paper', 'Paper account reset to $10,000')} disabled={busy !== null}>
                    <RotateCcw className="w-3.5 h-3.5" />Reset paper account
                  </Button>
                )}
              </section>
            </div>

            {/* Positions */}
            <section className="surface overflow-hidden" aria-label="Autopilot positions">
              <div className="px-5 pt-5 pb-3 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Positions · {mode}</h2>
                <p className="text-xs text-muted-foreground">{open.length} open · {closed.length} closed</p>
              </div>
              {(data.positions ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10 px-6">No positions yet. The autopilot waits for a setup; in a falling market a long-only strategy can sit idle for weeks.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>Market</th><th>Side</th><th className="hidden sm:table-cell">Size</th><th>Entry</th><th>Stop / exit</th><th className="hidden md:table-cell">Why</th><th>P&amp;L</th></tr></thead>
                    <tbody>
                      {(data.positions ?? []).map(p => (
                        <tr key={p.id}>
                          <td><span className="font-medium text-foreground">{p.symbol}</span>{p.status === 'open' && <Badge variant="open" className="ml-2 text-[10px] py-0">OPEN</Badge>}</td>
                          <td className={p.side === 'long' ? 'text-profit' : 'text-loss'}>{p.side}</td>
                          <td className="num hidden sm:table-cell">{formatCurrency(Number(p.notional_usd), 0)}</td>
                          <td className="num">${formatPrice(Number(p.entry_price))}</td>
                          <td className="num text-muted-foreground">${formatPrice(Number(p.status === 'open' ? p.stop_price : p.exit_price ?? 0))}</td>
                          <td className="hidden md:table-cell text-xs text-muted-foreground max-w-[260px] truncate">{p.status === 'open' ? p.entry_reason : p.exit_reason}</td>
                          <td className={cn('num', p.pnl == null ? 'text-muted-foreground' : Number(p.pnl) >= 0 ? 'text-profit' : 'text-loss')}>{p.pnl == null ? '—' : formatCurrency(Number(p.pnl))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Activity */}
            <section className="surface p-5" aria-label="Activity">
              <h2 className="text-sm font-semibold mb-3">Activity</h2>
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
            </section>
          </>
        )}
      </div>

      <Dialog open={confirmLive} onOpenChange={setConfirmLive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Let the autopilot trade real money?</DialogTitle>
            <DialogDescription>
              In live mode it opens and closes positions on Hyperliquid {data?.isTestnet ? 'testnet' : 'mainnet'} by itself, within your risk limits,
              using only strategies that passed the backtest gate. Passing a backtest is not a guarantee: the eligible strategy still lost in
              some months and had a 26% drawdown. Run it in paper mode first and compare.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLive(false)}>Stay on paper</Button>
            <Button variant="destructive" disabled={!data?.hasWallet} onClick={async () => { setConfirmLive(false); await put({ autopilot_mode: 'live' }, 'Autopilot is now LIVE'); }}>
              {data?.hasWallet ? 'Switch to live' : 'Connect a wallet first'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
