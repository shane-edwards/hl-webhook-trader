import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { readHlpVault } from '@/lib/income/hlp';

export const dynamic = 'force-dynamic';

// What a deposit in Hyperliquid's HLP vault has earned, from the vault's public history. Read-only.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    return NextResponse.json(await readHlpVault());
  } catch (error) {
    console.error('[income]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load the vault history.' }, { status: 503 });
  }
}
