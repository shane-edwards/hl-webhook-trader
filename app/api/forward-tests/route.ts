import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { readForwardTest } from '@/lib/forward-tests/run';
import { readFundingBasket } from '@/lib/forward-tests/basket-run';

export const dynamic = 'force-dynamic';

// Forward tests: what a frozen rule would have done on new dates. Read-only. `?test=funding_basket` for the basket.
export async function GET(request: Request) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = createServiceClient();
    const basket = new URL(request.url).searchParams.get('test') === 'funding_basket';
    return NextResponse.json(basket ? await readFundingBasket(db) : await readForwardTest(db));
  } catch (error) {
    console.error('[forward-tests]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load the forward test.' }, { status: 503 });
  }
}
