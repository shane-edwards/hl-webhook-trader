'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn, formatPrice } from '@/lib/utils';
import type { Market } from '@/lib/hyperliquid/public';
import type { Settings } from '@/types';
import type { Suggestion } from '@/lib/suggestions';

interface Props {
  settings: Settings | null;
  /** Called after an order fills so the page can refresh positions and trades. */
  onTraded: () => void;
  /** Opens the ticket on this market and side (from a trade idea). Change `nonce` to re-open. */
  preset?: { symbol: string; side: 'long' | 'short'; nonce: number } | null;
}

const QUICK = ['BTC', 'ETH', 'SOL', 'HYPE'];

export function TradeTicket({ settings, onTraded, preset }: Props) {
  const [open, setOpen] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [symbol, setSymbol] = useState('BTC');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [sizeUsd, setSizeUsd] = useState('');
  const [leverage, setLeverage] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Once the user types their own stop or target, suggestions stop overwriting it.
  const [edited, setEdited] = useState({ sl: false, tp: false });

  useEffect(() => {
    if (!preset) return;
    setSymbol(preset.symbol); setSide(preset.side); setEdited({ sl: false, tp: false }); setOpen(true);
  }, [preset]);

  // Ask the built-in rules about this market (after a short pause while typing).
  useEffect(() => {
    if (!open) return;
    const sym = symbol.trim().toUpperCase();
    setSuggestion(null);
    if (!sym) return;
    setSuggesting(true);
    const id = setTimeout(() => {
      fetch(`/api/suggestions?symbol=${encodeURIComponent(sym)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { const s = d?.suggestions?.[0]; setSuggestion(s && !s.error ? s : null); })
        .catch(() => setSuggestion(null))
        .finally(() => setSuggesting(false));
    }, 400);
    return () => clearTimeout(id);
  }, [open, symbol]);

  // Pre-fill the stop and target for the chosen side, unless the user has set their own.
  const suggested = suggestion ? suggestion[side] : null;
  useEffect(() => {
    if (!suggested) return;
    if (!edited.sl) setStopLoss(String(suggested.stopLossPct));
    if (!edited.tp) setTakeProfit(String(suggested.takeProfitPct));
  }, [suggested, edited.sl, edited.tp]);

  useEffect(() => {
    if (!open) return;
    setSizeUsd(v => v || String(settings?.default_order_size_usd ?? 100));
    setLeverage(v => v || String(Math.round(Number(settings?.default_leverage ?? 3))));
    fetch('/api/markets').then(r => (r.ok ? r.json() : null)).then(d => setMarkets(d?.markets ?? [])).catch(() => {});
  }, [open, settings]);

  const market = useMemo(() => markets.find(m => m.coin === symbol.trim().toUpperCase()), [markets, symbol]);
  const size = parseFloat(sizeUsd);
  const lev = parseFloat(leverage);
  const sl = parseFloat(stopLoss);
  const tp = parseFloat(takeProfit);
  const dir = side === 'long' ? 1 : -1;
  const price = market?.price;
  const margin = size > 0 && lev > 0 ? size / lev : null;
  const riskUsd = size > 0 && sl > 0 ? (size * sl) / 100 : null;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side, sizeUsd: size, leverage: lev, stopLossPct: stopLoss || null, takeProfitPct: takeProfit || null }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Order failed', { duration: 10000 }); return; }
      if (data.protectionError) {
        toast.error(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}, but the stop/target was NOT placed: ${data.protectionError}`, { duration: 20000 });
      } else {
        toast.success(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}`);
      }
      setOpen(false);
      onTraded();
    } catch {
      toast.error('Order request failed. Check your positions before retrying.', { duration: 15000 });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4" />New trade</Button>

      <Dialog open={open} onOpenChange={o => !submitting && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New trade</DialogTitle>
            <DialogDescription>
              Market order on Hyperliquid {settings?.is_testnet ? 'testnet' : 'mainnet'}, with an optional stop-loss and take-profit held on the exchange.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary p-1">
              {(['long', 'short'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  aria-pressed={side === s}
                  className={cn(
                    'h-9 rounded-md text-sm font-semibold transition-colors',
                    side === s ? (s === 'long' ? 'bg-profit text-black' : 'bg-loss text-white') : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {s === 'long' ? 'Long' : 'Short'}
                </button>
              ))}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="tt-symbol">Market</Label>
                <span className="num text-xs text-muted-foreground">{price ? `$${formatPrice(price)}` : market === undefined && markets.length ? 'Unknown market' : ''}</span>
              </div>
              <Input id="tt-symbol" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} className="font-mono" autoCapitalize="characters" />
              <div className="flex gap-1.5">
                {QUICK.map(q => (
                  <button key={q} type="button" onClick={() => setSymbol(q)} className={cn('px-2 h-6 rounded-md text-[11px] font-medium border transition-colors', symbol === q ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
                    {q}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tt-size">Position size (USD)</Label>
                <Input id="tt-size" type="number" inputMode="decimal" min="10" value={sizeUsd} onChange={e => setSizeUsd(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tt-lev">Leverage ×{market ? ` (max ${market.maxLeverage})` : ''}</Label>
                <Input id="tt-lev" type="number" inputMode="numeric" min="1" step="1" value={leverage} onChange={e => setLeverage(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tt-sl">Stop-loss %</Label>
                <Input id="tt-sl" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={stopLoss} onChange={e => { setStopLoss(e.target.value); setEdited(x => ({ ...x, sl: true })); }} />
                {price && sl > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(price * (1 - (dir * sl) / 100))}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tt-tp">Take-profit %</Label>
                <Input id="tt-tp" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={takeProfit} onChange={e => { setTakeProfit(e.target.value); setEdited(x => ({ ...x, tp: true })); }} />
                {price && tp > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(price * (1 + (dir * tp) / 100))}</p>}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2.5 text-xs leading-relaxed">
              {suggesting && !suggestion ? (
                <p className="text-muted-foreground flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" />Reading the built-in rules for {symbol}…</p>
              ) : !suggestion ? (
                <p className="text-muted-foreground">No suggestion available for this market. Set your own stop and target.</p>
              ) : (
                <>
                  <p>
                    <span className={cn('font-semibold uppercase tracking-wide mr-1.5', suggestion.bias === 'long' ? 'text-profit' : suggestion.bias === 'short' ? 'text-loss' : 'text-warning')}>
                      {suggestion.bias === 'neutral' ? 'No clear read' : `Rules lean ${suggestion.bias}`}
                    </span>
                    <span className="text-muted-foreground">{suggestion.summary}</span>
                  </p>
                  {suggestion.bias !== 'neutral' && suggestion.bias !== side && (
                    <p className="text-warning mt-1">You are going {side}, against what the rules read.</p>
                  )}
                  <p className="text-muted-foreground mt-1">
                    Suggested for a {side}: stop {suggestion[side].stopLossPct}% {suggestion[side].stopBasis}; target {suggestion[side].takeProfitPct}% {suggestion[side].targetBasis}.{' '}
                    {(edited.sl || edited.tp) && (
                      <button type="button" className="text-primary hover:underline" onClick={() => setEdited({ sl: false, tp: false })}>Use suggested</button>
                    )}
                  </p>
                </>
              )}
            </div>

            <dl className="rounded-lg border border-border divide-y divide-border/70 text-sm">
              <div className="flex justify-between px-3 py-2"><dt className="text-muted-foreground">Margin used</dt><dd className="num">{margin ? `$${margin.toFixed(2)}` : '—'}</dd></div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-muted-foreground">Loss if the stop is hit</dt>
                <dd className={cn('num', riskUsd ? 'text-loss' : 'text-warning')}>{riskUsd ? `≈ -$${riskUsd.toFixed(2)}` : 'No stop set'}</dd>
              </div>
            </dl>

            <Button className={cn('w-full h-11 font-semibold', side === 'long' ? 'bg-profit text-black hover:bg-profit/90' : 'bg-loss text-white hover:bg-loss/90')} onClick={submit} disabled={submitting || !(size >= 10) || !(lev >= 1)}>
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {side === 'long' ? 'Buy / Long' : 'Sell / Short'} {symbol}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
