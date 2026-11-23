import type { createServiceClient } from '@/lib/supabase/server';
import { CATALYST_VERSION, replayCatalyst, type CatalystObservation } from './catalyst';
import { catalystWindow, scanCatalysts } from './catalyst-data';
import { etoroFromConnection } from './connection';
import { stockMarketClock } from './session';

type Db = ReturnType<typeof createServiceClient>;
type Mode = CatalystObservation['environment'];
const MINUTE = 60_000;

async function marketConnection(db: Db, userId: string, mode: Mode) {
  const result = await db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', userId).eq('environment', mode).maybeSingle();
  if (result.error) throw new Error('Could not read the market-data connection');
  return result.data ? etoroFromConnection(result.data) : null;
}

export async function captureOpeningShadow(db: Db, userId: string, mode: Mode, now = Date.now()) {
  if (!catalystWindow(now)) return 'The opening scan runs from 9:47 to 9:56 a.m. ET.';
  const key = { user_id: userId, environment: mode, session_day: stockMarketClock(now).day };
  const broker = await marketConnection(db, userId, mode);
  if (!broker) return 'Connect eToro in this mode for market data.';
  const seeded = await db.from('stock_catalyst_sessions').upsert(key, { onConflict: 'user_id,environment,session_day', ignoreDuplicates: true });
  if (seeded.error) throw new Error('Could not initialize the opening capture');
  const lease = new Date(Date.now() + 70_000).toISOString();
  const { data, error } = await db.from('stock_catalyst_sessions').update({ lease_until: lease }).match(key)
    .is('completed_at', null).or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`).select('session_day').maybeSingle();
  if (error) throw new Error('Could not reserve the opening capture');
  if (!data) return 'Today’s capture has already finished or is running.';
  try {
    const { rows, ...summary } = await scanCatalysts(broker, mode, now);
    if (summary.unavailable.length === summary.scanned) throw new Error('Filing coverage is unavailable');
    if (rows.length) {
      const saved = await db.from('stock_shadow_observations').upsert(rows.map(row => ({ ...row, user_id: userId, version: CATALYST_VERSION })),
        { onConflict: 'user_id,environment,session_day,version,for_symbol,lane', ignoreDuplicates: true });
      if (saved.error) throw new Error('Could not save the shadow observations');
    }
    const finished = await db.from('stock_catalyst_sessions').update({ completed_at: new Date().toISOString(), lease_until: null,
      summary: { ...summary, rows: rows.length } }).match(key).eq('lease_until', lease);
    if (finished.error) throw new Error('Could not finalize the opening capture');
    return `${summary.events.length} filing candidates · ${rows.length} observations recorded.`;
  } finally {
    await db.from('stock_catalyst_sessions').update({ lease_until: null }).match(key).eq('lease_until', lease);
  }
}

export async function settleOpeningShadow(db: Db, userId: string, mode: Mode, now = Date.now()) {
  const result = await db.from('stock_shadow_observations').select('id, instrument_id, quote, decision, eligible_at, settle_after')
    .eq('user_id', userId).eq('environment', mode).is('outcomes', null).lte('settle_after', new Date(now).toISOString())
    .order('settle_after').limit(24);
  if (result.error) throw new Error('Could not read pending shadow observations');
  const rows = result.data as CatalystObservation[];
  if (!rows.length) return { settled: 0, pending: 0 };
  const broker = await marketConnection(db, userId, mode);
  const shared = new Map<string, ReturnType<NonNullable<typeof broker>['intradayCandles']>>();
  const results = await Promise.allSettled(rows.map(async row => {
    const entry = Date.parse(row.eligible_at);
    const end = Date.parse(row.settle_after);
    const expired = now - end > 3 * 86_400_000;
    const key = `${row.instrument_id}:${entry}`;
    let work = shared.get(key);
    if (!work && broker && row.quote && row.decision.stop != null) {
      work = broker.intradayCandles(row.instrument_id, entry, end, undefined, '5m', false, 9000);
      shared.set(key, work);
    }
    const bars = work ? await work.catch(error => { if (!expired) throw error; return []; }) : [];
    if (!broker && !expired && row.quote && row.decision.stop != null) return false;
    const outcomes = replayCatalyst(row, bars);
    if (row.quote && row.decision.stop != null && !expired && now - end < 2 * 60 * MINUTE &&
        outcomes.some(outcome => outcome.state === 'missing')) return false;
    const saved = await db.from('stock_shadow_observations').update({ outcomes }).eq('id', row.id!)
      .eq('user_id', userId).eq('environment', mode).is('outcomes', null).select('id').maybeSingle();
    if (saved.error) throw saved.error;
    return !!saved.data;
  }));
  const settled = results.filter(result => result.status === 'fulfilled' && result.value).length;
  return { settled, pending: rows.length - settled };
}
