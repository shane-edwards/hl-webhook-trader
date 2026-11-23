import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { isStockSymbol } from '@/lib/stocks/etoro';
import { STOCK_RULES } from '@/lib/stocks/research';

const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
const settingFields = 'symbol, strategy, amount, active_environment, last_run_at, last_message';
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('start'), symbol: z.string(), strategy: z.string(), amount: z.number().min(1).max(10_000), environment: z.enum(['demo', 'real']), confirmed: z.literal(true) }),
]);

async function context() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user ? { user, db: createServiceClient() } : null;
}

export async function GET() {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const { data, error } = await ctx.db.from('stock_autopilot').select(settingFields).eq('user_id', ctx.user.id).maybeSingle();
  return error ? fail('Could not load stock Autopilot.', 503) : NextResponse.json({ settings: data });
}

export async function PUT(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail('Choose a stock, strategy and amount, then confirm.', 400);
  const { db, user } = ctx;
  const value = parsed.data;
  const now = new Date().toISOString();
  if (value.action === 'pause') {
    const { data, error } = await db.from('stock_autopilot').update({ active_environment: null, updated_at: now }).eq('user_id', user.id).select(settingFields).maybeSingle();
    return error ? fail('Could not pause stock Autopilot.', 503) : NextResponse.json({ settings: data });
  }
  if (!isStockSymbol(value.symbol) || !STOCK_RULES.some(rule => rule.id === value.strategy)) return fail('Choose a supported stock and daily strategy.', 400);
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', user.id).eq('environment', value.environment).maybeSingle();
  if (connection.error || !connection.data) return fail('Connect eToro in this mode first.', 409);
  const amount = Math.round(value.amount * 100) / 100;
  try {
    const broker = etoroFromConnection(connection.data);
    const market = await broker.instrument(value.symbol);
    if (!market) return fail('This ticker is unavailable on eToro.', 422);
    const eligible = await broker.stockEligibility(market.instrumentId);
    if (!eligible.allowed || amount < eligible.minimum) return fail(`This account needs an eligible cash-stock buy of at least $${eligible.minimum.toFixed(2)}.`, 422);
  } catch {
    return fail('Could not check eToro eligibility.', 503);
  }
  const { data, error } = await db.from('stock_autopilot').upsert({
    user_id: user.id, symbol: value.symbol, strategy: value.strategy, amount, active_environment: value.environment,
    updated_at: now, last_run_at: null, last_message: null,
  }).select(settingFields).single();
  return error ? fail('Could not start stock Autopilot.', 503) : NextResponse.json({ settings: data });
}
