import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { closePositionFully, openPosition, protectionPercent, MAX_LEVERAGE } from '@/lib/execution';
import { normalizeSymbol } from '@/lib/webhook';
import { notify } from '@/lib/notify';
import { portfolioLimitsFromSettings } from '@/lib/risk/portfolio';
import { MAX_EXPIRY_HOURS, placeLimitEntry } from '@/lib/pending';
import { journalTags } from '@/lib/journal';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  // Writes go through the service client: trade rows carry the user id explicitly, and the
  // exit-plan, pending-order and portfolio tables accept writes from the server only.
  const service = createServiceClient();
  const { data: settings } = await service.from('settings').select('*').eq('user_id', user.id).single();
  return { supabase: service, user, settings };
}

// Manual order from the trade ticket: a market entry, or a post-only limit entry when
// `limitPx` is given, with optional stop-loss / take-profit and managed exits.
export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabase, user, settings } = ctx;
  if (!settings) return NextResponse.json({ error: 'Settings not found' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const bad = (message: string) => NextResponse.json({ error: message }, { status: 400 });
  if (!body || typeof body !== 'object') return bad('Invalid JSON body');

  const symbol = normalizeSymbol(String(body.symbol ?? ''));
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return bad('Choose a market');
  if (body.side !== 'long' && body.side !== 'short') return bad('Side must be long or short');
  const side: 'long' | 'short' = body.side;
  const sizeUsd = Number(body.sizeUsd);
  if (!Number.isFinite(sizeUsd) || sizeUsd < 10) return bad('Size must be at least $10');
  const leverage = Number(body.leverage);
  if (!Number.isInteger(leverage) || leverage < 1 || leverage > MAX_LEVERAGE) return bad(`Leverage must be a whole number from 1 to ${MAX_LEVERAGE}`);
  const stopLossPct = protectionPercent(body.stopLossPct);
  const takeProfitPct = protectionPercent(body.takeProfitPct);
  if (body.stopLossPct != null && body.stopLossPct !== '' && stopLossPct == null) return bad('Stop-loss must be between 0.05% and 50%');
  if (body.takeProfitPct != null && body.takeProfitPct !== '' && takeProfitPct == null) return bad('Take-profit must be between 0.05% and 50%');

  // Managed exits (market entries only).
  const fraction = body.tp1Fraction == null || body.tp1Fraction === '' ? null : Number(body.tp1Fraction);
  if (fraction != null && !(fraction > 0 && fraction <= 1)) return bad('Share closed at target 1 must be between 1% and 100%');
  const takeProfit2Pct = protectionPercent(body.takeProfit2Pct);
  if (body.takeProfit2Pct != null && body.takeProfit2Pct !== '' && takeProfit2Pct == null) return bad('Target 2 must be between 0.05% and 50%');
  if (takeProfit2Pct != null && takeProfitPct != null && takeProfit2Pct <= takeProfitPct) return bad('Target 2 must be further away than target 1');
  const trailPct = protectionPercent(body.trailPct);
  if (body.trailPct != null && body.trailPct !== '' && trailPct == null) return bad('Trailing distance must be between 0.05% and 50%');
  const exit = { tp1Fraction: fraction, takeProfit2Pct, breakevenAfterTp1: body.breakevenAfterTp1 === true, trailPct };

  const limitPx = body.limitPx == null || body.limitPx === '' ? null : Number(body.limitPx);
  if (limitPx != null && !(limitPx > 0)) return bad('Limit price must be a positive number');
  const expiryHours = body.expiryHours == null ? 24 : Number(body.expiryHours);
  if (limitPx != null && !(expiryHours >= 1 && expiryHours <= MAX_EXPIRY_HOURS)) return bad(`Expiry must be between 1 hour and ${MAX_EXPIRY_HOURS / 24} days`);

  if (settings.strategy_enabled && settings.strategy_dry_run === false && settings.strategy_symbol === symbol) {
    return bad(`${symbol} is being traded by the built-in strategy, which would undo a manual position. Turn it off first.`);
  }

  // Journal: how this trade relates to what the rules read, worked out from what the ticket showed.
  const journal = journalTags({ side, stopLossPct, context: body.context, note: body.note });
  const limits = portfolioLimitsFromSettings(settings);

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return bad('Connect your wallet in Settings first');

    const position = await hl.getPosition(symbol);
    if (position && position.side !== side) return bad(`You have an open ${position.side} in ${symbol}. Close it before opening a ${side}.`);
    const maxUsd = Number(settings.max_position_size_usd);
    const existing = position ? position.size * position.markPrice : 0;
    if (existing + sizeUsd > maxUsd) return bad(`That would take ${symbol} past your max position size of $${maxUsd}. Raise it in Settings if intended.`);

    if (limitPx != null) {
      const order = await placeLimitEntry(hl, supabase, {
        userId: user.id, symbol, side, limitPx, sizeUsd, leverage, stopLossPct, takeProfitPct, expiryHours, journal, limits,
      });
      await notify(`Manual: limit ${side} resting on ${symbol} at ${order.limit_px} (${order.size} ${symbol}, expires in ${expiryHours}h)`);
      return NextResponse.json({ success: true, resting: true, symbol, side, order });
    }

    const opened = await openPosition(hl, supabase, {
      userId: user.id, symbol, side, sizeUsd, leverage,
      slippagePercent: Number(settings.slippage_percent), stopLossPct, takeProfitPct, source: 'manual',
      exit, limits, payload: { journal },
    });
    await notify(`Manual: opened ${side} ${opened.size} ${symbol} at ${opened.fillPrice} (${leverage}x)` + (opened.protectionError ? `. WARNING: stop/target NOT placed (${opened.protectionError})` : ''));
    return NextResponse.json({ success: true, symbol, side, ...opened });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: /^Blocked by a portfolio limit|must be (below|above)/.test(message) ? 400 : 500 });
  }
}

// Close a whole position by symbol. Works for any position on the account,
// including ones opened by the built-in strategy or directly on Hyperliquid.
export async function DELETE(request: Request) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { supabase, user, settings } = ctx;

  const symbol = normalizeSymbol(new URL(request.url).searchParams.get('symbol') ?? '');
  if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return NextResponse.json({ error: 'Missing symbol' }, { status: 400 });

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ error: 'Connect your wallet in Settings first' }, { status: 400 });
    const closed = await closePositionFully(hl, supabase, user.id, symbol, Number(settings?.slippage_percent ?? 2), 'Manually closed from dashboard');
    await notify(`Manual: closed ${symbol} at ${closed.fillPrice}`);
    return NextResponse.json({ success: true, symbol, fillPrice: closed.fillPrice, size: closed.size });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
