import { stockMarketClock, stockSessionMinute } from '@/lib/stocks/session';
import { DAY, isoDay, observation, observations, record, type Database, type StudyCard } from './journal';
import { stockQuotes, priceReturn, type Quote, type StockFeed } from './suppliers';

type Announcement = { securityType?: string; originalSecurityTerm?: string; securityTerm?: string;
  competitiveAuctionCloseDate?: string; competitiveAuctionCloseTime?: string; announcementDate?: string; inflationIndexedSecurity?: string };
type Calendar = { deadline: number | null };
type Entry = { minute: number; auction: boolean; quote: Quote };
type Outcome = { entry: Entry; exit: Quote; net: number; delayed?: number | null };
const calendarKey = 'ten-year-auction-calendar-v1';
const key = (user: string, phase: string, minute: number) => 'ten-year-v1:' + user + ':' + phase + ':' + minute;

export function auctionDeadline(rows: Announcement[], day: string) {
  const row = rows.find(r => r.securityType === 'Note' && /^10-Year$/i.test(r.originalSecurityTerm || r.securityTerm || '')
    && r.inflationIndexedSecurity !== 'Yes' && r.competitiveAuctionCloseDate?.slice(0, 10) === day
    && r.announcementDate && r.announcementDate.slice(0, 10) <= day);
  if (!row) return null;
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(row.competitiveAuctionCloseTime?.trim() ?? '');
  if (!match || +match[1] < 1 || +match[1] > 12 || +match[2] >= 60) throw new Error('Treasury deadline unavailable');
  return (+match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + +match[2];
}

export async function auctionCalendar(db: Database, day: string, time: number): Promise<Calendar> {
  const cached = await observation<Calendar>(db, calendarKey, day);
  if (cached) return cached.detail;
  const response = await fetch('https://www.treasurydirect.gov/TA_WS/securities/announced?format=json',
    { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Treasury announcements unavailable');
  const rows: Announcement[] = await response.json();
  if (!Array.isArray(rows) || !rows.some(r => r.competitiveAuctionCloseDate && r.competitiveAuctionCloseTime)) throw new Error('Incomplete Treasury calendar');
  const detail = { deadline: auctionDeadline(rows, day) };
  await record(db, calendarKey, day, time, detail);
  return detail;
}

export async function captureAuction(db: Database, user: string, feed: StockFeed, time: number, calendar: Calendar, now = Date.now) {
  const clock = stockMarketClock(time);
  if (!clock.open) return;
  // Observe the usual clock time on all sessions so the prior week's comparison is already on record.
  const minutes = new Set([785, ...(calendar.deadline == null ? [] : [calendar.deadline + 5])]);
  for (const minute of minutes) {
    const elapsed = clock.minutes - minute;
    const delayed = elapsed >= 5 && elapsed <= 7;
    if (!(elapsed >= 0 && elapsed <= 2 || delayed || elapsed >= 60 && elapsed <= 63)) continue;
    const entering = elapsed < 5;
    const entryKey = key(user, 'entry', minute);
    const isAuction = calendar.deadline != null && calendar.deadline + 5 === minute;
    if (delayed && !isAuction) continue;
    const outcomeKey = isAuction ? key(user, 'auction', 0) : key(user, 'control', minute);
    if (isAuction && !await observation(db, key(user, 'scheduled', 0), clock.day)) {
      await record(db, key(user, 'scheduled', 0), clock.day, time, { minute });
    }
    const lateKey = key(user,'delayed',minute);
    if (await observation(db, entering ? entryKey : delayed ? lateKey : outcomeKey, clock.day)) continue;
    const prior = entering ? null : await observation<Entry>(db, entryKey, clock.day);
    if (!entering && !prior) continue;
    const due = prior ? Date.parse(prior.detail.quote.time) + (delayed ? 300_000 : 3_600_000) : stockSessionMinute(clock.day, minute);
    if (now() < due) continue;
    const { IEF: quote } = await stockQuotes(feed, ['IEF'], now);
    const stamp = Date.parse(quote.time);
    if (stamp < due || stamp > due + 120_000) continue;
    if (entering) {
      await record(db, entryKey, clock.day, now(), { minute, auction: calendar.deadline != null, quote } satisfies Entry);
    } else if (delayed) {
      await record(db, lateKey, clock.day, now(), quote);
    } else if (prior) {
      const later = isAuction ? await observation<Quote>(db,lateKey,clock.day) : null;
      await record(db, outcomeKey, clock.day, now(), { entry: prior.detail, exit: quote, net: priceReturn(prior.detail.quote, quote),
        delayed: later ? priceReturn(later.detail,quote) : null } satisfies Outcome);
    }
  }
}

export async function auctionReport(db: Database, user: string, connected: boolean, now = Date.now()): Promise<StudyCard> {
  const auctions = await observations<{ minute: number }>(db, key(user, 'scheduled', 0), 24);
  const archive = new Map<string,Outcome>();
  if (auctions.length) {
    const series = [key(user,'auction',0), ...new Set(auctions.map(row => key(user,'control',row.detail.minute)))];
    const dates = auctions.flatMap(row => [row.day, isoDay(Date.parse(row.day) - 7 * DAY)]);
    const { data, error } = await db.from('forward_test_days').select('strategy,day,detail').in('strategy',series).in('day',dates);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) archive.set(row.strategy + '/' + row.day,row.detail);
  }
  const results = auctions.map(row => {
    const prior = isoDay(Date.parse(row.day) - 7 * DAY);
    const outcome = archive.get(key(user,'auction',0) + '/' + row.day);
    const control = archive.get(key(user,'control',row.detail.minute) + '/' + prior);
    const due = stockSessionMinute(row.day, row.detail.minute + 64);
    const note = outcome ? undefined : now < due ? 'Observation in progress' : 'Missing execution quote';
    return { date: row.day, label: 'IEF', net: outcome?.net ?? null, delayed: outcome?.delayed ?? null,
      control: control && !control.entry.auction ? control.net : null, note };
  });
  const delayed = results.flatMap(row => row.delayed != null ? [row.delayed] : []);
  return { id: 'auction', name: 'Treasury auction rebound', status: connected ? 'Watching 10-year auctions' : 'Demo market data needed',
    rule: 'Buy IEF five minutes after the published bidding deadline. Sell one hour later. Both fills use broker quotes and a modeled 0.05% fee per side.',
    comparison: 'Same hour one week earlier', results, needsConnection: !connected,
    sensitivity: delayed.length ? { label: 'Later entry', value: delayed.reduce((sum,r) => sum+r,0) / delayed.length,
      detail: 'Average return with entry five minutes later · ' + delayed.length + ' auctions' } : undefined };
}
