'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Bot, Pause, Play } from 'lucide-react';
import { stockHref } from '@/components/layout/workspaces';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { AutomationMarket, AutomationProfile } from '@/lib/automation/model';

type LiveSetup = { version: string; name: string; symbol: string };

export function FullAutopilot({ market, profile, demo, real, live, refresh }: {
  market: AutomationMarket; profile?: AutomationProfile; demo: boolean; real: boolean; live: LiveSetup[]; refresh: () => Promise<void>;
}) {
  const [review, setReview] = useState<'paper' | 'live' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [versions, setVersions] = useState<string[]>([]);
  const [budget, setBudget] = useState('25');
  const [maximum, setMaximum] = useState('500');
  const active = profile?.scan_for_opportunities === true;
  const activeMode = active && profile.mode === 'live' ? 'Live' : 'Paper';

  async function change(action: 'scan-paper' | 'scan-live' | 'entries', paused?: boolean) {
    setPending(true); setError('');
    try {
      const response = await fetch('/api/automation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, action, paused, ...(action === 'scan-live' ?
          { versions, budget: Number(budget), maxOrder: Number(maximum), confirmed: true } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not update Autopilot.');
      setReview(null);
      await refresh();
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not update Autopilot.'); }
    finally { setPending(false); }
  }

  function confirm(event: FormEvent) {
    event.preventDefault();
    if (review) void change(review === 'live' ? 'scan-live' : 'scan-paper');
  }

  return <section id="autopilot" className="surface p-4 space-y-3">
    <div className="flex flex-wrap justify-between gap-3 items-center">
      <div>
        <h2 className="flex items-center gap-2 font-semibold"><Bot size={17} />Full Autopilot</h2>
        <p className="mt-1 text-xs text-muted-foreground">{active ? profile.entries_paused ? `${activeMode} entries paused` : `Scanning in ${activeMode}` : 'Paused'}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
      {active ? <Button size="sm" variant="outline" disabled={pending} onClick={() => void change('entries', !profile.entries_paused)}>
        {profile.entries_paused ? <Play size={15} /> : <Pause size={15} />}{profile.entries_paused ? `Resume ${activeMode}` : 'Pause entries'}
      </Button> : market === 'stocks' && !demo
        ? <Button size="sm" asChild variant="outline"><Link href={stockHref('account', { mode: 'demo' })}>Connect eToro Demo</Link></Button>
        : profile?.mode === 'live' && !profile.entries_paused
          ? <Button size="sm" variant="outline" asChild><Link href="/automation">Manage Live automation</Link></Button>
          : <Button size="sm" variant="outline" onClick={() => setReview('paper')}>Start Paper scanning</Button>}
      {!!live.length && (real ? <Button size="sm" variant="outline" onClick={() => {
        setVersions((profile?.live_scan_versions?.length ? profile.live_scan_versions : live.map(item => item.version)).slice(0, 8));
        setReview('live');
      }}>{activeMode === 'Live' ? 'Review approved setups' : 'Review Live Autopilot'}</Button>
        : <Button size="sm" variant="outline" asChild><Link href={market === 'stocks' ? stockHref('account', { mode: 'real' }) : '/settings'}>Connect Live account</Link></Button>)}
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-loss">{error}</p>}
    <Dialog open={!!review} onOpenChange={open => { if (!open && !pending) setReview(null); }}>
      <DialogContent><form onSubmit={confirm} className="space-y-4">
        <DialogHeader><DialogTitle>{review === 'live' ? 'Approve Full Live Autopilot' : 'Start Full Autopilot in Paper'}</DialogTitle>
          <DialogDescription>{review === 'live' ? 'Tideframe can submit real orders for the versions you approve.' :
            market === 'stocks' ? 'Stocks · eToro Demo' : 'Crypto · simulated funds'}</DialogDescription>
        </DialogHeader>
        {review === 'live' && <div className="space-y-2">
          <div className="max-h-48 overflow-auto space-y-1">{live.map(item => <label key={item.version} className="flex gap-2 items-center text-sm">
            <input type="checkbox" checked={versions.includes(item.version)} onChange={event => setVersions(current =>
              event.target.checked ? current.length < 8 ? [...current, item.version] : current : current.filter(version => version !== item.version))} />
            {item.symbol} · {item.name}
          </label>)}</div>
          <label className="block text-sm">Loss budget per trade (USD)<Input value={budget} onChange={e => setBudget(e.target.value)} type="number" min="1" max="10000" step=".01" required /></label>
          <label className="block text-sm">Maximum order size (USD)<Input value={maximum} onChange={e => setMaximum(e.target.value)} type="number" min="10" max="10000" step=".01" required /></label>
        </div>}
        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={() => setReview(null)} disabled={pending}>Cancel</Button>
          <Button type="submit" disabled={pending || review === 'live' && !versions.length}>{review === 'live' ? 'Confirm Live Autopilot' : 'Confirm Paper Autopilot'}</Button></DialogFooter>
      </form></DialogContent>
    </Dialog>
  </section>;
}
