import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/server';
import { createHLClient } from '@/lib/hyperliquid/client';
import { decrypt } from '@/lib/encryption';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (tradeError || !trade) {
    return NextResponse.json({ error: 'Trade not found' }, { status: 404 });
  }

  if (trade.status !== 'open') {
    return NextResponse.json({ error: 'Trade is not open' }, { status: 400 });
  }

  const serviceClient = createServiceClient();
  const { data: settings } = await serviceClient
    .from('settings')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!settings) {
    return NextResponse.json({ error: 'Settings not found' }, { status: 500 });
  }

  const privateKey = process.env.HL_PRIVATE_KEY ?? decrypt(settings.hl_private_key_encrypted!);
  const isTestnet = process.env.HL_TESTNET === 'true' || settings.is_testnet;
  const hl = createHLClient({ privateKey, isTestnet });

  try {
    const { fillPrice } = await hl.closePosition(trade.symbol, settings.slippage_percent);

    const exitTime = new Date().toISOString();
    const durationSeconds = Math.floor(
      (Date.now() - new Date(trade.entry_time).getTime()) / 1000
    );

    const pnlPct = trade.side === 'long'
      ? ((fillPrice - trade.entry_price) / trade.entry_price) * 100 * trade.leverage
      : ((trade.entry_price - fillPrice) / trade.entry_price) * 100 * trade.leverage;
    const pnl = (pnlPct / 100) * trade.size_usd;

    const { data: updated, error: updateError } = await supabase
      .from('trades')
      .update({
        status: 'closed',
        exit_price: fillPrice,
        exit_time: exitTime,
        duration_seconds: durationSeconds,
        pnl,
        pnl_percentage: pnlPct,
        notes: 'Manually cancelled from dashboard',
        updated_at: exitTime,
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw new Error(updateError.message);

    return NextResponse.json({ trade: updated, fillPrice });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { notes } = body;

  const { data, error } = await supabase
    .from('trades')
    .update({ notes, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data });
}
