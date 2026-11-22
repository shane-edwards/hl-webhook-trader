import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { closeOpenTrades } from '@/lib/trade-records';
import { parseWebhookPayload, planSignal, redactPayload } from '@/lib/webhook';
import { notify } from '@/lib/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LEVERAGE = 50;
const MIN_SECRET_LENGTH = 16;

export async function POST(request: Request) {
  const ip = (request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'unknown').split(',')[0].trim();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Requests that cannot be tied to a user are answered but not written to the
  // database, so an unauthenticated caller cannot fill the logs table.
  const parsed = parseWebhookPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const signal = parsed.signal;
  if (signal.secret.length < MIN_SECRET_LENGTH) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = createServiceClient();
  const { data: settings } = await supabase
    .from('settings')
    .select('*')
    .eq('webhook_secret', signal.secret)
    .maybeSingle();

  if (!settings) {
    console.warn('[webhook] rejected: invalid secret from', ip);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const payload = redactPayload(body);
  const userId: string = settings.user_id;
  const log = (status: 'processed' | 'rejected' | 'error', message: string | null, tradeId: string | null = null) =>
    supabase.from('webhook_logs').insert({
      user_id: userId,
      payload,
      status,
      error_message: message,
      trade_id: tradeId,
      ip_address: ip,
      created_at: new Date().toISOString(),
    });
  const reject = async (message: string, httpStatus: number) => {
    await log('rejected', message);
    return NextResponse.json({ error: message }, { status: httpStatus });
  };

  if (!settings.webhook_enabled) return reject('Webhook trading is currently disabled', 403);

  const { symbol } = signal;
  if (settings.strategy_enabled && settings.strategy_symbol === symbol) {
    return reject(`${symbol} is managed by the built-in strategy; disable it to trade ${symbol} by webhook`, 409);
  }

  const leverage = Math.round(signal.leverage ?? Number(settings.default_leverage));
  if (!(leverage >= 1 && leverage <= MAX_LEVERAGE)) return reject(`Leverage must be between 1 and ${MAX_LEVERAGE}`, 400);
  const sizeUsd = signal.sizeUsd ?? Number(settings.default_order_size_usd);
  const maxPositionSizeUsd = Number(settings.max_position_size_usd);
  const slippage = Number(settings.slippage_percent);

  let tradeId: string | null = null;

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) {
      await log('error', 'Hyperliquid not configured');
      return NextResponse.json({ error: 'Hyperliquid credentials not configured' }, { status: 500 });
    }

    const position = await hl.getPosition(symbol);
    const plan = planSignal({
      direction: signal.direction,
      isTargetPosition: signal.isTargetPosition,
      current: position ? { side: position.side, notionalUsd: position.size * position.markPrice } : null,
      orderSizeUsd: sizeUsd,
      maxPositionSizeUsd,
    });

    if (plan.type === 'none') {
      await log('rejected', plan.reason);
      return NextResponse.json({ success: false, message: plan.reason }, { status: 200 });
    }

    let closeFill: { fillPrice: number; filledSize: number } | null = null;
    if (plan.type === 'close' || plan.type === 'reverse') {
      const closed = await hl.closePosition(symbol, slippage);
      if (!closed.fullyClosed) {
        throw new Error(`Only ${closed.filledSize} of ${position!.size} ${symbol} closed; position is still open on the exchange`);
      }
      const ids = await closeOpenTrades(supabase, userId, symbol, closed.fillPrice);
      tradeId = ids[0] ?? null;
      closeFill = closed;

      if (plan.type === 'close') {
        await log('processed', null, tradeId);
        await notify(`Webhook: closed ${symbol} at ${closed.fillPrice}`);
        return NextResponse.json({ success: true, action: 'close', symbol, fillPrice: closed.fillPrice, size: closed.filledSize });
      }
    }

    const side = plan.side;
    const result = await hl.placeMarketOrder({
      coin: symbol,
      isBuy: side === 'long',
      sizeUsd,
      leverage,
      reduceOnly: false,
      slippagePercent: slippage,
    });

    const now = new Date().toISOString();
    const { data: trade, error: insertError } = await supabase
      .from('trades')
      .insert({
        user_id: userId,
        symbol,
        side,
        status: 'open',
        entry_price: result.fillPrice,
        size: result.sizeInContracts,
        size_usd: result.sizeInContracts * result.fillPrice,
        leverage,
        entry_time: now,
        signal_source: 'webhook',
        webhook_payload: payload,
        hyperliquid_order_id: result.orderId,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (insertError) {
      // The order is live on the exchange; make the missing record loud rather than silent.
      throw new Error(`Order ${result.orderId} filled but could not be recorded: ${insertError.message}`);
    }

    tradeId = trade.id;
    await log('processed', null, tradeId);
    await notify(`Webhook: opened ${side} ${result.sizeInContracts} ${symbol} at ${result.fillPrice} (${leverage}x)`);

    return NextResponse.json({
      success: true,
      action: side,
      reversed: closeFill != null,
      symbol,
      fillPrice: result.fillPrice,
      size: result.sizeInContracts,
      leverage,
      tradeId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await log('error', message, tradeId);
    await notify(`Webhook ERROR on ${symbol}: ${message}`);
    console.error('[webhook]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
