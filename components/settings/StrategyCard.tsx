'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, RefreshCw, Save, Play } from 'lucide-react';
import { toast } from 'sonner';
import type { Settings, StrategyRun, StrategyRunStatus } from '@/types';
import { formatRelativeTime } from '@/lib/utils';

const STATUS_BADGE: Record<StrategyRunStatus, { label: string; variant: 'profit' | 'loss' | 'warning' | 'secondary' }> = {
  traded: { label: 'Traded', variant: 'profit' },
  held: { label: 'Held', variant: 'secondary' },
  dry_run: { label: 'Dry run', variant: 'warning' },
  error: { label: 'Error', variant: 'loss' },
};

interface PreviewResult {
  status: StrategyRunStatus;
  signalDate: string | null;
  trendScore: number | null;
  realizedVol: number | null;
  targetExposure: number | null;
  currentExposure: number | null;
  equityUsd: number | null;
  message: string;
}

const x = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toFixed(2)}x`);

export function StrategyCard({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  // The strategy columns only exist after migration 002.
  const available = settings.strategy_enabled !== undefined;

  const [enabled, setEnabled] = useState(settings.strategy_enabled ?? false);
  const [dryRun, setDryRun] = useState(settings.strategy_dry_run ?? true);
  const [targetVol, setTargetVol] = useState(String(Math.round(Number(settings.strategy_target_vol ?? 0.4) * 100)));
  const [maxLeverage, setMaxLeverage] = useState(String(settings.strategy_max_leverage ?? 2));
  const [capital, setCapital] = useState(settings.strategy_capital_usd == null ? '' : String(settings.strategy_capital_usd));
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [runs, setRuns] = useState<StrategyRun[]>([]);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/strategy');
      const data = await res.json();
      if (res.ok) setRuns(data.runs ?? []);
    } catch {
      // The run history is informational; the card still works without it.
    }
  }, []);

  useEffect(() => { if (available) fetchRuns(); }, [available, fetchRuns]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          strategy_enabled: enabled,
          strategy_dry_run: dryRun,
          strategy_target_vol: parseFloat(targetVol) / 100,
          strategy_max_leverage: parseFloat(maxLeverage),
          strategy_capital_usd: capital.trim() === '' ? null : parseFloat(capital),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to save strategy settings');
        return;
      }
      onSaved(data.settings);
      toast.success('Strategy settings saved');
    } catch {
      toast.error('Failed to save strategy settings');
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    try {
      const res = await fetch('/api/strategy', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Preview failed');
        return;
      }
      setPreview(data.result);
    } catch {
      toast.error('Preview failed');
    } finally {
      setPreviewing(false);
    }
  }

  const live = enabled && !dryRun;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          <CardTitle className="text-base">Built-in BTC Trend Strategy</CardTitle>
          {available && (
            <Badge variant={live ? 'profit' : enabled ? 'warning' : 'secondary'} className="ml-auto">
              {live ? 'LIVE' : enabled ? 'DRY RUN' : 'OFF'}
            </Badge>
          )}
        </div>
        <CardDescription>
          Runs once a day without TradingView. Long BTC when it is above its 50/100/150/200-day averages, sized to a
          volatility target, flat when the trend is down. Backtest and caveats: <code>backtest/RESULTS.md</code>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!available ? (
          <p className="text-sm text-muted-foreground">
            Run <code className="bg-secondary px-1 rounded">supabase/migrations/002_strategy_and_hardening.sql</code> in
            the Supabase SQL editor to enable this.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Enable daily strategy</p>
                <p className="text-xs text-muted-foreground">Evaluated shortly after the 00:00 UTC daily close</p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Dry run</p>
                <p className="text-xs text-muted-foreground">Log what it would do without sending orders</p>
              </div>
              <Switch checked={dryRun} onCheckedChange={setDryRun} />
            </div>

            <Separator />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <Label>Target volatility (%)</Label>
                <Input type="number" min="5" max="150" step="5" value={targetVol} onChange={e => setTargetVol(e.target.value)} />
                <p className="text-xs text-muted-foreground">Higher = bigger positions and bigger drawdowns</p>
              </div>
              <div className="space-y-1.5">
                <Label>Max leverage (×)</Label>
                <Input type="number" min="0.1" max="5" step="0.1" value={maxLeverage} onChange={e => setMaxLeverage(e.target.value)} />
                <p className="text-xs text-muted-foreground">Hard cap on position ÷ capital</p>
              </div>
              <div className="space-y-1.5">
                <Label>Capital (USD)</Label>
                <Input type="number" min="10" placeholder="Whole account" value={capital} onChange={e => setCapital(e.target.value)} />
                <p className="text-xs text-muted-foreground">Blank = size against the whole account</p>
              </div>
            </div>

            {live && (
              <div className="bg-loss/10 border border-loss/20 rounded-lg p-3">
                <p className="text-xs text-loss font-medium">
                  Live mode: orders will be sent {settings.is_testnet ? 'on testnet' : 'with real funds on mainnet'}. The
                  strategy has losing years and a ~40% historical drawdown at the default settings. Profit is not guaranteed.
                </p>
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={runPreview} disabled={previewing}>
                {previewing ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                Preview today&apos;s decision
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                Save strategy
              </Button>
            </div>

            {preview && (
              <div className="bg-secondary rounded-lg p-3 border border-border text-xs space-y-1">
                <p className="font-semibold text-foreground">Preview (saved settings, no order sent)</p>
                <p className="text-muted-foreground">
                  Signal date {preview.signalDate ?? '—'} · trend score {preview.trendScore?.toFixed(2) ?? '—'} · volatility{' '}
                  {preview.realizedVol == null ? '—' : `${(preview.realizedVol * 100).toFixed(0)}%`} · target{' '}
                  {x(preview.targetExposure)} · current {x(preview.currentExposure)}
                </p>
                <p className={preview.status === 'error' ? 'text-loss' : 'text-foreground'}>{preview.message}</p>
              </div>
            )}

            {runs.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-foreground">Recent runs</p>
                <div className="space-y-1.5">
                  {runs.map(run => (
                    <div key={run.id} className="flex items-start gap-2 text-xs">
                      <Badge variant={STATUS_BADGE[run.status].variant} className="shrink-0">{STATUS_BADGE[run.status].label}</Badge>
                      <span className="text-muted-foreground flex-1 min-w-0 break-words">
                        target {x(run.target_exposure)} · {run.message}
                      </span>
                      <span className="text-muted-foreground shrink-0">{formatRelativeTime(run.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
