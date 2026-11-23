import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readStockGuard } from '@/lib/stocks/strategy-guard-data';
import { isStockTradeRule } from '@/lib/stocks/trade-rules';

export const dynamic = 'force-dynamic';
const accountMode = z.enum(['demo', 'real']);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), environment: accountMode, enabled: z.boolean(),
    minimum_trades: z.number().int().min(5).max(30), max_slippage_bps: z.number().positive().max(300),
    max_net_loss_usd: z.number().positive().max(100_000) }),
  z.object({ action: z.literal('reset'), environment: accountMode, strategy: z.string(), confirmed: z.literal(true) }),
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
  const env = accountMode.safeParse(new URL(request.url).searchParams.get('environment') ?? 'real');
  if (!env.success) return fail('Choose Paper or Live.', 400);
  try { return NextResponse.json(await readStockGuard(ctx.db, ctx.id, env.data)); }
  catch { return fail('Could not load the strategy scorecard.', 503); }
}

export async function PUT(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const input = command.safeParse(await request.json().catch(() => null));
  if (!input.success) return fail('Enter valid guard settings or confirm a strategy reset.', 400);
  const { action, environment } = input.data;
  if (action === 'save') {
    const { enabled, minimum_trades, max_slippage_bps, max_net_loss_usd } = input.data;
    const saved = await ctx.db.from('stock_guard_settings').upsert({ user_id: ctx.id, environment, enabled, minimum_trades, max_slippage_bps, max_net_loss_usd });
    return saved.error ? fail('Could not save the strategy guard.', 503) : NextResponse.json({ saved: true });
  }
  if (!isStockTradeRule(input.data.strategy)) return fail('Choose a supported strategy.', 400);
  const reset = await ctx.db.from('stock_guard_state').upsert({
    user_id: ctx.id, environment, strategy: input.data.strategy, halted_at: null, reason: null, reset_at: new Date().toISOString(),
  }, { onConflict: 'user_id,environment,strategy' });
  return reset.error ? fail('Could not reset the strategy pause.', 503) : NextResponse.json({ saved: true });
}
