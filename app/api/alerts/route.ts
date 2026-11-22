import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { notificationChannels, notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// Which alert channels are configured (names only, never the credentials), and the recent alert log.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await createServiceClient().from('alerts').select('id, message, delivered, created_at').order('created_at', { ascending: false }).limit(25);
  return NextResponse.json({ channels: notificationChannels(), alerts: data ?? [], available: !error });
}

// Sends a test message to every configured channel.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sent = await notify('Test alert from HL Trader. If you can read this, alerts are working.', 'HL Trader test alert');
  return NextResponse.json({ sent, ...(sent ? {} : { error: notificationChannels().length ? 'The channel rejected the message; check the topic, token, chat id or email address' : 'No phone channel is configured. The test alert was written to the in-app log only.' }) }, { status: sent ? 200 : notificationChannels().length ? 502 : 400 });
}
