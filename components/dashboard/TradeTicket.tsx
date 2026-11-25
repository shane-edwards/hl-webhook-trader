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
import { frameWarnings, TICKET_DEFAULTS, TIMEFRAMES, type TicketFrame, type Timeframe, type TimeframeLevels } from '@/lib/timeframes';
import tfEvidence from '@/lib/timeframes-evidence.json';
import { StrategySearch } from '@/components/journey/StrategySearch';

interface TfEvidence { generatedThrough?: string; timeframes?: Array<{ timeframe: string; windowDays: number; verdict: string; overall: { ideas: number; avgR: number; hitRate: number } }> }
const ZOOMS = [60, 120, 240, 480];

interface Props {
  settings: Settings | null;
  /** Called after an order fills or is placed so the page can refresh positions, orders and trades. */
  onTraded: () => void;
  /** Opens the ticket on this market and side (from a trade idea). Change `nonce` to re-open. */
  preset?: { symbol: string; side: 'long' | 'short'; nonce: number } | null;
}

const QUICK = ['BTC', 'ETH', 'SOL', 'HYPE'];
type SizeMode = 'risk' | 'usd';
type OrderType = 'market' | 'chase' | 'limit';
interface BookInfo { estimate: { slippageBps: number | null; spreadBps: number; depthUsd: number } | null; verdict: { level: 'ok' | 'warn' | 'block'; message: string | null } }

