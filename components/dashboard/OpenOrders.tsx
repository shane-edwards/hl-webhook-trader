'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { formatPrice, formatRelativeTime } from '@/lib/utils';

interface Order {
  id: string; symbol: string; side: 'long' | 'short'; limit_px: number; size: number; size_usd: number;
  stop_loss_pct: number | null; take_profit_pct: number | null; status: string; note: string | null; expires_at: string; created_at: string;
  mode?: 'limit' | 'chase'; chase_until?: string | null;
}
interface Plan {
  id: string; symbol: string; side: 'long' | 'short'; stop_px: number | null; tp1_px: number | null; tp1_fraction: number | null; tp1_done: boolean;
  tp2_px: number | null; breakeven_after_tp1: boolean; trail_pct: number | null; last_note: string | null; updated_at: string;
}

/** Resting limit entries and managed exit plans. Renders nothing when there are none. */
export function OpenOrders({ refreshKey, onChanged }: { refreshKey: number; onChanged: () => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch('/api/orders').then(r => (r.ok ? r.json() : null)).then(d => { setOrders(d?.orders ?? []); setPlans(d?.plans ?? []); }).catch(() => {});
  }, []);
  useEffect(() => { load(); const id = setInterval(load, 10_000); return () => clearInterval(id); }, [load, refreshKey]);

  async function cancel(id: string) {
    setCancelling(id);
    try {
      const res = await fetch(`/api/orders?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) toast.error(data.error ?? 'Could not cancel'); else toast.success('Limit order cancelled');
      load(); onChanged();
    } catch { toast.error('Could not cancel'); } finally { setCancelling(null); }
  }

  const resting = orders.filter(o => o.status === 'resting');
  const recent = orders.filter(o => o.status !== 'resting').slice(0, 3);
  if (!resting.length && !plans.length && !recent.length) return null;

  return (
    <section className="surface" aria-label="Open orders and exit plans">
      <h2 className="text-sm font-semibold px-5 pt-4 pb-3">Open orders and exit plans</h2>
      <ul className="divide-y divide-border/70 border-t border-border/70 text-sm">
        {resting.map(o => (
          <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="font-semibold">{o.symbol}</span>
            <Badge variant={o.side === 'long' ? 'long' : 'short'} className="uppercase">{o.mode === 'chase' ? 'Chase' : 'Limit'} {o.side === 'long' ? 'buy' : 'sell'}</Badge>
            <span className="num text-xs text-muted-foreground">
              {Number(o.size)} at ${formatPrice(Number(o.limit_px))} (${Number(o.size_usd).toFixed(0)})
              {o.stop_loss_pct != null && ` · stop ${Number(o.stop_loss_pct)}%`}{o.take_profit_pct != null && ` · target ${Number(o.take_profit_pct)}%`}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">{o.mode === 'chase' && o.chase_until ? `market ${formatRelativeTime(o.chase_until)}` : `expires ${formatRelativeTime(o.expires_at)}`}</span>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-muted-foreground hover:text-loss" onClick={() => cancel(o.id)} disabled={cancelling === o.id} aria-label={`Cancel limit order on ${o.symbol}`}>
              {cancelling === o.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}Cancel
            </Button>
          </li>
        ))}
        {plans.map(p => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
            <span className="font-semibold">{p.symbol}</span>
            <Badge variant="secondary" className="uppercase">Exit plan</Badge>
            <span className="num text-xs text-muted-foreground">
              {p.stop_px != null && `stop $${formatPrice(Number(p.stop_px))}`}
              {p.tp1_px != null && ` · target 1 $${formatPrice(Number(p.tp1_px))}${p.tp1_fraction != null ? ` (${Math.round(Number(p.tp1_fraction) * 100)}%${p.tp1_done ? ', filled' : ''})` : ''}`}
              {p.tp2_px != null && ` · target 2 $${formatPrice(Number(p.tp2_px))}`}
              {p.breakeven_after_tp1 && ' · break-even after target 1'}
              {p.trail_pct != null && ` · trailing ${Number(p.trail_pct)}%`}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">{p.last_note ? `${p.last_note}, ` : ''}checked {formatRelativeTime(p.updated_at)}</span>
          </li>
        ))}
        {recent.map(o => (
          <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{o.symbol}</span>
            <span>limit {o.side === 'long' ? 'buy' : 'sell'} at ${formatPrice(Number(o.limit_px))}: {o.status}{o.note ? ` (${o.note})` : ''}</span>
            <span className="ml-auto">{formatRelativeTime(o.created_at)}</span>
          </li>
        ))}
      </ul>
      {plans.length > 0 && (
        <p className="px-5 py-2.5 border-t border-border/70 text-[11px] text-muted-foreground">
          Stops in an exit plan are moved by this app, about every ten seconds while a position is open. In between, the last stop placed still rests on the exchange.
        </p>
      )}
    </section>
  );
}
