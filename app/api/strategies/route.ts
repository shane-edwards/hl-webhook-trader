import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { AUTOMATION_MARKETS } from '@/lib/automation/model';
import { initializeMarketResearch } from '@/lib/automation/pair-research';
import { readStrategies } from '@/lib/automation/read-strategies';

async function handle(initialize: boolean) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = createServiceClient();
    if (initialize) await Promise.all(AUTOMATION_MARKETS.map(m => initializeMarketResearch(db, user.id, m)));
    return NextResponse.json(await readStrategies(db, user.id));
  } catch { return NextResponse.json({ error: 'Could not load strategies.' }, { status: 503 }); }
}

export const GET = () => handle(false);
export const POST = () => handle(true);
