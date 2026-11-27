import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readFundingGaps } from '@/lib/funding-scan/scan';

export const dynamic = 'force-dynamic';

const WINDOWS = [1, 7, 30];

export async function GET(request: Request) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const asked = Number(new URL(request.url).searchParams.get('days'));
  const days = WINDOWS.includes(asked) ? asked : 7;
  try {
    return NextResponse.json({ days, ...await readFundingGaps(createServiceClient(), days) });
  } catch (error) {
    console.error('[funding-gaps]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not read the funding scans.' }, { status: 503 });
  }
}
