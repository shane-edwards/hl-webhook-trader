import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readPaperTrades } from '@/lib/automation/paper-trades';

export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, {status:401});
  try {
    return NextResponse.json(await readPaperTrades(createServiceClient(),user.id),{headers:{'Cache-Control':'private, no-store'}});
  } catch {
    return NextResponse.json({ error:'Paper trades could not be loaded.' },{status:503});
  }
}
