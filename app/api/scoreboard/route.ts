import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readScoreboard } from '@/lib/automation/scoreboard-read';

export const dynamic = 'force-dynamic';

// Every forward test's closed results on one footing, ranked, against HLP over the same dates. Read-only.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await readScoreboard(createServiceClient(), user.id));
  } catch (error) {
    console.error('[scoreboard]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load the scoreboard.' }, { status: 503 });
  }
}
