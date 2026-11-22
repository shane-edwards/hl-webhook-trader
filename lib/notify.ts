// Optional alerts. Two channels, each a no-op until configured:
//   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   Email:    RESEND_API_KEY + ALERT_EMAIL_TO (+ ALERT_EMAIL_FROM, default onboarding@resend.dev)
// A failed alert never breaks a trade.

export function notificationsEnabled(): boolean {
  return telegramEnabled() || emailEnabled();
}
const telegramEnabled = () => !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID;
const emailEnabled = () => !!process.env.RESEND_API_KEY && !!process.env.ALERT_EMAIL_TO;

export function notificationChannels(): string[] {
  return [telegramEnabled() ? 'Telegram' : null, emailEnabled() ? 'Email' : null].filter((x): x is string => !!x);
}

async function telegram(message: string): Promise<boolean> {
  if (!telegramEnabled()) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function email(subject: string, message: string): Promise<boolean> {
  if (!emailEnabled()) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.ALERT_EMAIL_FROM || 'HL Trader <onboarding@resend.dev>',
        to: [process.env.ALERT_EMAIL_TO], subject: subject.slice(0, 150), text: message.slice(0, 20_000),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends to every configured channel. True if at least one accepted it. */
export async function notify(message: string, subject?: string): Promise<boolean> {
  const results = await Promise.all([telegram(message), email(subject ?? `HL Trader: ${message.split('\n')[0]}`, message)]);
  return results.some(Boolean);
}
