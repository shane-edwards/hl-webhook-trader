import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { reconcileStockOrder } from '@/lib/stocks/autopilot';
import { readStockCloseExecution, type StockJournalOrder } from '@/lib/stocks/execution-journal';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const mode = z.enum(['demo', 'real']);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sync'), environment: mode }),
  z.object({ action: z.literal('financing'), environment: mode, id: z.uuid(), usd: z.number().min(-100_000).max(100_000).nullable() }),
]);
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

async function context() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user ? { id: user.id, db: createServiceClient() } : null;
}

export async function GET(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const env = mode.safeParse(new URL(request.url).searchParams.get('environment'));
  if (!env.success) return fail('Choose Paper or Live.', 400);
  const [orders, scans, connection] = await Promise.all([
    ctx.db.from('etoro_stock_orders').select('id, created_at, symbol, strategy, state, reference_price, decision_quote, submission_quote, estimated_costs, fill_metrics, broker_message, close_execution, closed_at, signal_day, signal_expires_at, statement_financing_usd, broker_order_id, broker_state, request')
      .eq('user_id', ctx.id).eq('environment', env.data).order('created_at', { ascending: false }).limit(100),
    ctx.db.from('stock_scan_journal').select('observed_at, state, detail').eq('user_id', ctx.id).eq('environment', env.data).order('observed_at', { ascending: false }).limit(50),
    ctx.db.from('etoro_connections').select('environment').eq('user_id', ctx.id).eq('environment', env.data).maybeSingle(),
  ]);
  return orders.error || scans.error || connection.error ? fail('Could not load the execution journal.', 503)
    : NextResponse.json({ orders: orders.data, scans: scans.data, connected: !!connection.data, asOf: Date.now() });
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Choose a valid execution journal action.', 400);
  const { environment } = parsed.data;
  const scope = () => ctx.db.from('etoro_stock_orders').select('*').eq('user_id', ctx.id).eq('environment', environment);
  if (parsed.data.action === 'financing') {
    const { id, usd } = parsed.data;
    const saved = await ctx.db.from('etoro_stock_orders').update({ statement_financing_usd: usd }).eq('id', id)
      .eq('user_id', ctx.id).eq('environment', environment).eq('state', 'filled').eq('request->>settlementType', 'cfd').select('id').maybeSingle();
    return saved.error ? fail('Could not save the statement financing.', 503)
      : !saved.data ? fail('Choose a filled CFD order.', 404) : NextResponse.json({ updated: 1 });
  }
  const [connection, recent] = await Promise.all([
    ctx.db.from('etoro_connections').select('environment, credentials_encrypted, updated_at').eq('user_id', ctx.id).eq('environment', environment).maybeSingle(),
    scope().neq('state', 'draft').neq('state', 'rejected').order('created_at', { ascending: false }).limit(40),
  ]);
  if (connection.error || recent.error) return fail('Could not read this account’s orders.', 503);
  if (!connection.data) return fail('Connect eToro in this mode to refresh broker fills.', 409);
  const account = connection.data;
  const broker = etoroFromConnection(account);
  const rows = recent.data.filter(row => row.connection_version === account.updated_at &&
    (!row.fill_metrics || row.state !== 'filled' || row.broker_state === 5 || Object.values(row.close_execution as StockJournalOrder['close_execution']).some(close => !close.complete))).slice(0, 6);
  const results = await Promise.allSettled(rows.map(async row => {
    const patch: Record<string, unknown> = {};
    if (!row.fill_metrics || row.state !== 'filled' || row.broker_state === 5) {
      const { message, ...summary } = await reconcileStockOrder(broker, row.id, row.request);
      Object.assign(patch, row.state === 'filled' ? { fill_metrics: summary.fill_metrics ?? row.fill_metrics,
        broker_state: summary.broker_state, broker_message: message }
        : { ...summary, broker_message: message, updated_at: new Date().toISOString() });
    }
    const closes = await Promise.all(Object.entries(row.close_execution as StockJournalOrder['close_execution'])
      .map(async ([id, close]) => [id, await readStockCloseExecution(broker, row.request.instrumentId, id, close).catch(() => close)] as const));
    if (closes.length) patch.close_execution = Object.fromEntries(closes);
    const saved = await ctx.db.from('etoro_stock_orders').update(patch).eq('id', row.id).eq('user_id', ctx.id).eq('environment', environment)
      .eq('updated_at', row.updated_at).eq('state', row.state).select('id').maybeSingle();
    if (saved.error) throw saved.error;
    return !!saved.data;
  }));
  return NextResponse.json({ updated: results.filter(result => result.status === 'fulfilled' && result.value).length,
    unavailable: results.filter(result => result.status === 'rejected').length });
}
