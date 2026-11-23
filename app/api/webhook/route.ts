import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { parseWebhookPayload, redactPayload } from '@/lib/webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Acknowledge after durable acceptance. Execution belongs to the scheduled worker.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = parseWebhookPayload(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.signal.secret.length < 16) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const signalId = body.signal_id;
  if (typeof signalId !== 'string' || !signalId.trim() || signalId.length > 200) {
    return NextResponse.json({ error: 'Provide a unique signal_id for this alert. Reuse it when retrying delivery.' }, { status: 400 });
  }
  const db = createServiceClient();
  const { data: settings, error } = await db.from('settings').select('user_id, webhook_enabled, trading_halted').eq('webhook_secret', parsed.signal.secret).maybeSingle();
  if (error) return NextResponse.json({ error: 'Webhook storage unavailable' }, { status: 503 });
  if (!settings) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!settings.webhook_enabled || settings.trading_halted) return NextResponse.json({ error: 'Webhook trading is disabled or halted' }, { status: 403 });
  const queued = await db.from('webhook_jobs').insert({ user_id: settings.user_id, signal_id: signalId, payload: redactPayload(body) }).select('id').single();
  if (queued.error?.code === '23505') {
    const existing = await db.from('webhook_jobs').select('id, status').eq('user_id', settings.user_id).eq('signal_id', signalId).single();
    if (existing.error) return NextResponse.json({ error: 'Could not confirm existing signal' }, { status: 503 });
    return NextResponse.json({ accepted: true, duplicate: true, jobId: existing.data.id, status: existing.data.status });
  }
  if (queued.error) return NextResponse.json({ error: 'Could not queue signal' }, { status: 503 });
  return NextResponse.json({ accepted: true, jobId: queued.data.id }, { status: 202 });
}
