// Alerts. Every alert is written to the in-app log (table `alerts`, migration
// 007) and sent to each phone channel that is configured:
//   ntfy:     NTFY_TOPIC (+ NTFY_SERVER, default https://ntfy.sh). No account or bot: install
//             the ntfy app and subscribe to the topic. The topic name is the only secret, so
//             make it long and random.
//   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   Email:    RESEND_API_KEY + ALERT_EMAIL_TO (+ ALERT_EMAIL_FROM, default onboarding@resend.dev)
// A failed alert never breaks a trade.

const ntfyEnabled = () => !!process.env.NTFY_TOPIC;
const telegramEnabled = () => !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;
const emailEnabled = () => !!process.env.RESEND_API_KEY && !!process.env.ALERT_EMAIL_TO;

export function notificationChannels(): string[] {
  return [ntfyEnabled() ? 'ntfy' : null, telegramEnabled() ? 'Telegram' : null, emailEnabled() ? 'Email' : null].filter((x): x is string => !!x);
}
export function notificationsEnabled(): boolean {
  return notificationChannels().length > 0;
}

async function post(url: string, init: RequestInit): Promise<boolean> {
  try {
    return (await fetch(url, { ...init, method: 'POST', signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

/** Errors and anything that left a position at risk ring through; routine messages arrive quietly. */
const urgent = (message: string) => /ERROR|FAILED|HEALTH|WARNING|NOT placed|CLOSED AT ONCE|STILL OPEN|by hand/.test(message);

function ntfy(title: string, message: string): Promise<boolean> {
  if (!ntfyEnabled()) return Promise.resolve(false);
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
  return post(`${server}/${encodeURIComponent(process.env.NTFY_TOPIC!)}`, {
    // Header values must be plain ASCII.
    headers: { Title: title.replace(/[^\x20-\x7E]/g, '').slice(0, 120), Priority: urgent(message) ? 'high' : 'default', Tags: urgent(message) ? 'warning' : 'chart_with_upwards_trend' },
    body: message.slice(0, 3500),
  });
}

function telegram(message: string): Promise<boolean> {
  if (!telegramEnabled()) return Promise.resolve(false);
  return post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message.slice(0, 3500), disable_web_page_preview: true }),
  });
}

function email(subject: string, message: string): Promise<boolean> {
  if (!emailEnabled()) return Promise.resolve(false);
  return post('https://api.resend.com/emails', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM || 'HL Trader <onboarding@resend.dev>',
      to: [process.env.ALERT_EMAIL_TO], subject: subject.slice(0, 150), text: message.slice(0, 20_000),
    }),
  });
}

/** Keeps the alert in the app's own log, so it can be read there even when no phone channel is set up. */
async function record(message: string, delivered: string[]): Promise<void> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  try {
    const { createServiceClient } = await import('@/lib/supabase/server');
    await createServiceClient().from('alerts').insert({ message: message.slice(0, 4000), delivered });
  } catch {
    // The log is a convenience; never let it break the caller.
  }
}

/** Sends to every configured channel and logs the alert. True if at least one phone channel accepted it. */
export async function notify(message: string, subject?: string): Promise<boolean> {
  const title = subject ?? `HL Trader: ${message.split('\n')[0]}`;
  const [n, t, e] = await Promise.all([ntfy(title, message), telegram(message), email(title, message)]);
  const delivered = [n ? 'ntfy' : null, t ? 'Telegram' : null, e ? 'Email' : null].filter((x): x is string => !!x);
  await record(message, delivered);
  return delivered.length > 0;
}
