import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { stockMarketClock } from '@/lib/stocks/session';
import { stockEntryUnresolved } from '@/lib/stocks/autopilot';
import { STOCK_ORDER_FIELDS, stockOrderAction, stockOrderEnvironment as environment, stockOrderInput as input } from '@/lib/stocks/manual-orders';
import { isStockTradeSymbol } from '@/lib/stocks/trade-rules';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

async function context() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  return { user, db: createServiceClient() };
}

export async function GET(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const query = new URL(request.url).searchParams;
  const env = environment.safeParse(query.get('environment'));
  if (!env.success) return fail('Select Demo or Real.', 400);
  if (query.has('symbol')) {
    const symbol = query.get('symbol');
    if (!isStockTradeSymbol(symbol)) return fail('Choose a supported stock.', 400);
    const connection = await ctx.db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', ctx.user.id).eq('environment', env.data).maybeSingle();
    if (connection.error || !connection.data) return fail('Connect this eToro account first.', 409);
    try {
      const broker = etoroFromConnection(connection.data);
      const instrument = await broker.instrument(symbol);
      if (!instrument) return fail('This stock is unavailable on eToro.', 422);
      return NextResponse.json({ options: await broker.stockOrderOptions(instrument.instrumentId) });
    } catch {
      return fail('Could not check eToro leverage for this stock.', 503);
    }
  }
  const list = () => ctx.db.from('etoro_stock_orders').select(STOCK_ORDER_FIELDS).eq('user_id', ctx.user.id).eq('environment', env.data).order('created_at', { ascending: false });
  // An order with an unknown outcome stays listed however old it is, because this list is where the owner resolves it.
  const [recent, unknown] = await Promise.all([list().neq('state', 'draft').limit(15), list().in('state', ['sending', 'review']).limit(25)]);
  if (recent.error || unknown.error) return fail('Could not load orders.', 503);
  const now = Date.now();
  const orders = [...recent.data, ...unknown.data.filter(order => !recent.data.some(listed => listed.id === order.id))];
  // resolvable marks an order whose outcome is still unknown after 15 minutes, which the owner may mark as not placed.
  return NextResponse.json({ marketOpen: stockMarketClock(now).open, orders: orders.map(order => ({ ...order, resolvable: stockEntryUnresolved(order, now) })) });
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Check the trade details.', 400);
  const body = parsed.data;
  const { db, user } = ctx;
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted, updated_at').eq('user_id', user.id).eq('environment', body.environment).maybeSingle();
  if (connection.error) return fail('eToro connection is unavailable.', 503);
  if (!connection.data) return fail(`Connect eToro ${body.environment === 'demo' ? 'Demo' : 'Real'} first.`, 409);
  // The actions run in lib/stocks/manual-orders.ts so tests can reach them without a signed-in request.
  const result = await stockOrderAction(db, etoroFromConnection(connection.data), user.id, connection.data.updated_at, body);
  return NextResponse.json(result.body, { status: result.status });
}
