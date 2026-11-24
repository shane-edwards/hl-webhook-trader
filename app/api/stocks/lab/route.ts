import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { EtoroError } from '@/lib/stocks/etoro';
import { LAB_SYMBOLS, LAB_VERSION, type StockLabReport } from '@/lib/stocks/intraday-lab';
import { loadLabMarket } from '@/lib/stocks/intraday-lab-data';
import { stockMarketClock } from '@/lib/stocks/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
const costs = z.object({ slipBps: z.number().min(0).max(100), fee: z.number().min(0).max(30) });
const input = costs.extend({ symbol: z.enum(LAB_SYMBOLS), asOf: z.iso.date() });
const narrowReport = z.object({ version: z.literal(LAB_VERSION), to: z.iso.date(), from: z.iso.date(), options: costs,
  reports: z.array(z.object({ label: z.string().max(90), status: z.enum(['Paper candidate', 'Did not pass', 'Insufficient sample']) })).length(2),
  markets: z.array(z.enum(LAB_SYMBOLS)).max(LAB_SYMBOLS.length) });

async function context() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return user ? { id: user.id, db: createServiceClient() } : null;
}

export async function GET(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const q = new URL(request.url).searchParams;
  const today = stockMarketClock(Date.now()).day;
  if (!q.has('symbol')) {
    const history = await ctx.db.from('stock_research_runs').select('created_at, report').eq('user_id', ctx.id)
      .eq('kind', 'intraday').order('created_at', { ascending: false }).limit(12);
    return history.error ? fail('Could not load the trial history.', 503) : NextResponse.json({ asOf: today, history: history.data });
  }
  const parsed = input.safeParse({ symbol: q.get('symbol'), asOf: q.get('asOf'), slipBps: Number(q.get('slipBps') ?? 3), fee: Number(q.get('fee') ?? 1) });
  if (!parsed.success || parsed.data.asOf > today || parsed.data.asOf < '2025-06-01') return fail('Choose a supported market and date.', 400);
  const { symbol, asOf, ...options } = parsed.data;
  const connection = await ctx.db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', ctx.id)
    .order('environment', { ascending: false }).limit(1).maybeSingle();
  if (connection.error || !connection.data) return fail('Connect eToro to run the study.', 409);
  const broker = etoroFromConnection(connection.data);
  try {
    const result = await loadLabMarket(broker, symbol, asOf, options);
    return result ? NextResponse.json(result) : fail('eToro could not resolve this US ticker.', 404);
  } catch (error) {
    return error instanceof EtoroError && error.status === 429 ? fail('Waiting for the eToro data quota.', 429)
      : fail('Could not load paired five-minute bars.', 503);
  }
}

export async function POST(request: Request) {
  const ctx = await context();
  if (!ctx) return fail('Unauthorized', 401);
  const text = await request.text();
  if (text.length > 45_000) return fail('The trial report is too large.', 413);
  const report = await Promise.resolve(text).then(value => JSON.parse(value) as StockLabReport).catch(() => null);
  if (!narrowReport.safeParse(report).success) return fail('Run a valid lab trial first.', 400);
  const { error } = await ctx.db.from('stock_research_runs').insert({ user_id: ctx.id, kind: 'intraday', report });
  return error ? fail('Could not save this trial.', 503) : NextResponse.json({ saved: true });
}
