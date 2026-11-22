import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readHealth } from '@/lib/health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public and read-only, so an outside uptime monitor can watch it. It reports
// only whether the app can reach its database and how long ago each scheduled
// job last succeeded: no account data. Returns 503 when something is down, so
// a plain HTTP check is enough.
export async function GET() {
  const health = await readHealth(createServiceClient());
  const ok = health.database && health.checks.every(c => c.ok);
  return NextResponse.json(
    { ok, database: health.database, migrated: health.migrated, checks: health.checks.map(c => ({ key: c.key, label: c.label, ok: c.ok, ageMinutes: c.ageMinutes, detail: c.detail })) },
    { status: ok || !health.migrated && health.database ? 200 : 503 },
  );
}
