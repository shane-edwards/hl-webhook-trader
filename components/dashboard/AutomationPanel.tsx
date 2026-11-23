'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Webhook, TrendingUp, OctagonX, Copy, Check, Loader2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import type { Settings, StrategyRun } from '@/types';
import { formatRelativeTime } from '@/lib/utils';

interface Props {
  settings: Settings | null;
  loading: boolean;
  webhookUrl: string;
  onToggleWebhook: (enabled: boolean) => Promise<void>;
  /** Called after the kill switch ran, so the page can reload its data. */
  onFlattened: () => void;
}

export function AutomationPanel({ settings, loading, webhookUrl, onToggleWebhook, onFlattened }: Props) {
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [flattening, setFlattening] = useState(false);
  const [lastRun, setLastRun] = useState<StrategyRun | null>(null);

  const strategyAvailable = settings?.strategy_enabled !== undefined;
  const strategyOn = settings?.strategy_enabled === true;
  const strategyLive = strategyOn && settings?.strategy_dry_run === false;

  useEffect(() => {
    if (!strategyAvailable) return;
    fetch('/api/strategy')
      .then(r => (r.ok ? r.json() : null))
      .then(d => setLastRun(d?.runs?.[0] ?? null))
      .catch(() => {});
  }, [strategyAvailable]);

  async function toggle(v: boolean) {
    setToggling(true);
    try { await onToggleWebhook(v); } finally { setToggling(false); }
  }

  async function copyUrl() {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    toast.success('Webhook URL copied');
    setTimeout(() => setCopied(false), 2000);
  }

  async function flatten() {
    setFlattening(true);
    try {
      const res = await fetch('/api/risk/flatten', { method: 'POST' });
      const data = await res.json();
      if (res.status === 200) {
        toast.success(`Automation paused. ${data.results.length} position${data.results.length === 1 ? '' : 's'} closed.`);
      } else if (res.status === 207) {
        const open = data.results.filter((r: { closed: boolean }) => !r.closed).map((r: { symbol: string }) => r.symbol).join(', ');
        toast.error(`Automation paused, but these are STILL OPEN: ${open}. Close them on Hyperliquid.`, { duration: 20000 });
      } else {
        toast.error(`Kill switch failed: ${data.error ?? 'unknown error'}. Check Hyperliquid directly.`, { duration: 20000 });
      }
      onFlattened();
    } catch {
      toast.error('Kill switch request failed. Check Hyperliquid directly.', { duration: 20000 });
    } finally {
      setFlattening(false);
      setConfirmOpen(false);
    }
  }

  return (
    <section className="surface h-full flex flex-col" aria-label="Automation">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-sm font-semibold">Trading controls</h2>
      </div>

      {loading || !settings ? (
        <div className="px-5 pb-5 space-y-3">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          <details>
          <summary className="mx-5 py-2 text-xs cursor-pointer text-muted-foreground">TradingView and daily strategy</summary>
          <div className="px-5 py-3 border-t border-border/70">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${settings.webhook_enabled ? 'bg-profit/10 text-profit' : 'bg-secondary text-muted-foreground'}`}>
                  <Webhook className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">TradingView webhook</p>
                  <p className="text-xs text-muted-foreground truncate">{settings.webhook_enabled ? 'Accepting signals' : 'Paused — signals are rejected'}</p>
                </div>
              </div>
              <Switch checked={settings.webhook_enabled} onCheckedChange={toggle} disabled={toggling} aria-label="Webhook trading" />
            </div>
            <div className="mt-3 flex items-center gap-2 bg-secondary/70 rounded-lg pl-3 pr-1 h-8 border border-border/70">
              <code className="text-[11px] text-muted-foreground truncate flex-1 font-mono">{webhookUrl}</code>
              <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={copyUrl} aria-label="Copy webhook URL">
                {copied ? <Check className="w-3 h-3 text-profit" /> : <Copy className="w-3 h-3" />}
              </Button>
            </div>
          </div>

          <Link href="/settings" className="group px-5 py-3 border-t border-border/70 flex items-center justify-between gap-3 hover:bg-accent/40 transition-colors">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 ${strategyLive ? 'bg-profit/10 text-profit' : strategyOn ? 'bg-warning/10 text-warning' : 'bg-secondary text-muted-foreground'}`}>
                <TrendingUp className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">BTC trend strategy</p>
                  <Badge variant={strategyLive ? 'profit' : strategyOn ? 'warning' : 'secondary'} className="text-[10px] py-0">
                    {!strategyAvailable ? 'NOT SET UP' : strategyLive ? 'LIVE' : strategyOn ? 'DRY RUN' : 'OFF'}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {lastRun
                    ? `Last run ${formatRelativeTime(lastRun.created_at)} · target ${Number(lastRun.target_exposure ?? 0).toFixed(2)}x`
                    : strategyOn ? 'Runs daily after the 00:00 UTC close' : 'Daily, no TradingView needed'}
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground shrink-0" />
          </Link>
          </details>

          <div className="mt-auto px-5 py-4 border-t border-border/70">
            <Button variant="loss" className="w-full" onClick={() => setConfirmOpen(true)}>
              <OctagonX className="w-4 h-4" />
              Emergency stop
            </Button>
            <p className="text-[11px] text-muted-foreground mt-2 text-center">Pauses all automation and closes every position</p>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={o => !flattening && setConfirmOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close everything and stop trading?</DialogTitle>
            <DialogDescription>
              This pauses Autopilot, the webhook and the built-in strategy, then closes every open position on Hyperliquid at
              market{settings?.is_testnet ? ' (testnet)' : ''}. Closing cannot be undone; automation can be turned back on afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={flattening}>Cancel</Button>
            <Button variant="destructive" onClick={flatten} disabled={flattening}>
              {flattening ? <Loader2 className="w-4 h-4 animate-spin" /> : <OctagonX className="w-4 h-4" />}
              Close all positions
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
