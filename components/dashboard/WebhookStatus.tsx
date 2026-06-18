'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Webhook, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

interface WebhookStatusProps {
  enabled: boolean;
  webhookUrl: string;
  onToggle: (enabled: boolean) => Promise<void>;
}

export function WebhookStatus({ enabled, webhookUrl, onToggle }: WebhookStatusProps) {
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleToggle(v: boolean) {
    setToggling(true);
    try {
      await onToggle(v);
    } finally {
      setToggling(false);
    }
  }

  async function copyUrl() {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    toast.success('Webhook URL copied');
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${enabled ? 'bg-profit/10' : 'bg-secondary'}`}>
              <Webhook className={`w-4 h-4 ${enabled ? 'text-profit' : 'text-muted-foreground'}`} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Webhook Trading</span>
                <Badge variant={enabled ? 'profit' : 'secondary'} className="text-[10px]">
                  {enabled ? 'ACTIVE' : 'PAUSED'}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {enabled ? 'Receiving TradingView signals' : 'Not accepting new signals'}
              </p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={handleToggle} disabled={toggling} />
        </div>

        <div className="mt-3 flex items-center gap-2 bg-secondary rounded-lg px-3 py-2">
          <code className="text-xs text-muted-foreground truncate flex-1 font-mono">{webhookUrl}</code>
          <Button variant="ghost" size="icon" className="h-6 w-6 flex-shrink-0" onClick={copyUrl}>
            {copied ? <Check className="w-3 h-3 text-profit" /> : <Copy className="w-3 h-3" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
