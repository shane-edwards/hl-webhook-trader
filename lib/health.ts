// Heartbeats for the scheduled jobs, so a silent failure (a paused database, a
// stopped scheduler) is noticed. Each job records that it ran; each job also
// checks the others and alerts when one has gone quiet.
import type { SupabaseClient } from '@supabase/supabase-js';
import { notify } from '@/lib/notify';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** A job that has not reported for this long is treated as down. Both scans run every five minutes. */
export const STALE_MINUTES = 20;
const ALERT_EVERY_MS = 60 * 60_000;

export const CHECKS = {
  scan: 'Trading scan (Autopilot, stops, limit orders, reconcile)',
  market: 'Market scan (trade ideas, scorecard)',
} as const;
export type CheckKey = keyof typeof CHECKS;

export async function heartbeat(db: Db, key: CheckKey, ok: boolean, detail: string | null, now = Date.now()): Promise<void> {
  const stamp = new Date(now).toISOString();
  await db.from('system_health').upsert({ key, ok, detail: detail?.slice(0, 500) ?? null, checked_at: stamp, ...(ok ? { last_ok_at: stamp, alerted_at: null } : {}) })
    .then(() => {}, () => {});
}

export interface HealthCheck { key: string; label: string; ok: boolean; ageMinutes: number | null; detail: string | null }

export function evaluateHealth(rows: Array<{ key: string; ok: boolean; detail: string | null; last_ok_at: string | null }>, now: number): HealthCheck[] {
  return (Object.keys(CHECKS) as CheckKey[]).map(key => {
    const row = rows.find(r => r.key === key);
    const age = row?.last_ok_at ? (now - new Date(row.last_ok_at).getTime()) / 60_000 : null;
    return {
      key, label: CHECKS[key], ageMinutes: age == null ? null : Math.round(age),
      ok: age != null && age <= STALE_MINUTES,
      detail: age == null ? 'Has never reported' : age > STALE_MINUTES ? `Last succeeded ${Math.round(age)} minutes ago${row && !row.ok && row.detail ? `: ${row.detail}` : ''}` : null,
    };
  });
}

/** Reads the heartbeats. `database` is false when the health table itself cannot be read. */
export async function readHealth(db: Db, now = Date.now()): Promise<{ database: boolean; migrated: boolean; checks: HealthCheck[] }> {
  try {
    const { data, error } = await db.from('system_health').select('key, ok, detail, last_ok_at');
    if (error) {
      // "relation does not exist" means migration 006 has not been run; anything else means the database is unwell.
      const missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message);
      return { database: missing, migrated: false, checks: [] };
    }
    return { database: true, migrated: true, checks: evaluateHealth(data ?? [], now) };
  } catch {
    return { database: false, migrated: false, checks: [] };
  }
}

/** Alerts about every other job that has gone quiet, at most once an hour each. Called by each job about its peers. */
export async function alertOnStalePeers(db: Db, self: CheckKey | null, now = Date.now()): Promise<HealthCheck[]> {
  const health = await readHealth(db, now);
  if (!health.database) { await notify('HEALTH: the database is not responding. Login, webhooks and the Autopilot are down until it is back (check that the Supabase project is not paused).'); return []; }
  const stale = health.checks.filter(c => c.key !== self && !c.ok && c.ageMinutes != null);
  for (const c of stale) {
    const { data } = await db.from('system_health').select('alerted_at').eq('key', c.key).maybeSingle();
    if (data?.alerted_at && now - new Date(data.alerted_at).getTime() < ALERT_EVERY_MS) continue;
    await notify(`HEALTH: ${c.label} has not succeeded for ${c.ageMinutes} minutes. ${c.detail ?? ''}`.trim());
    await db.from('system_health').update({ alerted_at: new Date(now).toISOString() }).eq('key', c.key);
  }
  return stale;
}
