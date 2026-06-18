'use client';

import { useState, useEffect, useCallback } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import type { Settings } from '@/types';
import {
  Save, RefreshCw, Webhook, Zap, Shield, Eye, EyeOff, Copy, Check, RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import { generateWebhookSecret } from '@/lib/utils';

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // Form state
  const [leverage, setLeverage] = useState('5');
  const [orderSize, setOrderSize] = useState('100');
  const [maxPosition, setMaxPosition] = useState('1000');
  const [riskPercent, setRiskPercent] = useState('2');
  const [slippage, setSlippage] = useState('2');
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [hlWalletAddress, setHlWalletAddress] = useState('');
  const [hlPrivateKey, setHlPrivateKey] = useState('');
  const [isTestnet, setIsTestnet] = useState(true);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      if (data.settings) {
        const s = data.settings as Settings & { has_private_key: boolean };
        setSettings(s);
        setLeverage(s.default_leverage.toString());
        setOrderSize(s.default_order_size_usd.toString());
        setMaxPosition(s.max_position_size_usd.toString());
        setRiskPercent(s.risk_per_trade_percent.toString());
        setSlippage(s.slippage_percent.toString());
        setWebhookEnabled(s.webhook_enabled);
        setWebhookSecret(s.webhook_secret);
        setHlWalletAddress(s.hl_wallet_address ?? '');
        setIsTestnet(s.is_testnet);
      }
    } catch {
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        default_leverage: parseFloat(leverage),
        default_order_size_usd: parseFloat(orderSize),
        max_position_size_usd: parseFloat(maxPosition),
        risk_per_trade_percent: parseFloat(riskPercent),
        slippage_percent: parseFloat(slippage),
        webhook_enabled: webhookEnabled,
        webhook_secret: webhookSecret,
        hl_wallet_address: hlWalletAddress,
        is_testnet: isTestnet,
      };
      if (hlPrivateKey.trim()) {
        body.hl_private_key = hlPrivateKey.trim();
      }

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to save settings');
        return;
      }
      setSettings(data.settings);
      setHlPrivateKey(''); // Clear after save
      toast.success('Settings saved successfully');
    } catch {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function regenerateSecret() {
    setWebhookSecret(generateWebhookSecret());
    toast.success('New webhook secret generated — remember to save!');
  }

  async function copySecret() {
    await navigator.clipboard.writeText(webhookSecret);
    setCopied(true);
    toast.success('Secret copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  }

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const webhookUrl = `${appUrl}/api/webhook`;
  const hasPrivateKey = (settings as (Settings & { has_private_key?: boolean }) | null)?.has_private_key;

  if (loading) {
    return (
      <div className="flex flex-col min-h-full">
        <Header />
        <div className="p-6 flex items-center justify-center flex-1">
          <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-full">
      <Header />

      <div className="p-4 lg:p-6 space-y-5 flex-1 max-w-3xl">
        {/* Trading Parameters */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Trading Parameters</CardTitle>
            </div>
            <CardDescription>
              Default values used when a webhook signal doesn&apos;t specify its own parameters
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Default Leverage (1–50×)</Label>
                <Input
                  type="number"
                  min="1"
                  max="50"
                  value={leverage}
                  onChange={e => setLeverage(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Applied on each new position</p>
              </div>
              <div className="space-y-1.5">
                <Label>Default Order Size (USD)</Label>
                <Input
                  type="number"
                  min="10"
                  value={orderSize}
                  onChange={e => setOrderSize(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Notional USD per trade</p>
              </div>
              <div className="space-y-1.5">
                <Label>Max Position Size (USD)</Label>
                <Input
                  type="number"
                  min="10"
                  value={maxPosition}
                  onChange={e => setMaxPosition(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Risk per Trade (%)</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={riskPercent}
                  onChange={e => setRiskPercent(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">For reference / position sizing</p>
              </div>
              <div className="space-y-1.5">
                <Label>Slippage Tolerance (%)</Label>
                <Input
                  type="number"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={slippage}
                  onChange={e => setSlippage(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Price buffer for IOC orders</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Webhook Configuration */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Webhook className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Webhook Configuration</CardTitle>
            </div>
            <CardDescription>
              Configure your TradingView webhook URL and authentication secret
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Enable Webhook Trading</p>
                <p className="text-xs text-muted-foreground">Accept incoming signals from TradingView</p>
              </div>
              <Switch checked={webhookEnabled} onCheckedChange={setWebhookEnabled} />
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label>Webhook URL</Label>
              <div className="flex items-center gap-2 bg-secondary rounded-lg px-3 py-2.5 border border-border">
                <code className="text-xs text-muted-foreground flex-1 font-mono break-all">{webhookUrl}</code>
              </div>
              <p className="text-xs text-muted-foreground">
                Paste this URL into your TradingView alert &quot;Webhook URL&quot; field
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Webhook Secret</Label>
              <div className="flex items-center gap-2">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={webhookSecret}
                  onChange={e => setWebhookSecret(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={copySecret}>
                  {copied ? <Check className="w-4 h-4 text-profit" /> : <Copy className="w-4 h-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={regenerateSecret}>
                  <RotateCcw className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Include as <code className="bg-secondary px-1 rounded">secret</code> in your TradingView alert JSON body
              </p>
            </div>

            <div className="bg-secondary rounded-lg p-3 border border-border">
              <p className="text-xs font-semibold text-foreground mb-2">TradingView Alert Message Format</p>
              <pre className="text-xs text-muted-foreground overflow-x-auto">
{`{
  "secret": "${webhookSecret || 'YOUR_SECRET'}",
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": {{close}},
  "comment": "{{strategy.order.comment}}"
}`}
              </pre>
            </div>
          </CardContent>
        </Card>

        {/* Hyperliquid Credentials */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Hyperliquid Credentials</CardTitle>
            </div>
            <CardDescription>
              Your wallet credentials are encrypted at rest using AES-256-GCM
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Use Testnet</p>
                <p className="text-xs text-muted-foreground">Trade on Hyperliquid testnet (recommended for setup)</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={isTestnet ? 'warning' : 'profit'}>
                  {isTestnet ? 'TESTNET' : 'MAINNET'}
                </Badge>
                <Switch checked={isTestnet} onCheckedChange={setIsTestnet} />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label>Wallet Address (0x...)</Label>
              <Input
                type="text"
                placeholder="0x..."
                value={hlWalletAddress}
                onChange={e => setHlWalletAddress(e.target.value)}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                Private Key (0x...)
                {hasPrivateKey && (
                  <Badge variant="profit" className="ml-2 text-[10px]">Saved</Badge>
                )}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  type={showKey ? 'text' : 'password'}
                  placeholder={hasPrivateKey ? '••••••••••••••••••••••••••••••••' : '0x...'}
                  value={hlPrivateKey}
                  onChange={e => setHlPrivateKey(e.target.value)}
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" onClick={() => setShowKey(!showKey)}>
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Leave blank to keep the existing key. The key is encrypted before storage.
                Alternatively, set <code className="bg-secondary px-1 rounded">HL_PRIVATE_KEY</code> in Vercel env vars.
              </p>
            </div>

            {!isTestnet && (
              <div className="bg-loss/10 border border-loss/20 rounded-lg p-3">
                <p className="text-xs text-loss font-medium">
                  ⚠️ MAINNET MODE — Real funds will be used. Ensure your strategy is tested thoroughly on testnet first.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Save button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving} className="min-w-32">
            {saving ? (
              <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Saving...</>
            ) : (
              <><Save className="w-4 h-4 mr-2" />Save Settings</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
