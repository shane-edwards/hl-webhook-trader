'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { StockLeverage } from '@/lib/stocks/leverage';
import type { StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

type Plan = { amount: number; exposure: number; stop: number; modeledGap: number; lossAtStop: number; gapLoss: number;
  gapPct: number; slippageBps: number; roundTripFeesUsd: number; applicable: boolean; currentGroupExposure: number };

export function StockRiskSizer({ symbol, environment, leverage, stopMarginPct, marketOpen, onUse }: {
  symbol: StockTradeSymbol; environment: 'real' | 'demo'; leverage: StockLeverage; stopMarginPct: number;
  marketOpen: boolean; onUse: (amount: number) => void;
}) {
  const [budget, setBudget] = useState('25');
  const [gap, setGap] = useState('0.5');
  const [maximum, setMaximum] = useState('1000');
  const [cashStop, setCashStop] = useState('1');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function calculate(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setPlan(null); setError('');
    try {
      const response = await fetch('/api/stocks/size', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, environment, leverage, stopMarginPct: leverage === 1 ? Number(cashStop) : stopMarginPct,
          budget: Number(budget), gapPct: Number(gap), maximum: Number(maximum) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setPlan(result);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not calculate this position size.'); }
    finally { setBusy(false); }
  }
  return <details className="rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-sm font-medium">Size by dollar loss</summary>
    <form className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 items-end" onSubmit={calculate}>
      <label className="text-xs">Loss budget (USD)<Input type="number" min="1" max="10000" step="0.01" required value={budget} onChange={e => { setBudget(e.target.value); setPlan(null); }} /></label>
      <label className="text-xs">Gap below stop (%)<Input type="number" min="0" max="25" step="0.01" required value={gap} onChange={e => { setGap(e.target.value); setPlan(null); }} /></label>
      <label className="text-xs">Max {leverage > 1 ? 'margin' : 'amount'} (USD)<Input type="number" min="1" max="100000" step="0.01" required value={maximum} onChange={e => { setMaximum(e.target.value); setPlan(null); }} /></label>
      {leverage === 1 && <label className="text-xs">Modeled stop (%)<Input type="number" min="0.01" max="50" step="0.01" required value={cashStop} onChange={e => { setCashStop(e.target.value); setPlan(null); }} /></label>}
      <Button type="submit" size="sm" disabled={busy || !marketOpen}>{busy ? 'Calculating…' : 'Calculate size'}</Button>
    </form>
    <p className="mt-2 text-xs text-muted-foreground">{marketOpen ? 'Uses the current quote, fees, buying power and any saved portfolio limits.' : 'A fresh quote is available during the regular US session.'}</p>
    {error && <p className="mt-2 text-sm text-loss" role="alert">{error}</p>}
    {plan && <div className="mt-3 space-y-2" aria-live="polite">
      <p className="text-sm font-semibold">{formatCurrency(plan.amount)} {leverage > 1 ? 'margin' : 'cash'} · {formatCurrency(plan.exposure)} exposure</p>
      <p className="text-sm">Stop {formatCurrency(plan.stop)} · Estimated loss at stop {formatCurrency(plan.lossAtStop)} · Loss at modeled gap {formatCurrency(plan.gapLoss)}</p>
      <p className="text-xs text-muted-foreground">{plan.slippageBps.toFixed(1)} bps slippage per side · {formatCurrency(plan.roundTripFeesUsd)} estimated round-trip fees · {formatCurrency(plan.currentGroupExposure)} existing group exposure{plan.applicable ? ' · Saved portfolio limits applied' : ''}. A larger gap can increase the loss.</p>
      {leverage > 1 ? <Button type="button" variant="outline" size="sm" onClick={() => onUse(plan.amount)}>Use this margin in the ticket</Button>
        : <p className="text-xs text-muted-foreground">The cash stop is a planning assumption. Manage cash exits in eToro.</p>}
    </div>}
  </details>;
}
