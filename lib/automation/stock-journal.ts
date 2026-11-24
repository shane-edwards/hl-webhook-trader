import type { createServiceClient } from '@/lib/supabase/server';
import { reconcileStockOrder } from '@/lib/stocks/autopilot';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { readStockCloseExecution, type StockJournalOrder } from '@/lib/stocks/execution-journal';

type Db = ReturnType<typeof createServiceClient>;

export async function refreshScheduledStockJournal(db: Db, userId: string) {
  const [links, orders] = await Promise.all([
    db.from('etoro_connections').select('environment, credentials_encrypted, updated_at').eq('user_id', userId),
    db.from('etoro_stock_orders').select('id, environment, connection_version, request, state, broker_state, updated_at, fill_metrics, close_execution')
      .eq('user_id', userId).in('state', ['sending', 'review', 'submitted', 'filled'])
      .order('created_at', { ascending: false }).limit(40),
  ]);
  if (links.error || orders.error) throw new Error('The eToro journal is unavailable.');
  const candidates = orders.data.filter(order => !order.fill_metrics || order.state !== 'filled' || order.broker_state === 5 ||
    Object.values(order.close_execution as StockJournalOrder['close_execution']).some(close => !close.complete)).slice(0, 6);
  const refresh = await Promise.allSettled(candidates.map(async order => {
    const link = links.data.find(item => item.environment === order.environment && item.updated_at === order.connection_version);
    if (!link) return false;
    const broker = etoroFromConnection(link);
    const patch: Record<string, unknown> = {};
    if (order.state !== 'filled' || !order.fill_metrics || order.broker_state === 5) {
      const { message, ...summary } = await reconcileStockOrder(broker, order.id, order.request);
      Object.assign(patch, order.state === 'filled' ? { fill_metrics: summary.fill_metrics ?? order.fill_metrics, broker_state: summary.broker_state }
        : { ...summary, broker_message: message, updated_at: new Date().toISOString() });
    }
    const closes = Object.entries(order.close_execution as StockJournalOrder['close_execution']);
    if (closes.length) patch.close_execution = Object.fromEntries(await Promise.all(closes.map(async ([id, close]) =>
      [id, await readStockCloseExecution(broker, order.request.instrumentId, id, close).catch(() => close)] as const)));
    const saved = await db.from('etoro_stock_orders').update(patch).eq('user_id', userId).eq('id', order.id)
      .eq('updated_at', order.updated_at).eq('state', order.state).select('id').maybeSingle();
    return !saved.error && !!saved.data;
  }));
  const updated = refresh.filter(item => item.status === 'fulfilled' && item.value).length;
  return { updated, awaitingBroker: candidates.length - updated };
}
