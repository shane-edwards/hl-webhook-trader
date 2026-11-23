'use client';

import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { Settings } from '@/types';

interface Props { settings: Settings; onSaved: (s: Settings) => void }

/** Account-wide limits that apply to every entry (manual, webhook, Autopilot), and the alert settings. */
export function PortfolioLimitsCard({ settings, onSaved }: Props) {
  // The columns arrive with migration 006; before that the built-in defaults apply and cannot be changed.
  const available = settings.max_gross_exposure_x !== undefined;
  const [exposure, setExposure] = useState('3');
  const [dailyLoss, setDailyLoss] = useState('5');
  const [summary, setSummary] = useState(true);
  const [topic, setTopic] = useState(settings.notification_ntfy_topic ?? '');
  const [chatId, setChatId] = useState(settings.notification_telegram_chat_id ?? '');
  const [email, setEmail] = useState(settings.notification_email_to ?? '');
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<string[] | null>(null);

  useEffect(() => {
    setExposure(String(settings.max_gross_exposure_x ?? 3));
    setDailyLoss(String(settings.portfolio_daily_loss_limit_pct ?? 5));
    setSummary(settings.daily_summary_enabled !== false);
    setTopic(settings.notification_ntfy_topic ?? '');
    setChatId(settings.notification_telegram_chat_id ?? '');
    setEmail(settings.notification_email_to ?? '');
  }, [settings]);
  useEffect(() => { fetch('/api/alerts').then(r => (r.ok ? r.json() : null)).then(d => setChannels(d?.channels ?? [])).catch(() => setChannels([])); }, [settings.notification_ntfy_topic, settings.notification_telegram_chat_id, settings.notification_email_to]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ max_gross_exposure_x: parseFloat(exposure), portfolio_daily_loss_limit_pct: parseFloat(dailyLoss), daily_summary_enabled: summary, notification_ntfy_topic: topic, notification_telegram_chat_id: chatId, notification_email_to: email }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Could not save'); return; }
      onSaved(data.settings); toast.success('Limits saved');
    } catch { toast.error('Could not save'); } finally { setSaving(false); }
  }

  async function testAlert() {
    const res = await fetch('/api/alerts', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.sent) toast.success('Test alert sent'); else toast.error(data.error ?? 'No alert channel accepted the message');
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" />
          <CardTitle className="text-base">Account limits and alerts</CardTitle>
        </div>
        <CardDescription>
          Checked before every new position, whatever opens it: the trade ticket, a webhook signal, a limit order or the Autopilot.
          Closing a position is never blocked.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!available && <p className="text-xs text-warning">Run database migration 006 to change these. Until then the defaults below apply.</p>}
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-sm">{settings.trading_halted ? 'Trading is halted.' : 'Account recovery'}</p>
          <Button variant="outline" onClick={async () => {
            const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resume_trading: true }) });
            const result = await response.json();
            if (!response.ok) { toast.error(result.error); return; }
            onSaved(result.settings); toast.success('Trading resumed. Enable your chosen automation separately.');
          }}>Resume trading after account check</Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="pl-exposure">Max total exposure (× account value)</Label>
            <Input id="pl-exposure" type="number" inputMode="decimal" min="0.1" max="50" step="0.5" value={exposure} onChange={e => setExposure(e.target.value)} disabled={!available} />
            <p className="text-xs text-muted-foreground">All positions added together, long and short. BTC, ETH and SOL tend to fall together, so they are counted as one risk rather than three.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pl-loss">Daily loss limit (%)</Label>
            <Input id="pl-loss" type="number" inputMode="decimal" min="0.5" max="90" step="0.5" value={dailyLoss} onChange={e => setDailyLoss(e.target.value)} disabled={!available} />
            <p className="text-xs text-muted-foreground">Once the account is down this much since 00:00 UTC, no new positions open until the next day. The limit uses the exchange baseline around UTC midnight. Open positions keep their stops.</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">Daily summary</p>
            <p className="text-xs text-muted-foreground">Once a day after 00:00 UTC: account value, the day&apos;s change, open positions and what the Autopilot did.</p>
          </div>
          <Switch checked={summary} onCheckedChange={setSummary} disabled={!available} aria-label="Daily summary" />
        </div>

        <div className="rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground space-y-1.5">
          <p>
            <span className="font-medium text-foreground">Alert channels: </span>
            {channels === null ? 'checking…' : channels.length ? channels.join(' and ') : 'none configured, so no alert or summary can be delivered yet.'}
          </p>
          <div className="space-y-2 pt-2">
            <Label htmlFor="alert-topic">ntfy topic</Label>
            <Input id="alert-topic" value={topic} onChange={e => setTopic(e.target.value)} placeholder="A random topic of at least 16 characters" />
            <Label htmlFor="alert-chat">Telegram chat ID</Label>
            <Input id="alert-chat" value={chatId} onChange={e => setChatId(e.target.value)} />
            <Label htmlFor="alert-email">Alert email</Label>
            <Input id="alert-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            <p>Subscribe to your topic in ntfy. Telegram and email delivery require the deployment&apos;s bot token or email service key. Save destinations before testing.</p>
          </div>
          {channels !== null && <button type="button" className="text-primary hover:underline" onClick={testAlert}>Send a test alert</button>}
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || !available} className="min-w-32">{saving && <Loader2 className="w-4 h-4 animate-spin" />}Save limits</Button>
        </div>
      </CardContent>
    </Card>
  );
}
