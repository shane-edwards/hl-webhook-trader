import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { stockMarketClock } from '@/lib/stocks/session';
import { auctionCalendar, auctionReport, captureAuction } from './auctions';
import { DAY, isoDay, observation, record, type Database } from './journal';
import { captureSuppliers, supplierReport, supplierWindow } from './suppliers';
import { captureUnlock, unlockEvents, unlockReport, unlockWindow } from './unlocks';

async function runUnlocks(db: Database, time: number) {
  const minute = new Date(time).getUTCMinutes();
  for (const event of unlockEvents) for (const arm of ['control', 'event'] as const) {
    const { start, end } = unlockWindow(event, arm);
    const entering = time >= start && time < start + 900_000;
    const exiting = time >= end && time < end + 900_000;
    const settling = minute === 20 && time >= end && time <= end + 21 * DAY;
    if (entering || exiting || settling) {
      await captureUnlock(db, event, arm, time, marketDataClient()).catch(error => console.error('[unlock paper]', event.symbol, arm, error));
    }
  }
}

async function runStocks(db: Database, time: number) {
  const clock = stockMarketClock(time);
  if (!clock.open) return;
  const suppliers = supplierWindow(time);
  // Cache the published calendar early enough to capture even an unusual deadline.
  const calendar = await auctionCalendar(db, clock.day, time).catch(error => {
    console.error('[auction calendar]', error);
    return null;
  });
  const auction = calendar && [785, (calendar.deadline ?? 780) + 5].some(minute => {
    const delta = clock.minutes - minute;
    return delta >= 0 && delta <= 2 || calendar.deadline != null && delta >= 5 && delta <= 7 || delta >= 60 && delta <= 63;
  });
  if (!suppliers && !auction) return;
  for (let offset = 0; ; offset += 25) {
    const { data, error } = await db.from('etoro_connections').select('user_id,environment,credentials_encrypted')
      .eq('environment', 'demo').order('user_id').range(offset, offset + 24);
    if (error) throw new Error(error.message);
    await Promise.all((data ?? []).map(async link => {
      const attempt = async (name: string, fn: () => Promise<void>) => {
        try { await fn(); }
        catch (error) {
          console.error('[stock paper]', name, error instanceof Error ? error.message : 'Market data unavailable');
          await record(db, name + '-problem:' + link.user_id, clock.day, time, { problem: true });
        }
      };
      await Promise.all([
        suppliers && attempt('supplier', () => captureSuppliers(db, link.user_id, etoroFromConnection(link), time)),
        auction && attempt('auction', () => captureAuction(db, link.user_id, etoroFromConnection(link), time, calendar!)),
      ]);
    }));
    if ((data ?? []).length < 25) return;
  }
}

export async function runEventStudies(db: Database, time: number) {
  await Promise.all([runStocks(db, time), runUnlocks(db, time)]);
}

export async function eventStudyReport(db: Database, user: string, time = Date.now()) {
  const link = await db.from('etoro_connections').select('environment').eq('user_id', user).eq('environment','demo').maybeSingle();
  if (link.error) throw new Error(link.error.message);
  const connected = !!link.data;
  const [supplier, auction, unlock] = await Promise.all([supplierReport(db,user,connected), auctionReport(db,user,connected), unlockReport(db,time)]);
  const day = stockMarketClock(time).day;
  for (const card of [supplier,auction]) {
    if (!connected) continue;
    const issue = await observation(db, card.id + '-problem:' + user, day);
    if (issue && !card.results.some(row => row.date === day) && !card.status.endsWith(day)) card.status = 'Quote unavailable at the last check';
  }
  return { studies: [supplier,unlock,auction], asOf: isoDay(time) };
}
