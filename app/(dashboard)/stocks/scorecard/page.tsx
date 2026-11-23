'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { DEFAULT_STOCK_GUARD, type StockGuardSettings, type stockStrategyScore } from '@/lib/stocks/strategy-guard';
import type { StockTradeRule } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

type Mode = 'demo' | 'real';
type Scorecard = { settings: StockGuardSettings; scores: ReturnType<typeof stockStrategyScore> };

export default function StockScorecardPage() {
  const query = useSearchParams();
  const [mode, setMode] = useState<Mode>(query.get('mode') === 'demo' ? 'demo' : 'real');
  const [account, setAccount] = useState<{ mode: Mode; data: Scorecard } | null>(null);
  const [draft, setDraft] = useState<StockGuardSettings | null>(null);
  const [confirm, setConfirm] = useState<StockTradeRule | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/stocks/scorecard?environment=${mode}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    setAccount({ mode, data });
  }, [mode]);
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal).catch(error => { if (!abort.signal.aborted) setError(error.message); });
    return () => abort.abort();
  }, [load]);
  const data = account?.mode === mode ? account.data : null;
  const settings = draft ?? data?.settings ?? DEFAULT_STOCK_GUARD;
  async function save(action: { action: 'save' } | { action: 'reset'; strategy: StockTradeRule }) {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/stocks/scorecard', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action.action === 'save' ? { ...settings, action: 'save', environment: mode }
          : { ...action, environment: mode, confirmed: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setMessage(action.action === 'save' ? 'Guard settings saved.' : 'Pause cleared. The guard will evaluate new trades from now on.');
      setDraft(null); setConfirm(null);
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update the guard.'); }
    finally { setBusy(false); }
  }
  const update = (key: keyof StockGuardSettings, value: number | boolean) => setDraft({ ...settings, [key]: value });
  function submit(event: FormEvent) { event.preventDefault(); void save({ action: 'save' }); }

  return <><Header /><div className="p-4 lg:p-8 max-w-[1400px] mx-auto w-full space-y-4">
    <section className="surface p-4 lg:p-6 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div><h2 className="font-semibold">Strategy guard</h2><p className="text-sm text-muted-foreground">Pause new Autopilot entries for a strategy when slippage or net drawdown breaches its limit. Existing exits continue.</p></div>
        <Segmented aria-label="Scorecard account" value={mode} options={[{ value: 'demo', label: 'Paper' }, { value: 'real', label: 'Live' }]} disabled={busy}
          onChange={next => { setMode(next); setDraft(null); setConfirm(null); setError(''); setMessage(''); }} />
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={!data || busy} className="space-y-3">
          <label className="text-sm flex items-center gap-2"><input type="checkbox" checked={settings.enabled} onChange={e => update('enabled', e.target.checked)} />Enable the guard for {mode === 'real' ? 'Live' : 'Paper'} Autopilot</label>
          <div className="grid sm:grid-cols-3 gap-3">
            <label className="text-sm">Minimum trades per check<Input type="number" required min="5" max="30" value={settings.minimum_trades || ''} onChange={e => update('minimum_trades', Number(e.target.value))} /></label>
            <label className="text-sm">75th-percentile slippage (bps)<Input type="number" required min="0.01" max="300" step="0.01" value={settings.max_slippage_bps || ''} onChange={e => update('max_slippage_bps', Number(e.target.value))} /></label>
            <label className="text-sm">Net drawdown limit (USD)<Input type="number" required min="0.01" max="100000" step="0.01" value={settings.max_net_loss_usd || ''} onChange={e => update('max_net_loss_usd', Number(e.target.value))} /></label>
          </div>
          <Button type="submit">{busy ? 'Saving…' : 'Save guard settings'}</Button>
        </fieldset>
      </form>
      {message && <p className="text-sm" role="status">{message}</p>}
      {error && <p className="text-sm text-loss" role="alert">{error}</p>}
    </section>
    <section className="surface p-4 lg:p-6 space-y-3">
      <div className="flex justify-between items-start flex-wrap gap-3"><h2 className="font-semibold">Results by strategy</h2>
        <Button size="sm" variant="outline" asChild><Link href={`/stocks/journal?mode=${mode}`}>Open execution journal</Link></Button></div>
      <p className="text-sm text-muted-foreground">The guard uses up to 30 measured fills and 30 reconciled statement closes per strategy. Broker gross P&amp;L is shown separately while statement results are unavailable.</p>
      <div className="grid md:grid-cols-2 gap-3">
        {data?.scores.map(score => <article className="rounded-lg border p-3 space-y-2" key={score.rule}>
          <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{score.name}</h3>
            <span className={score.state?.halted_at && data.settings.enabled ? 'text-sm text-loss' : 'text-sm text-muted-foreground'}>
              {score.state?.halted_at ? data.settings.enabled ? 'Guard paused' : 'Pause recorded · Guard off'
                : score.reason ? 'Threshold exceeded' : score.fills >= data.settings.minimum_trades || score.closes >= data.settings.minimum_trades ? 'Within measured limits' : 'Awaiting trade sample'}
            </span></div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">Measured slippage</dt><dd>{score.slipBps == null ? '—' : `${score.slipBps.toFixed(2)} bps`} ({score.fills} fills)</dd></div>
            <div><dt className="text-xs text-muted-foreground">Slippage vs. plan</dt><dd>{score.slipDriftBps == null ? '—' : `${score.slipDriftBps >= 0 ? '+' : ''}${score.slipDriftBps.toFixed(2)} bps`}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Statement net</dt><dd>{score.closes ? formatCurrency(score.net) : '—'} ({score.closes} closes)</dd></div>
            <div><dt className="text-xs text-muted-foreground">Net vs. historical estimate</dt><dd>{score.netVsPlan == null ? '—' : formatCurrency(score.netVsPlan)} ({score.plannedCloses} matched)</dd></div>
            <div><dt className="text-xs text-muted-foreground">Statement drawdown</dt><dd>{score.closes ? formatCurrency(score.drawdown) : '—'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Broker gross</dt><dd>{score.brokerCloseCount ? formatCurrency(score.brokerGross) : '—'} ({score.brokerCloseCount} matched)</dd></div>
          </dl>
          {(score.state?.reason || score.reason) && <p className="text-sm text-muted-foreground">{score.state?.reason ?? score.reason}</p>}
          {score.state?.halted_at && (confirm === score.rule
            ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void save({ action: 'reset', strategy: score.rule })}>Confirm clear pause</Button><Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button></div>
            : <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(score.rule)}>Clear strategy pause</Button>)}
        </article>)}
      </div>
    </section>
  </div></>;
}
