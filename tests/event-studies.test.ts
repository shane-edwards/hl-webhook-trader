import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDb } from './helpers';
import { auctionDeadline, auctionReport, captureAuction } from '../lib/event-studies/auctions';
import { captureSuppliers, supplierReport, supplierWindow, type StockFeed } from '../lib/event-studies/suppliers';
import { captureUnlock, fundingCash, hedgeRatio, unlockEvents, unlockReport, unlockWindow } from '../lib/event-studies/unlocks';
import { DAY } from '../lib/event-studies/journal';

const at = (date: string) => Date.parse(date);
const HOUR = 3_600_000;

function stocks(clock: () => number): StockFeed {
  const names = new Map<string, number>();
  return {
    instrument: async symbol => {
      if (!names.has(symbol)) names.set(symbol, names.size + 1);
      return { symbol, instrumentId: names.get(symbol)!, type: 'stocks', displayName: symbol };
    },
    quotes: async ids => ids.map(instrumentId => ({ instrumentId, bid: 100, ask: 101, date: new Date(clock()).toISOString(), quoteType: 'realtime' })),
    candles: async id => {
      const apple = names.get('AAPL') === id;
      return ['2026-10-30','2026-11-30','2026-12-31'].map((day, i) => ({
        day, bidOpen: 100, askOpen: 101, high: 150, low: 95, bidClose: 100 + i * (apple ? 10 : id/100),
      }));
    },
  };
}

test('supplier prices the strongest and weakest supplier plus sector on consecutive first sessions, including after a holiday', async () => {
  const { db, tables } = memoryDb();
  let time = at('2026-12-01T14:31:00Z');
  const clock = () => time, feed = stocks(clock);
  assert.equal(supplierWindow(time), true);
  assert.equal(supplierWindow(time + DAY), false);
  await captureSuppliers(db, 'u1', feed, time, clock);
  await captureSuppliers(db, 'u1', feed, time, clock);
  assert.equal(tables.forward_test_days.length, 1);
  time = at('2027-01-04T14:31:00Z');
  await captureSuppliers(db, 'u1', feed, time, clock);
  const [result] = (await supplierReport(db,'u1',true)).results;
  assert.match(result.label, /^CRUS vs /);
  assert.ok(result.net! < -0.01 && result.benchmark === result.net && result.control === result.net);
  assert.equal((await supplierReport(db,'u2',false)).results.length, 0);
  feed.quotes = async () => [];
  await assert.rejects(captureSuppliers(db,'u3',feed,time,clock), /current/);
});

test('Treasury uses announced nominal deadlines, records a matched control and rejects missing or late quotes', async () => {
  const day = '2026-12-09';
  const announcement = { securityType:'Note',originalSecurityTerm:'10-Year',securityTerm:'9-Year 11-Month', announcementDate:'2026-12-03',
    competitiveAuctionCloseDate:day, competitiveAuctionCloseTime:'1:00 PM' };
  assert.equal(auctionDeadline([announcement],day),780);
  assert.equal(auctionDeadline([{ ...announcement, inflationIndexedSecurity:'Yes' }],day),null);
  assert.equal(auctionDeadline([{ ...announcement, announcementDate:'2026-12-10' }],day),null);
  assert.throws(() => auctionDeadline([{ ...announcement, competitiveAuctionCloseTime:'' }],day));
  const { db } = memoryDb();
  let time = 0;
  const clock = () => time, feed = stocks(clock);
  for (const date of ['2026-12-02',day]) {
    const calendar = { deadline: date === day ? 780 : null };
    for (const stamp of ['18:05:20','18:10:20','19:05:20']) {
      time = at(date + 'T' + stamp + 'Z');
      await captureAuction(db,'u1',feed,time,calendar,clock);
    }
  }
  const report = await auctionReport(db,'u1',true,time);
  const [result] = report.results;
  assert.ok(result.net! < -0.01 && result.control === result.net);
  assert.equal(report.sensitivity?.value,result.net);
  time = at(day + 'T19:06:00Z');
  await captureAuction(db,'u2',feed,time,{ deadline:780 },clock);
  const [miss] = (await auctionReport(db,'u2',true,time + HOUR)).results;
  assert.equal(miss.net, null);
  assert.equal(miss.note, 'Missing execution quote');
});

test('unlock paper pair freezes both fills, retries funding gaps, and charges both fee legs', async () => {
  const { db, tables } = memoryDb(), event = unlockEvents.find(e => e.symbol === 'ARB')!;
  const { start, end } = unlockWindow(event,'event');
  let time = start + 60_000, complete = false;
  const clock = () => time;
  const feed = {
    getBookSnapshot: async () => ({ time, bids: [{ px:100,sz:100 }], asks: [{ px:101,sz:100 }] }),
    getCandles: async (_symbol: string, interval: string, from: number, to: number) => {
      const step = interval === '1d' ? DAY : HOUR;
      const first = Math.floor(from/step)*step;
      return Array.from({ length: Math.floor((to-first)/step)+1 }, (_,i) => ({
        t: first + i*step, o:100, c:100+Math.sin(i), h:102, l:98, v:100,
      }));
    },
    getFundingRates: async (_symbol: string, from: number, to: number) => {
      if (!complete) return [];
      return Array.from({length: Math.floor(to/HOUR)-Math.floor(from/HOUR)}, (_,i) => ({
        time: (Math.floor(from/HOUR) + i + 1)*HOUR, rate: 0.0001,
      }));
    },
  };
  const circ = async () => 5e9;
  await captureUnlock(db,event,'event',time,feed,clock,circ);
  await captureUnlock(db,event,'event',time,feed,clock,circ);
  assert.equal(tables.forward_test_days.length,1);
  time = end + 60_000;
  await assert.rejects(captureUnlock(db,event,'event',time,feed,clock,circ), /funding history/);
  const exit = tables.forward_test_days.find(r => String(r.strategy).endsWith(':exit'))!.detail;
  complete = true;
  time += HOUR;
  await captureUnlock(db,event,'event',time,feed,clock,circ);
  assert.equal(tables.forward_test_days.length,3);
  assert.deepEqual(tables.forward_test_days.find(r => String(r.strategy).endsWith(':exit'))!.detail, exit);
  const result = (await unlockReport(db,time)).results.find(r => r.label === 'ARB / ETH')!;
  assert.ok(result.net! < -0.01);
  assert.equal(result.control,null);
  assert.equal(hedgeRatio(new Map(),new Map(),start),null);
  assert.throws(() => fundingCash([],new Map(),start,start+HOUR,1), /funding history/);
});

test('an unobserved unlock window cannot create a historical entry', async () => {
  const { db, tables } = memoryDb();
  const event = unlockEvents[0], { start } = unlockWindow(event,'event');
  await captureUnlock(db,event,'event',start+HOUR,{} as never);
  assert.equal(tables.forward_test_days?.length ?? 0, 0);
});
