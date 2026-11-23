import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/notify';

export const dynamic = 'force-dynamic';

// Which alert channels are configured (names only, never the credentials), and the recent alert log.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await createServiceClient().from('alerts').select('id, message, delivered, created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(25);
  return NextResponse.json({ channels: await userChannels(user.id), alerts: data ?? [], available: !error });
}

// Sends a test message to every configured channel.
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sent = await notify('Test alert from HL Trader. If you can read this, alerts are working.', 'HL Trader test alert', user.id);
  return NextResponse.json({ sent, ...(sent ? {} : { error: (await userChannels(user.id)).length ? 'The channel rejected the message; check the topic, token, chat id or email address' : 'No phone channel is configured. The test alert was written to the in-app log only.' }) }, { status: sent ? 200 : (await userChannels(user.id)).length ? 502 : 400 });
}

async function userChannels(userId: string): Promise<string[]> {
  const { data } = await createServiceClient().from('settings').select('notification_ntfy_topic, notification_telegram_chat_id, notification_email_to').eq('user_id', userId).single();
  return [data?.notification_ntfy_topic ? 'ntfy' : null, data?.notification_telegram_chat_id && process.env.TELEGRAM_BOT_TOKEN ? 'Telegram' : null, data?.notification_email_to && process.env.RESEND_API_KEY ? 'Email' : null].filter((x): x is string => !!x);
}
