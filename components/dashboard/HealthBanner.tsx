'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Health { ok: boolean; database: boolean; migrated: boolean; checks: Array<{ key: string; label: string; ok: boolean; detail: string | null }> }

/** Shown only when something is wrong: the database is unreachable or a scheduled scan has gone quiet. */
export function HealthBanner() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    const load = () => fetch('/api/health').then(r => r.json()).then(setHealth).catch(() => {});
    load();
    const id = setInterval(load, 2 * 60_000);
    return () => clearInterval(id);
  }, []);

  if (!health || health.ok) return null;
  const problems = !health.database ? ['The database is not responding. Check that the Supabase project is not paused.']
    : !health.migrated ? ['Database migration 006 has not been run, so limit orders, managed exits, the market scan and health checks are off.']
    : health.checks.filter(c => !c.ok).map(c => `${c.label}: ${c.detail ?? 'not running'}`);
  if (!problems.length) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
      <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
      <div className="space-y-0.5">
        <p className="font-medium">Something needs attention</p>
        {problems.map(p => <p key={p} className="text-xs text-muted-foreground">{p}</p>)}
        {health.database && health.migrated && health.checks.some(c => c.key === 'scan' && !c.ok) && (
          <p className="text-xs text-muted-foreground">Stops and targets already on the exchange keep working. Trailing stops, limit-order follow-up and the Autopilot do not until the scan is back.</p>
        )}
      </div>
    </div>
  );
}
