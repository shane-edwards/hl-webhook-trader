import type { HyperliquidClient } from './hyperliquid/client';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { closePositionFully, openPosition, protectionPercent, MAX_LEVERAGE } from '@/lib/execution';
import { parseWebhookPayload, planSignal } from '@/lib/webhook';
import { notify } from '@/lib/notify';
import { portfolioLimitsFromSettings } from '@/lib/risk/portfolio';

export async function executeWebhookJob(userId: string, payload: Record<string, unknown>, leasedClient: HyperliquidClient) {
  const supabase = createServiceClient();
  const { data: settings, error } = await supabase.from('settings').select('*').eq('user_id', userId).single();
  if (error || !settings) throw new Error('Webhook account settings unavailable');
  const body = { ...payload, secret: settings.webhook_secret };
  const parsed = parseWebhookPayload(body);
  if (!parsed.ok) throw new Error(parsed.error);
  const signal = parsed.signal;
  const notifyUser = (message: string) => notify(message, undefined, userId);
  const log = (status: 'processed' | 'rejected' | 'error', message: string | null, tradeId: string | null = null) =>
    supabase.from('webhook_logs').insert({
      user_id: userId,
      payload,
      status,
      error_message: message,
      trade_id: tradeId,
      ip_address: null,
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
  // Per-signal stop/target (percent from entry) override the defaults from Settings.
  const raw = body as Record<string, unknown>;
  const stopLossPct = protectionPercent(raw.stop_loss_pct ?? settings.default_stop_loss_percent);
  const takeProfitPct = protectionPercent(raw.take_profit_pct ?? settings.default_take_profit_percent);
  if (raw.stop_loss_pct != null && stopLossPct == null) return reject('stop_loss_pct must be between 0.05 and 50', 400);
  if (raw.take_profit_pct != null && takeProfitPct == null) return reject('take_profit_pct must be between 0.05 and 50', 400);

  let tradeId: string | null = null;

  try {
    const hl = leasedClient;
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

    let reversed = false;
    if (plan.type === 'close' || plan.type === 'reverse') {
      const closed = await closePositionFully(hl, supabase, userId, symbol, slippage);
      tradeId = closed.tradeIds[0] ?? null;
      reversed = true;

      if (plan.type === 'close') {
        await log('processed', null, tradeId);
        await notifyUser(`Webhook: closed ${symbol} at ${closed.fillPrice}`);
        return NextResponse.json({ success: true, action: 'close', symbol, fillPrice: closed.fillPrice, size: closed.size });
      }
    }

    const side = plan.side;
    const opened = await openPosition(hl, supabase, {
      userId, symbol, side, sizeUsd, leverage, slippagePercent: slippage,
      stopLossPct, takeProfitPct, source: 'webhook', payload, limits: portfolioLimitsFromSettings(settings), closeIfUnprotected: true,
    });
    if (opened.closedUnprotected) {
      const message = `${symbol} ${side} was opened and closed again at once: its stop-loss could not be placed (${opened.protectionError})`;
      await log('error', message, opened.tradeId);
      await notifyUser(`Webhook: ${message}`);
      return NextResponse.json({ error: message }, { status: 502 });
    }
    tradeId = opened.tradeId;
    await log('processed', opened.protectionError ? `Opened WITHOUT stop/target: ${opened.protectionError}` : null, tradeId);
    await notifyUser(
      `Webhook: opened ${side} ${opened.size} ${symbol} at ${opened.fillPrice} (${leverage}x)` +
        (opened.stopLossPx ? `, stop ${opened.stopLossPx.toFixed(2)}` : '') +
        (opened.takeProfitPx ? `, target ${opened.takeProfitPx.toFixed(2)}` : '') +
        (opened.protectionError ? `. WARNING: stop/target NOT placed (${opened.protectionError})` : '')
    );

    return NextResponse.json({
      success: true,
      action: side,
      reversed,
      symbol,
      fillPrice: opened.fillPrice,
      size: opened.size,
      leverage,
      tradeId,
      stopLossPx: opened.stopLossPx,
      takeProfitPx: opened.takeProfitPx,
      protectionError: opened.protectionError,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await log('error', message, tradeId);
    await notifyUser(`Webhook ERROR on ${symbol}: ${message}`);
    console.error('[webhook]', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