export function TradeTicket({ settings, onTraded, preset }: Props) {
  const [open, setOpen] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [equity, setEquity] = useState<number | null>(null);
  const [symbol, setSymbol] = useState('BTC');
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [limitPx, setLimitPx] = useState('');
  const [expiryHours, setExpiryHours] = useState('24');
  const [chaseSeconds, setChaseSeconds] = useState('60');
  const [chaseAvailable, setChaseAvailable] = useState(false);
  const [typeChosen, setTypeChosen] = useState(false);
  const [slices, setSlices] = useState('1');
  const [book, setBook] = useState<BookInfo | null>(null);
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
  // The trade's horizon: which candles the chart shows and which the stop and target are sized from.
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');
  const [tfLevels, setTfLevels] = useState<TimeframeLevels | null>(null);
  const [tfError, setTfError] = useState<string | null>(null);
  const [frameExtra, setFrameExtra] = useState<Pick<TicketFrame, 'higher' | 'trends'> | null>(null);
  const [zoom, setZoom] = useState(120);
  // Fields the user has set by hand are left alone when the timeframe changes.
  const [touched, setTouched] = useState({ chase: false, expiry: false });
  // Once the user types their own stop or target, suggestions stop overwriting it.
  const [edited, setEdited] = useState({ sl: false, tp: false });

  useEffect(() => {
    if (!preset) return;
    setSymbol(preset.symbol); setSide(preset.side); setEdited({ sl: false, tp: false }); setTypeChosen(false); setOpen(true);
  }, [preset]);

  // Ask the built-in rules about this market, and load its recent candles (after a short pause while typing).
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

  // Candles and levels for the chosen timeframe. Reloaded when the market or the timeframe changes.
  useEffect(() => {
    if (!open) return;
    const sym = symbol.trim().toUpperCase();
    setCandles([]); setTfLevels(null); setTfError(null); setFrameExtra(null);
    if (!sym) return;
    let live = true;
    const id = setTimeout(() => {
      fetch(`/api/levels?symbol=${encodeURIComponent(sym)}&tf=${timeframe}`)
        .then(async r => ({ ok: r.ok, d: await r.json().catch(() => null) }))
        .then(({ ok, d }) => {
          if (!live) return;
          if (!ok) { setTfError(d?.error ?? 'Could not load this timeframe'); return; }
          setCandles(d.candles ?? []); setTfLevels(d.levels ?? null);
          setFrameExtra(d.trends ? { higher: d.higher ?? null, trends: d.trends } : null);
        })
        .catch(() => { if (live) setTfError('Could not load this timeframe'); });
    }, 400);
    return () => { live = false; clearTimeout(id); };
  }, [open, symbol, timeframe]);

  // Pre-fill the stop and target for the chosen side, unless the user has set their own.
  // On the 1-hour timeframe the stop also takes in what the tested rules use; on the others it is sized from
  // that timeframe's own candles. Either way the levels drawn are the ones the stop and target were placed against.
  const frame = timeframe === '1h' && suggestion ? suggestion : tfLevels;
  const suggested = frame ? frame[side] : null;

  // The timeframe sets starting values for how long to chase and how long a limit order rests.
  useEffect(() => {
    if (!touched.chase) setChaseSeconds(String(TICKET_DEFAULTS[timeframe].chaseSeconds));
    if (!touched.expiry) setExpiryHours(String(TICKET_DEFAULTS[timeframe].expiryHours));
  }, [timeframe, touched.chase, touched.expiry]);
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
    fetch('/api/orders').then(r => (r.ok ? r.json() : null)).then(d => setChaseAvailable(d?.chase === true)).catch(() => {});
  }, [open, settings]);

  // The cheaper route is the default: a chase pays the maker fee when it can. The user's own choice always wins.
  useEffect(() => {
    if (open && !typeChosen) setOrderType(chaseAvailable ? 'chase' : 'market');
  }, [open, chaseAvailable, typeChosen]);

  const market = useMemo(() => markets.find(m => m.coin === symbol.trim().toUpperCase()), [markets, symbol]);
  const dir = side === 'long' ? 1 : -1;
  const price = market?.price;
  const limit = parseFloat(limitPx);
  const isLimit = orderType === 'limit';
  const isMarket = orderType === 'market';
  const nSlices = isMarket ? Math.max(1, parseInt(slices) || 1) : 1;
  // Stop and target distances are measured from where the trade would be entered.
  const entry = isLimit ? (limit > 0 ? limit : undefined) : price;
  const sl = parseFloat(stopLoss), tp = parseFloat(takeProfit), tp2 = parseFloat(takeProfit2), share = parseFloat(tp1Share), trailPct = parseFloat(trail);
  const userLev = parseFloat(leverage);
  const maxUsd = Number(settings?.max_position_size_usd ?? 0);
  // No manual trade is sent without a stop (the server refuses it too). With the stop field empty the
  // order still carries one: a trailing stop on a market order, otherwise the default from Settings.
  const defaultSl = Number(settings?.default_stop_loss_percent);
  const hasDefaultSl = defaultSl >= 0.05 && defaultSl <= 50;
  const trailing = isMarket && trailPct > 0;
  const stopSource: 'ticket' | 'trail' | 'default' | 'none' = sl > 0 ? 'ticket' : trailing ? 'trail' : hasDefaultSl ? 'default' : 'none';
  // Distance of the stop the order will actually have, for sizing, the chart and the loss shown.
  const stopPct = stopSource === 'ticket' ? sl : stopSource === 'trail' ? trailPct : stopSource === 'default' ? defaultSl : NaN;

  const sized = useMemo(() => {
    if (sizeMode !== 'risk') return null;
    return sizeByRisk({ equity: equity ?? 0, risk: parseFloat(risk), riskUnit, stopPct, maxPositionUsd: maxUsd, maxLeverage: market?.maxLeverage ?? 50 });
  }, [sizeMode, equity, risk, riskUnit, stopPct, maxUsd, market]);

  const size = sizeMode === 'risk' ? sized?.sizeUsd ?? 0 : parseFloat(sizeUsd);
  // In risk mode the leverage is raised to whatever the size needs; it never changes the amount at risk.
  const lev = sizeMode === 'risk' && sized && !sized.error ? Math.max(userLev || 1, sized.leverageNeeded) : userLev;
  const margin = size > 0 && lev > 0 ? size / lev : null;
  const riskUsd = size > 0 && stopPct > 0 ? (size * stopPct) / 100 : null;
  const managed = isMarket && ((share > 0 && share < 100 && tp > 0) || trailPct > 0);
  const limitWrongSide = isLimit && limit > 0 && price != null && (side === 'long' ? limit >= price : limit <= price);

  const lines = useMemo<ChartLine[]>(() => {
    const out: ChartLine[] = [];
    for (const l of frame?.supports ?? []) out.push({ kind: 'support', label: 'Support', price: l.price });
    for (const l of frame?.resistances ?? []) out.push({ kind: 'resistance', label: 'Resist.', price: l.price });
    // Levels from the next slower chart, so a target is not set into one unseen.
    const up = frameExtra?.higher;
    const tag = up ? { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' }[up.timeframe] : '';
    for (const l of up?.supports ?? []) out.push({ kind: 'higher', label: `${tag} sup.`, price: l.price });
    for (const l of up?.resistances ?? []) out.push({ kind: 'higher', label: `${tag} res.`, price: l.price });
    if (entry) {
      out.push({ kind: 'entry', label: isLimit ? 'Limit' : 'Entry', price: entry });
      if (stopPct > 0) out.push({ kind: 'stop', label: 'Stop', price: entry * (1 - (dir * stopPct) / 100) });
      if (tp > 0) out.push({ kind: 'target', label: tp2 > 0 && managed ? 'Target 1' : 'Target', price: entry * (1 + (dir * tp) / 100) });
      if (tp2 > 0 && managed) out.push({ kind: 'target', label: 'Target 2', price: entry * (1 + (dir * tp2) / 100) });
    }
    return out;
  }, [frame, frameExtra, entry, isLimit, stopPct, tp, tp2, dir, managed]);

  const warnings = useMemo(() => (frameExtra && entry ? frameWarnings(frameExtra, timeframe, side, entry, tp > 0 ? entry * (1 + (dir * tp) / 100) : null) : []), [frameExtra, timeframe, side, entry, tp, dir]);
  const replay = (tfEvidence as TfEvidence).timeframes?.find(t => t.timeframe === timeframe);

  // What a market order of this size would cost against the book right now.
  useEffect(() => {
    setBook(null);
    const sym = symbol.trim().toUpperCase();
    if (!open || !isMarket || !sym || !(size >= 10)) return;
    const id = setTimeout(() => {
      fetch(`/api/book?symbol=${encodeURIComponent(sym)}&side=${side}&sizeUsd=${size / nSlices}`)
        .then(r => (r.ok ? r.json() : null)).then(d => setBook(d?.verdict ? d : null)).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, [open, isMarket, symbol, side, size, nSlices]);

  const blocked =
    stopSource === 'none' ? `A stop-loss is required: a manual trade is not sent without one. Enter a stop-loss${isMarket ? ' or a trailing stop' : ''}, or save a default stop-loss in Settings.`
    : !(size >= 10) ? (sized?.error ?? 'Size must be at least $10')
    : nSlices > 1 && size / nSlices < 10 ? 'Each slice must be at least $10'
    : isMarket && book?.verdict.level === 'block' ? book.verdict.message
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
          ...(isLimit ? { limitPx: limit, expiryHours: Number(expiryHours) } : orderType === 'chase' ? { chaseSeconds: Number(chaseSeconds) } : {
            slices: nSlices,
            tp1Fraction: share > 0 && share < 100 ? share / 100 : null, takeProfit2Pct: takeProfit2 || null,
            breakevenAfterTp1: breakeven, trailPct: trail || null,
          }),
          note,
          // What the ticket showed, so the trade can be tagged in the journal.
          context: suggestion || suggested ? { bias: suggestion?.bias ?? null, suggestedStopPct: suggested?.stopLossPct ?? null, timeframe } : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Order failed', { duration: 10000 }); return; }
      if (data.resting) {
        toast.success(data.chase
          ? `Chasing a ${data.side} on ${data.symbol} from $${formatPrice(Number(data.order.limit_px))}. It appears under open orders until it fills.`
          : `Limit ${data.side} resting on ${data.symbol} at $${formatPrice(Number(data.order.limit_px))}`);
      } else if (data.protectionError) {
        toast.error(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}, but the stop/target was NOT placed: ${data.protectionError}`, { duration: 20000 });
      } else {
        toast.success(`${data.symbol} ${data.side} opened at $${formatPrice(data.fillPrice)}${typeof data.slippageBps === 'number' ? ` (${(data.slippageBps / 100).toFixed(3)}% from the mid price)` : ''}`);
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

  const nearest = side === 'long' ? frame?.supports[0] : frame?.resistances[0];

  return (
    <>
      <Button onClick={() => setOpen(true)}><Plus className="w-4 h-4" />Trade manually</Button>

      <Dialog open={open} onOpenChange={o => !submitting && setOpen(o)}>
        <DialogContent className="max-w-lg max-h-[92dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New trade</DialogTitle>
            <DialogDescription>
              {settings ? `Hyperliquid · ${settings.is_testnet ? 'Testnet' : 'Real money'}` : 'Checking exchange settings…'}
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

            {side === 'long' && <StrategySearch market="crypto" symbol={symbol.trim().toUpperCase()} frame={timeframe} active={open} compact />}
            <details className="space-y-2">
              <summary className="text-sm font-medium cursor-pointer">Chart and timeframe</summary>
              <div className="flex items-center justify-between gap-2">
                <Label>Timeframe</Label>
                <Segmented aria-label="Chart and stop timeframe" value={timeframe} onChange={v => { setTimeframe(v); setEdited({ sl: false, tp: false }); }}
                  options={(Object.keys(TIMEFRAMES) as Timeframe[]).map(k => ({ value: k, label: TIMEFRAMES[k].label }))} />
              </div>
              {candles.length > 0 && <LevelsChart candles={candles.slice(-zoom)} lines={lines} height={210} interval={`${TIMEFRAMES[timeframe].label.toLowerCase()} candles`} className="rounded-lg border border-border bg-secondary/30 px-2 py-1.5" />}
              {candles.length > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1" role="group" aria-label="Candles shown">
                    <span className="mr-1">Show</span>
                    {ZOOMS.filter(z => z === ZOOMS[0] || candles.length > z / 2).map(z => (
                      <button key={z} type="button" onClick={() => setZoom(z)} aria-pressed={zoom === z}
                        className={cn('px-1.5 h-5 rounded border transition-colors', zoom === z ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border hover:text-foreground')}>
                        {z}
                      </button>
                    ))}
                    <span className="ml-1">candles</span>
                  </div>
                  {frameExtra && (
                    <p aria-label="Trend on each timeframe">
                      Trend:{' '}
                      {(Object.keys(TIMEFRAMES) as Timeframe[]).map((k, i) => {
                        const t = frameExtra.trends[k];
                        return (
                          <span key={k}>
                            {i > 0 && ' · '}
                            <span className={cn(k === timeframe && 'font-semibold text-foreground')}>{TIMEFRAMES[k].label}</span>{' '}
                            <span className={t === 'up' ? 'text-profit' : t === 'down' ? 'text-loss' : ''}>{t === 'up' ? '▲ up' : t === 'down' ? '▼ down' : 'n/a'}</span>
                          </span>
                        );
                      })}
                    </p>
                  )}
                </div>
              )}
              {warnings.map(w => <p key={w.kind} className="text-[11px] text-warning leading-relaxed">{w.message}</p>)}
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {tfError ? <span className="text-warning">{tfError}. </span> : null}
                For a trade held {TIMEFRAMES[timeframe].hold}. The stop, target and levels are taken from {TIMEFRAMES[timeframe].label.toLowerCase()} candles over {TIMEFRAMES[timeframe].span}
                {tfLevels ? ` (one candle moves about ${tfLevels.atrPct}%)` : ''}. Changing the timeframe re-fills the stop and target.
                {timeframe === '15m' && ' On a stop this tight, fees and slippage are a large share of the risk.'}
                {' '}This timeframe suits {TICKET_DEFAULTS[timeframe].suits}.
              </p>
              {replay && (
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground">Tested on history:</span> {replay.overall.ideas} past ideas with stops sized this way, each given {replay.windowDays} days. {replay.verdict}
                </p>
              )}
            </details>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Entry</Label>
                <Segmented aria-label="Order type" value={orderType} onChange={v => { setOrderType(v); setTypeChosen(true); }}
                  options={[{ value: 'market', label: 'Market now' }, ...(chaseAvailable ? [{ value: 'chase' as const, label: 'Chase' }] : []), { value: 'limit', label: 'Limit price' }]} />
              </div>
              {orderType === 'chase' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="tt-chase">Take the rest at market after</Label>
                    <select id="tt-chase" value={chaseSeconds} onChange={e => { setChaseSeconds(e.target.value); setTouched(x => ({ ...x, chase: true })); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                      <option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="300">5 minutes</option>
                    </select>
                  </div>
                  <p className="col-span-2 text-[11px] text-muted-foreground leading-relaxed">
                    Rests at the best {side === 'long' ? 'bid' : 'ask'} and follows the market (checked about every ten seconds), paying the 0.015% maker fee instead of 0.045% on whatever fills there.
                    When the time is up the remainder is taken at market, so you do get in. If the market runs away meanwhile you pay more than an immediate market order would have cost; the result is recorded either way.
                  </p>
                </div>
              )}
              {isMarket && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="tt-slices">Send as</Label>
                    <select id="tt-slices" value={slices} onChange={e => setSlices(e.target.value)} className="h-9 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="1">One order</option><option value="2">2 slices</option><option value="3">3 slices</option><option value="4">4 slices</option><option value="5">5 slices</option>
                    </select>
                  </div>
                  {book?.estimate && (
                    <p className={cn('text-[11px] leading-relaxed', book.verdict.level === 'ok' ? 'text-muted-foreground' : 'text-warning')}>
                      {book.verdict.message ?? `Order book: expect about ${((book.estimate.slippageBps ?? 0) / 100).toFixed(3)}% worse than the mid price${nSlices > 1 ? ' per slice' : ''} (spread ${(book.estimate.spreadBps / 100).toFixed(3)}%), plus the 0.045% taker fee.`}
                    </p>
                  )}
                  {nSlices > 1 && <p className="text-[11px] text-muted-foreground">Slices go two seconds apart, so the book can refill between them. The stop is placed once, for the whole position, after the last one.</p>}
                </div>
              )}
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
                    <select id="tt-expiry" value={expiryHours} onChange={e => { setExpiryHours(e.target.value); setTouched(x => ({ ...x, expiry: true })); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
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
                <Input id="tt-sl" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder={hasDefaultSl ? `Default ${defaultSl}` : 'Required'} value={stopLoss} onChange={e => { setStopLoss(e.target.value); setEdited(x => ({ ...x, sl: true })); }} />
                {entry && stopPct > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(entry * (1 - (dir * stopPct) / 100))}</p>}
                {stopSource === 'default' && <p className="text-[11px] text-muted-foreground">Left empty: your default stop of {defaultSl}% from Settings is used.</p>}
                {stopSource === 'trail' && <p className="text-[11px] text-muted-foreground">Left empty: the trailing stop starts {trailPct}% from entry.</p>}
                {stopSource === 'none' && <p className="text-[11px] text-warning">Required: a manual trade is not sent without a stop.</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tt-tp">Take-profit %</Label>
                <Input id="tt-tp" type="number" inputMode="decimal" min="0.05" step="0.1" placeholder="None" value={takeProfit} onChange={e => { setTakeProfit(e.target.value); setEdited(x => ({ ...x, tp: true })); }} />
                {entry && tp > 0 && <p className="num text-[11px] text-muted-foreground">≈ ${formatPrice(entry * (1 + (dir * tp) / 100))}</p>}
              </div>
            </div>

            {isMarket && (
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
                      Hyperliquid has no trailing or self-moving stop, so this app moves it for you, checking about every ten seconds.
                      Between checks the last stop placed still protects the position. With a split, trailing starts once target 1 has filled.
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
                  {timeframe !== '1h' && <p className="text-muted-foreground mt-1">The read above is always from the hourly and 4-hour rules; only the stop and target change with the timeframe.</p>}
                  {suggestion.bias !== 'neutral' && suggestion.bias !== side && (
                    <p className="text-warning mt-1">You are going {side}, against what the rules read.</p>
                  )}
                  <p className="text-muted-foreground mt-1">
                    {suggested ? <>Suggested for a {side} on the {TIMEFRAMES[timeframe].label.toLowerCase()} chart: stop {suggested.stopLossPct}% {suggested.stopBasis}; target {suggested.takeProfitPct}% {suggested.targetBasis}.{' '}</> : 'Loading the stop and target for this timeframe… '}
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
                <dd className={cn('num', riskUsd ? 'text-loss' : stopPct > 0 ? 'text-muted-foreground' : 'text-warning')}>
                  {riskUsd ? `≈ -$${riskUsd.toFixed(2)}${equity ? ` (${((riskUsd / equity) * 100).toFixed(2)}% of account)` : ''}` : stopPct > 0 ? '—' : 'No stop set'}
                </dd>
              </div>
            </dl>

            {blocked && <p className="text-xs text-warning">{blocked}</p>}
            <Button className={cn('w-full h-11 font-semibold', side === 'long' ? 'bg-profit text-black hover:bg-profit/90' : 'bg-loss text-white hover:bg-loss/90')} onClick={submit} disabled={submitting || !!blocked}>
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {isLimit ? `Place limit ${side === 'long' ? 'buy' : 'sell'}` : orderType === 'chase' ? `Chase ${side === 'long' ? 'long' : 'short'}` : side === 'long' ? 'Buy / Long' : 'Sell / Short'} {symbol}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
