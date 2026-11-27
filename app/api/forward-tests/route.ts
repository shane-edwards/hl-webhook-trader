import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readForwardTest } from '@/lib/forward-tests/run';

export const dynamic = 'force-dynamic';

// The crowded break forward test: hypothetical trades logged day by day on new dates. Read-only.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await readForwardTest(createServiceClient()));
  } catch (error) {
    console.error('[forward-tests]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load the forward test.' }, { status: 503 });
  }
}
