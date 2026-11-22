import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { notificationChannels, notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// Which alert channels are configured (names only, never the credentials).
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ channels: notificationChannels() });
}

// Sends a test message to every configured channel.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!notificationChannels().length) return NextResponse.json({ sent: false, error: 'No alert channel is configured' }, { status: 400 });
  const sent = await notify('Test alert from HL Trader. If you can read this, alerts are working.', 'HL Trader test alert');
  return NextResponse.json({ sent, ...(sent ? {} : { error: 'The channel rejected the message; check the token and chat id or email address' }) }, { status: sent ? 200 : 502 });
}
