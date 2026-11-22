'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Segmented } from '@/components/ui/segmented';
import { ChevronDown, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn, formatPrice } from '@/lib/utils';
import { sizeByRisk } from '@/lib/sizing';
import { LevelsChart, type ChartCandle, type ChartLine } from '@/components/charts/LevelsChart';
import type { Market } from '@/lib/hyperliquid/public';
import type { Settings } from '@/types';
import type { Suggestion } from '@/lib/suggestions';

interface Props {
  settings: Settings | null;
  /** Called after an order fills or is placed so the page can refresh positions, orders and trades. */
  onTraded: () => void;
  /** Opens the ticket on this market and side (from a trade idea). Change `nonce` to re-open. */
  preset?: { symbol: string; side: 'long' | 'short'; nonce: number } | null;
}

const QUICK = ['BTC', 'ETH', 'SOL', 'HYPE'];
type SizeMode = 'risk' | 'usd';
type OrderType = 'market' | 'limit';

export function TradeTicket({ settings, onTraded, preset }: Props) {
  const [open, setOpen] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [equity, setEquity] = useState<number | null>(null);
  const [symbol, setSymbol] = useState('BTC');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [limitPx, setLimitPx] = useState('');
  const [expiryHours, setExpiryHours] = useState('24');
  const [sizeMode, setSizeMode] = useState<SizeMode>('risk');
  const [riskUnit, setRiskUnit] = useState<'usd' | 'pct'>('pct');
  const [risk, setRisk] = useState('');
  const [sizeUsd, setSizeUsd] = useState('');
  const [leverage, setLeverage] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [moreExits, setMoreExits] = useState(false);
  const [tp1Share, setTp1Share] = useState('');
  const [takeProfit2, setTakeProfit2] = useState('');
  const [breakeven, setBreakeven] = useState(false);
  const [trail, setTrail] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  // Once the user types their own stop or target, suggestions stop overwriting it.
  const [edited, setEdited] = useState({ sl: false, tp: false });

  useEffect(() => {
    if (!preset) return;
    setSymbol(preset.symbol); setSide(preset.side); setEdited({ sl: false, tp: false }); setOrderType('market'); setOpen(true);
  }, [preset]);

  // Ask the built-in rules about this market, and load its recent candles (after a short pause while typing).
  useEffect(() => {
    if (!open) return;
    const sym = symbol.trim().toUpperCase();
    setSuggestion(null); setCandles([]);
    if (!sym) return;
    setSuggesting(true);
    const id = setTimeout(() => {
      fetch(`/api/suggestions?symbol=${encodeURIComponent(sym)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => { const s = d?.suggestions?.[0]; setSuggestion(s && !s.error ? s : null); })
        .catch(() => setSuggestion(null))
        .finally(() => setSuggesting(false));
      fetch(`/api/candles?symbol=${encodeURIComponent(sym)}&hours=120`)
        .then(r => (r.ok ? r.json() : null)).then(d => setCandles(d?.candles ?? [])).catch(() => setCandles([]));
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
    setRisk(v => v || String(settings?.risk_per_trade_percent ?? 1));
    setLeverage(v => v || String(Math.round(Number(settings?.default_leverage ?? 3))));
    fetch('/api/markets').then(r => (r.ok ? r.json() : null)).then(d => setMarkets(d?.markets ?? [])).catch(() => {});
    fetch('/api/positions').then(r => (r.ok ? r.json() : null)).then(d => setEquity(d?.account?.totalValue > 0 ? d.account.totalValue : null)).catch(() => {});
  }, [open, settings]);

  const market = useMemo(() => markets.find(m => m.coin === symbol.trim().toUpperCase()), [markets, symbol]);
  const dir = side === 'long' ? 1 : -1;
  const price = market?.price;
  const limit = parseFloat(limitPx);
  const isLimit = orderType === 'limit';
  // Stop and target distances are measured from where the trade would be entered.
  const entry = isLimit ? (limit > 0 ? limit : undefined) : price;
  const sl = parseFloat(stopLoss), tp = parseFloat(takeProfit), tp2 = parseFloat(takeProfit2), share = parseFloat(tp1Share), trailPct = parseFloat(trail);
  const userLev = parseFloat(leverage);
  const maxUsd = Number(settings?.max_position_size_usd ?? 0);

  const sized = useMemo(() => {
    if (sizeMode !== 'risk') return null;
    return sizeByRisk({ equity: equity ?? 0, risk: parseFloat(risk), riskUnit, stopPct: sl, maxPositionUsd: maxUsd, maxLeverage: market?.maxLeverage ?? 50 });
  }, [sizeMode, equity, risk, riskUnit, sl, maxUsd, market]);

  const size = sizeMode === 'risk' ? sized?.sizeUsd ?? 0 : parseFloat(sizeUsd);
  // In risk mode the leverage is raised to whatever the size needs; it never changes the amount at risk.
  const lev = sizeMode === 'risk' && sized && !sized.error ? Math.max(userLev || 1, sized.leverageNeeded) : userLev;
  const margin = size > 0 && lev > 0 ? size / lev : null;
  const riskUsd = size > 0 && sl > 0 ? (size * sl) / 100 : null;
  const managed = !isLimit && ((share > 0 && share < 100 && tp > 0) || trailPct > 0);
  const limitWrongSide = isLimit && limit > 0 && price != null && (side === 'long' ? limit >= price : limit <= price);

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    for (const l of suggestion?.supports ?? []) out.push({ kind: 'support', label: 'Support', price: l.price });
    for (const l of suggestion?.resistances ?? []) out.push({ kind: 'resistance', label: 'Resist.', price: l.price });
    if (entry) {
      out.push({ kind: 'entry', label: isLimit ? 'Limit' : 'Entry', price: entry });
      if (sl > 0) out.push({ kind: 'stop', label: 'Stop', price: entry * (1 - (dir * sl) / 100) });
      if (tp > 0) out.push({ kind: 'target', label: tp2 > 0 && managed ? 'Target 1' : 'Target', price: entry * (1 + (dir * tp) / 100) });
      if (tp2 > 0 && managed) out.push({ kind: 'target', label: 'Target 2', price: entry * (1 + (dir * tp2) / 100) });
    }
    return out;
  }, [suggestion, entry, isLimit, sl, tp, tp2, dir, managed]);

  const blocked =
    !(size >= 10) ? (sized?.error ?? 'Size must be at least $10')
    : !(lev >= 1) ? 'Enter leverage'
    : isLimit && !(limit > 0) ? 'Enter a limit price'
    : limitWrongSide ? `A limit ${side === 'long' ? 'buy must be below' : 'sell must be above'} the current price`
    : null;

  async function submit() {
    setSubmitting(true);
    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol, side, sizeUsd: size, leverage: Math.round(lev), stopLossPct: stopLoss || null, takeProfitPct: takeProfit || null,
          ...(isLimit ? { limitPx: limit, expiryHours: Number(expiryHours) } : {
            tp1Fraction: share > 0 && share < 100 ? share / 100 : null, takeProfit2Pct: takeProfit2 || null,
            breakevenAfterTp1: breakeven, trailPct: trail || null,
          }),
          note,
          // What the ticket showed, so the trade can be tagged in the journal.
          context: suggestion ? { bias: suggestion.bias, suggestedStopPct: suggestion[side].stopLossPct } : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Order failed', { duration: 10000 }); return; }
      if (data.resting) {
        toast.success(`Limit ${data.side} resting on ${data.symbol} at $${formatPrice(Number(data.order.limit_px))}`);
      } else if (data.protectionError) {
        toast.error(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}, but the stop/target was NOT placed: ${data.protectionError}`, { duration: 20000 });
      } else {
        toast.success(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}`);
        if (data.exitWarning) toast.warning(data.exitWarning, { duration: 15000 });
      }
      setOpen(false); setNote('');
      onTraded();
    } catch {
      toast.error('Order request failed. Check your positions before retrying.', { duration: 15000 });
    } finally {
      setSubmitting(false);
    }
  }

  const nearest = side === 'long' ? suggestion?.supports[0] : suggestion?.resistances[0];

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4" />New trade</Button>

      <Dialog open={open} onOpenChange={o => !submitting && setOpen(o)}>
        <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New trade</DialogTitle>
            <DialogDescription>
              Hyperliquid {settings?.is_testnet ? 'testnet' : 'mainnet'}. Stops and targets rest on the exchange, so they work even if this app is down.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-secondary p-1">
              {(['long', 'short'] as const).map(s => (
                <button key={s} type="button" onClick={() => setSide(s)} aria-pressed={side === s}
                  className={cn('h-9 rounded-md text-sm font-semibold transition-colors',
                    side === s ? (s === 'long' ? 'bg-profit text-black' : 'bg-loss text-white') : 'text-muted-foreground hover:text-foreground')}>
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

            {candles.length > 0 && <LevelsChart candles={candles} lines={lines} height={190} className="rounded-lg border border-border bg-secondary/30 px-2 py-1.5" />}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Entry</Label>
                <Segmented aria-label="Order type" value={orderType} onChange={setOrderType} options={[{ value: 'market', label: 'Market now' }, { value: 'limit', label: 'Limit price' }]} />
              </div>
              {isLimit && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="tt-limit">Limit price</Label>
                    <Input id="tt-limit" type="number" inputMode="decimal" min="0" value={limitPx} onChange={e => setLimitPx(e.target.value)} />
                    {nearest && (
                      <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setLimitPx(String(Number(nearest.price.toPrecision(5))))}>
                        Use nearest {side === 'long' ? 'support' : 'resistance'} ${formatPrice(nearest.price)}
                      </button>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="tt-expiry">Cancel if unfilled after</Label>
                    <select id="tt-expiry" value={expiryHours} onChange={e => setExpiryHours(e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="4">4 hours</option><option value="24">1 day</option><option value="72">3 days</option><option value="168">7 days</option>
                    </select>
                  </div>
                  <p className="col-span-2 text-[11px] text-muted-foreground leading-relaxed">
                    Post-only: it waits at your price and pays the 0.015% maker fee instead of 0.045%. It may never fill. The stop and target are attached to the order and only become active if it fills.
                  </p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tt-sl">Stop-loss %</Label>
                <Input id="tt-sl" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={stopLoss} onChange={e => { setStopLoss(e.target.value); setEdited(x => ({ ...x, sl: true })); }} />
                {entry && sl > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(entry * (1 - (dir * sl) / 100))}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tt-tp">Take-profit %</Label>
                <Input id="tt-tp" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={takeProfit} onChange={e => { setTakeProfit(e.target.value); setEdited(x => ({ ...x, tp: true })); }} />
                {entry && tp > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(entry * (1 + (dir * tp) / 100))}</p>}
              </div>
            </div>

            {!isLimit && (
              <div className="rounded-lg border border-border">
                <button type="button" onClick={() => setMoreExits(v => !v)} aria-expanded={moreExits} className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium">
                  <span>More exit options{managed || breakeven ? ' (on)' : ''}</span>
                  <ChevronDown className={cn('w-4 h-4 text-muted-foreground transition-transform', moreExits && 'rotate-180')} />
                </button>
                {moreExits && (
                  <div className="grid grid-cols-2 gap-3 border-t border-border px-3 py-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="tt-share">Close at target 1 (%)</Label>
                      <Input id="tt-share" type="number" inputMode="numeric" min="1" max="100" placeholder="100" value={tp1Share} onChange={e => setTp1Share(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tt-tp2">Target 2 for the rest (%)</Label>
                      <Input id="tt-tp2" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={takeProfit2} onChange={e => setTakeProfit2(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="tt-trail">Trailing stop (%)</Label>
                      <Input id="tt-trail" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="Off" value={trail} onChange={e => setTrail(e.target.value)} />
                    </div>
                    <label className="flex items-center gap-2 text-xs self-end pb-2.5">
                      <input type="checkbox" checked={breakeven} onChange={e => setBreakeven(e.target.checked)} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                      Stop to break-even after target 1
                    </label>
                    <p className="col-span-2 text-[11px] text-muted-foreground leading-relaxed">
                      Hyperliquid has no trailing or self-moving stop, so this app moves it for you, and only when its scan runs: about every five minutes.
                      Between scans the last stop placed still protects the position. With a split, trailing starts once target 1 has filled.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Size</Label>
                <Segmented aria-label="How to size" value={sizeMode} onChange={setSizeMode} options={[{ value: 'risk', label: 'By amount at risk' }, { value: 'usd', label: 'Size in USD' }]} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                {sizeMode === 'risk' ? (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="tt-risk">Risk if stopped out</Label>
                      <Segmented aria-label="Risk unit" value={riskUnit} onChange={setRiskUnit} options={[{ value: 'pct', label: '%' }, { value: 'usd', label: '$' }]} />
                    </div>
                    <Input id="tt-risk" type="number" inputMode="decimal" min="0" step="0.1" value={risk} onChange={e => setRisk(e.target.value)} />
                    <p className="num text-[11px] text-muted-foreground">{equity ? `Account $${equity.toFixed(2)}` : 'Account value unavailable'}</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="tt-size">Position size (USD)</Label>
                    <Input id="tt-size" type="number" inputMode="decimal" min="10" value={sizeUsd} onChange={e => setSizeUsd(e.target.value)} />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="tt-lev">Leverage ×{market ? ` (max ${market.maxLeverage})` : ''}</Label>
                  <Input id="tt-lev" type="number" inputMode="numeric" min="1" step="1" value={leverage} onChange={e => setLeverage(e.target.value)} />
                  {sizeMode === 'risk' && sized && !sized.error && sized.leverageNeeded > (userLev || 1) && (
                    <p className="text-[11px] text-warning">This size needs {sized.leverageNeeded}×; it will be used.</p>
                  )}
                </div>
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

            <div className="space-y-1.5">
              <Label htmlFor="tt-note">Note for your journal (optional)</Label>
              <Input id="tt-note" value={note} maxLength={500} placeholder="Why this trade?" onChange={e => setNote(e.target.value)} />
            </div>

            <dl className="rounded-lg border border-border divide-y divide-border/70 text-sm">
              <div className="flex justify-between px-3 py-2">
                <dt className="text-muted-foreground">Position size</dt>
                <dd className="num">{size >= 10 ? `$${size.toFixed(2)}${sized?.cappedBy ? ` (capped by ${sized.cappedBy})` : ''}` : '—'}</dd>
              </div>
              <div className="flex justify-between px-3 py-2"><dt className="text-muted-foreground">Margin used</dt><dd className="num">{margin ? `$${margin.toFixed(2)} at ${Math.round(lev)}×` : '—'}</dd></div>
              <div className="flex justify-between px-3 py-2">
                <dt className="text-muted-foreground">Loss if the stop is hit</dt>
                <dd className={cn('num', riskUsd ? 'text-loss' : 'text-warning')}>
                  {riskUsd ? `≈ -$${riskUsd.toFixed(2)}${equity ? ` (${((riskUsd / equity) * 100).toFixed(2)}% of account)` : ''}` : 'No stop set'}
                </dd>
              </div>
            </dl>

            {blocked && <p className="text-xs text-warning">{blocked}</p>}
            <Button className={cn('w-full h-11 font-semibold', side === 'long' ? 'bg-profit text-black hover:bg-profit/90' : 'bg-loss text-white hover:bg-loss/90')} onClick={submit} disabled={submitting || !!blocked}>
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isLimit ? `Place limit ${side === 'long' ? 'buy' : 'sell'}` : side === 'long' ? 'Buy / Long' : 'Sell / Short'} {symbol}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
