import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { catalystComparison, CATALYST_VERSION, type CatalystObservation } from '@/lib/stocks/catalyst';
import { catalystWindow } from '@/lib/stocks/catalyst-data';
import { captureOpeningShadow, settleOpeningShadow } from '@/lib/stocks/shadow-book';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const mode = z.enum(['demo', 'real']);
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capture'), environment: mode }),
  z.object({ action: z.literal('settle'), environment: mode }),
  z.object({ action: z.literal('schedule'), environment: mode, enabled: z.boolean() }),
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
  const env = mode.safeParse(new URL(request.url).searchParams.get('environment') ?? 'real');
  if (!env.success) return fail('Choose an eToro account.', 400);
  const [settings, data, latest, connections] = await Promise.all([
    ctx.db.from('stock_catalyst_settings').select('environment, enabled, last_checked_at').eq('user_id', ctx.id).maybeSingle(),
    ctx.db.from('stock_shadow_observations').select('id, session_day, environment, symbol, for_symbol, sector, instrument_id, lane, filing, observed_at, eligible_at, settle_after, quote, decision, outcomes')
      .eq('user_id', ctx.id).eq('environment', env.data).eq('version', CATALYST_VERSION).order('session_day', { ascending: false }).limit(500),
    ctx.db.from('stock_catalyst_sessions').select('session_day, completed_at, summary').eq('user_id', ctx.id).eq('environment', env.data)
      .not('completed_at', 'is', null).order('session_day', { ascending: false }).limit(1).maybeSingle(),
    ctx.db.from('etoro_connections').select('environment').eq('user_id', ctx.id),
  ]);
  if (settings.error || data.error || latest.error || connections.error) return fail('Could not load the shadow book.', 503);
  const rows = data.data as CatalystObservation[];
  return NextResponse.json({ settings: settings.data, rows: rows.slice(0, 60), comparisons: catalystComparison(rows), latest: latest.data,
    connections: connections.data.map(row => row.environment), open: catalystWindow(Date.now()) });
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const input = command.safeParse(await request.json().catch(() => null));
  if (!input.success) return fail('Choose a shadow book action.', 400);
  const { environment, action } = input.data;
  try {
    if (action === 'schedule') {
      if (input.data.enabled) {
        const bank = await ctx.db.from('etoro_connections').select('environment').eq('user_id', ctx.id).eq('environment', environment).maybeSingle();
        if (bank.error || !bank.data) return fail('Connect this eToro account first.', 409);
      }
      const saved = await ctx.db.from('stock_catalyst_settings').upsert({ user_id: ctx.id, environment, enabled: input.data.enabled });
      return saved.error ? fail('Could not save the shadow capture setting.', 503) : NextResponse.json({ message: input.data.enabled ? 'Daily shadow capture enabled.' : 'Daily shadow capture paused.' });
    }
    if (action === 'capture') return NextResponse.json({ message: await captureOpeningShadow(ctx.db, ctx.id, environment) });
    const updates = await settleOpeningShadow(ctx.db, ctx.id, environment);
    return NextResponse.json({ message: `${updates.settled} outcomes updated · ${updates.pending} still awaiting quotes.` });
  } catch { return fail('Could not finish this shadow book check. Try again shortly.', 503); }
}
