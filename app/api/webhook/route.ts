import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { createHLClient } from '@/lib/hyperliquid/client';
import { decrypt } from '@/lib/encryption';
import type { WebhookPayload } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'unknown';
  let payload: WebhookPayload | null = null;

  const supabase = createServiceClient();

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!payload?.secret || !payload?.action || !payload?.symbol) {
    await logWebhook(supabase, null, (payload ?? {}) as Record<string, unknown>, 'rejected', 'Missing required fields', ip);
    return NextResponse.json({ error: 'Missing required fields: secret, action, symbol' }, { status: 400 });
  }

  // Find user by webhook secret
  const { data: settings, error: settingsError } = await supabase
    .from('settings')
    .select('*')
    .eq('webhook_secret', payload.secret)
    .single();

  if (settingsError || !settings) {
    await logWebhook(supabase, null, payload, 'rejected', 'Invalid webhook secret', ip);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!settings.webhook_enabled) {
    await logWebhook(supabase, settings.user_id, payload, 'rejected', 'Webhook trading disabled', ip);
    return NextResponse.json({ error: 'Webhook trading is currently disabled' }, { status: 403 });
  }

  if (!settings.hl_private_key_encrypted && !process.env.HL_PRIVATE_KEY) {
    await logWebhook(supabase, settings.user_id, payload, 'error', 'Hyperliquid not configured', ip);
    return NextResponse.json({ error: 'Hyperliquid credentials not configured' }, { status: 500 });
  }

  const privateKey = process.env.HL_PRIVATE_KEY ?? decrypt(settings.hl_private_key_encrypted!);
  const isTestnet = process.env.HL_TESTNET === 'true' || settings.is_testnet;

  const hl = createHLClient({ privateKey, isTestnet });

  const action = payload.action.toLowerCase() as string;
  const symbol = payload.symbol.toUpperCase();
  const isBuy = ['buy', 'long'].includes(action);
  const isClose = action === 'close';

  const leverage = payload.leverage ?? settings.default_leverage;
  const sizeUsd = payload.size_usd ?? settings.default_order_size_usd;

  let tradeId: string | null = null;

  try {
    if (isClose) {
      // Close existing position
      const positions = await hl.getPositions();
      const pos = positions.find(p => p.symbol === symbol);

      if (!pos) {
        await logWebhook(supabase, settings.user_id, payload, 'rejected', `No open position for ${symbol}`, ip);
        return NextResponse.json({ message: `No open position for ${symbol}` }, { status: 200 });
      }

      const { fillPrice } = await hl.closePosition(symbol, settings.slippage_percent);

      // Find and close the open trade record
      const { data: openTrade } = await supabase
        .from('trades')
        .select('id, entry_price, size, size_usd, leverage, entry_time')
        .eq('user_id', settings.user_id)
        .eq('symbol', symbol)
        .eq('status', 'open')
        .order('entry_time', { ascending: false })
        .limit(1)
        .single();

      if (openTrade) {
        const exitTime = new Date().toISOString();
        const entryTime = new Date(openTrade.entry_time ?? Date.now()).getTime();
        const durationSeconds = Math.floor((Date.now() - entryTime) / 1000);
        const pnlPct = pos.side === 'long'
          ? ((fillPrice - openTrade.entry_price) / openTrade.entry_price) * 100 * openTrade.leverage
          : ((openTrade.entry_price - fillPrice) / openTrade.entry_price) * 100 * openTrade.leverage;
        const pnl = (pnlPct / 100) * openTrade.size_usd;

        const { data: updated } = await supabase
          .from('trades')
          .update({
            status: 'closed',
            exit_price: fillPrice,
            exit_time: exitTime,
            duration_seconds: durationSeconds,
            pnl,
            pnl_percentage: pnlPct,
            updated_at: exitTime,
          })
          .eq('id', openTrade.id)
          .select('id')
          .single();

        tradeId = updated?.id ?? null;
      }

      await logWebhook(supabase, settings.user_id, payload, 'processed', null, ip, tradeId);
      return NextResponse.json({ success: true, action: 'close', symbol, fillPrice });
    }

    // Open new position
    const result = await hl.placeMarketOrder({
      coin: symbol,
      isBuy,
      sizeUsd,
      leverage,
      reduceOnly: false,
      slippagePercent: settings.slippage_percent,
    });

    const now = new Date().toISOString();
    const { data: trade } = await supabase
      .from('trades')
      .insert({
        user_id: settings.user_id,
        symbol,
        side: isBuy ? 'long' : 'short',
        status: 'open',
        entry_price: result.fillPrice,
        size: result.sizeInContracts,
        size_usd: sizeUsd,
        leverage,
        entry_time: now,
        signal_source: 'webhook',
        webhook_payload: payload as unknown as Record<string, unknown>,
        hyperliquid_order_id: result.orderId,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    tradeId = trade?.id ?? null;
    await logWebhook(supabase, settings.user_id, payload, 'processed', null, ip, tradeId);

    return NextResponse.json({
      success: true,
      action: isBuy ? 'long' : 'short',
      symbol,
      fillPrice: result.fillPrice,
      size: result.sizeInContracts,
      leverage,
      tradeId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await logWebhook(supabase, settings.user_id, payload, 'error', message, ip, tradeId);
    console.error('[webhook]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function logWebhook(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  status: 'processed' | 'rejected' | 'error',
  errorMessage: string | null,
  ipAddress: string,
  tradeId: string | null = null
) {
  await supabase.from('webhook_logs').insert({
    user_id: userId,
    payload,
    status,
    error_message: errorMessage,
    trade_id: tradeId,
    ip_address: ipAddress,
    created_at: new Date().toISOString(),
  });
}
