import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { closePositionFully } from '@/lib/execution';

export const dynamic = 'force-dynamic';

const MANUAL_NOTE = 'Manually closed from dashboard';

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

  try {
    const hl = hlClientFromSettings(settings);
    if (!hl) return NextResponse.json({ error: 'Hyperliquid credentials not configured' }, { status: 400 });

    // The position may already be gone (closed on the exchange directly, or
    // liquidated). The record is then stale: cancel it instead of failing forever.
    const position = await hl.getPosition(trade.symbol);
    if (!position) {
      const now = new Date().toISOString();
      const { data: cancelled, error } = await supabase
        .from('trades')
        .update({ status: 'cancelled', exit_time: now, notes: 'No matching position on the exchange', updated_at: now })
        .eq('user_id', user.id)
        .eq('symbol', trade.symbol)
        .eq('status', 'open')
        .select();
      if (error) throw new Error(error.message);
      return NextResponse.json({ trade: cancelled?.find(t => t.id === id) ?? null, fillPrice: null });
    }

    // Closing on the exchange closes the whole position, so every open record
    // for the symbol is settled, not just the one that was clicked.
    const closed = await closePositionFully(hl, serviceClient, user.id, trade.symbol, Number(settings.slippage_percent), MANUAL_NOTE);

    const { data: updated } = await supabase.from('trades').select('*').eq('id', id).single();
    return NextResponse.json({ trade: updated, fillPrice: closed.fillPrice });
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

  const body = await request.json().catch(() => null);
  const notes = body?.notes;
  if (notes != null && typeof notes !== 'string') {
    return NextResponse.json({ error: 'notes must be a string' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('trades')
    .update({ notes: notes == null ? null : notes.slice(0, 2000), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trade: data });
}
