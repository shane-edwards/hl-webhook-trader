import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { cronAuthorized } from '@/lib/cron-auth';
import { heartbeat } from '@/lib/health';
import { processResearchStep, queueScheduledResearch } from '@/lib/automation/queue';
import { queueMarketSearches } from '@/lib/automation/pair-research';
import { stockMarketClock } from '@/lib/stocks/session';
import { notify } from '@/lib/notify';
import { updateCryptoShadow } from '@/lib/automation/crypto-shadow';
import { watchFundingHedges } from '@/lib/hedge-research/watch';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function checkShadow(db: ReturnType<typeof createServiceClient>, time: number) {
  const clock = stockMarketClock(time);
  if (!clock.tradingDay || clock.minutes < 605 || clock.minutes > 620) return;
  const result = await db.from('stock_catalyst_settings').select('user_id, environment').eq('enabled', true);
  if (result.error) throw new Error('Could not read shadow capture settings.');
  for (const account of result.data ?? []) {
    const match = await db.from('stock_catalyst_sessions').select('completed_at').match({ ...account, session_day: clock.day }).maybeSingle();
    if (match.error) continue;
    if (match.data?.completed_at) continue;
    const notice = await db.from('automation_runs').insert({ user_id: account.user_id, market: 'stocks', kind: 'daily',
      source: 'schedule', schedule_key: `shadow:${clock.day}`, as_of: new Date(time).toISOString(), status: 'failed',
      completed_at: new Date(time).toISOString(), detail: 'The opening shadow capture missed its time window.' }).select('id').maybeSingle();
    if (notice.data) await notify('WARNING: The Stocks opening shadow capture missed its time window. See Automation Center.', undefined, account.user_id);
  }
}

export async function GET(request: Request) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const db = createServiceClient();
  try {
    const now = Date.now();
    const [scheduled] = await Promise.all([queueScheduledResearch(db, now), checkShadow(db, now)]);
    const minute = new Date(now).getUTCMinutes();
    const [result, hedge, searches] = await Promise.all([
      minute >= 10 && minute <= 12 ? updateCryptoShadow(db, now).then(() => 'shadow recorded') : processResearchStep(db),
      minute % 5 === 4 ? watchFundingHedges(db, now) : null,
      minute % 5 === 3 ? queueMarketSearches(db, now).catch(error => {
        console.error('[automation] strategy search queue', error);
        return null;
      }) : 0,
    ]);
    const watch = hedge?.failures ? ' · funding hedge needs attention' : hedge?.captured ? ` · ${hedge.captured} hedge observations` : '';
    const research = searches === null ? ' · strategy search needs attention' : searches ? ` · ${searches} strategy tests queued` : '';
    await heartbeat(db, 'automation', searches !== null, `${scheduled} queued · ${result}${research}${watch}`);
    return NextResponse.json({ scheduled, result, hedge, searches });
  } catch {
    await heartbeat(db, 'automation', false, 'The research worker could not finish.');
    return NextResponse.json({ error: 'The research worker could not finish.' }, { status: 503 });
  }
}
