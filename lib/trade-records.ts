import type { SupabaseClient } from '@supabase/supabase-js';
import { computePnl } from './trades';

/**
 * Marks every open trade row for a symbol as closed at `exitPrice`.
 * A position can be built from several entries, and closing it on the exchange
 * closes all of them, so all rows are settled together.
 * Returns the ids of the rows that were closed (newest first).
 */
export async function closeOpenTrades(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  symbol: string,
  exitPrice: number,
  notes?: string,
  /** When the position actually closed, if known (e.g. from the exchange's fills). Defaults to now. */
  exitTime?: Date
): Promise<string[]> {
  const { data: open, error } = await supabase
    .from('trades')
    .select('id, side, entry_price, size, leverage, entry_time')
    .eq('user_id', userId)
    .eq('symbol', symbol)
    .eq('status', 'open')
    .order('entry_time', { ascending: false });

  if (error) throw new Error(`Could not load open trades: ${error.message}`);

  const now = exitTime ?? new Date();
  const closed: string[] = [];
  for (const t of open ?? []) {
    const { pnl, pnlPercentage } = computePnl({
      side: t.side,
      entryPrice: Number(t.entry_price),
      exitPrice,
      size: Number(t.size),
      leverage: Number(t.leverage),
    });
    const { error: updateError } = await supabase
      .from('trades')
      .update({
        status: 'closed',
        exit_price: exitPrice,
        exit_time: now.toISOString(),
        duration_seconds: Math.max(0, Math.floor((now.getTime() - new Date(t.entry_time).getTime()) / 1000)),
        pnl,
        pnl_percentage: pnlPercentage,
        ...(notes ? { notes } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', t.id)
      .eq('status', 'open');
    if (updateError) throw new Error(`Could not close trade ${t.id}: ${updateError.message}`);
    closed.push(t.id);
  }
  return closed;
}
