import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { closePositionFully, openPosition, protectionPercent, MAX_LEVERAGE } from '@/lib/execution';
import { normalizeSymbol } from '@/lib/webhook';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function context() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: settings } = await createServiceClient().from('settings').select('*').eq('user_id', user.id).single();
  return { supabase, user, settings };
}

// Manual order from the trade ticket: a market entry with optional stop-loss / take-profit.
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

  if (settings.strategy_enabled && settings.strategy_dry_run === false && settings.strategy_symbol === symbol) {
    return bad(`${symbol} is being traded by the built-in strategy, which would undo a manual position. Turn it off first.`);
  }

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return bad('Connect your wallet in Settings first');

    const position = await hl.getPosition(symbol);
    if (position && position.side !== side) return bad(`You have an open ${position.side} in ${symbol}. Close it before opening a ${side}.`);
    const maxUsd = Number(settings.max_position_size_usd);
    const existing = position ? position.size * position.markPrice : 0;
    if (existing + sizeUsd > maxUsd) return bad(`That would take ${symbol} past your max position size of $${maxUsd}. Raise it in Settings if intended.`);

    const opened = await openPosition(hl, supabase, {
      userId: user.id, symbol, side, sizeUsd, leverage,
      slippagePercent: Number(settings.slippage_percent), stopLossPct, takeProfitPct, source: 'manual',
    });
    await notify(`Manual: opened ${side} ${opened.size} ${symbol} at ${opened.fillPrice} (${leverage}x)` + (opened.protectionError ? `. WARNING: stop/target NOT placed (${opened.protectionError})` : ''));
    return NextResponse.json({ success: true, symbol, side, ...opened });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
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
