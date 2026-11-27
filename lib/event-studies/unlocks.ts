import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { averageFill, type Snapshot } from '@/lib/hedge-research/model';
import { DAY, observation, record, type Database, type StudyCard } from './journal';

const HOUR = 3_600_000;
const FEE = 0.00045;
const CAPITAL = 1000;
const ARCHIVED = Date.parse('2026-11-27T00:00:00Z');
// Each date is a UTC calendar anchor. The protocols do not promise a midnight transfer.
const tokens = [
  { symbol: 'ARB', id: 'arbitrum', day: 16, amount: (2_694_000_000 + 1_753_000_000) / 48,
    source: 'https://docs.arbitrum.foundation/token-supply' },
  { symbol: 'STRK', id: 'starknet', day: 15, amount: 127_000_000,
    source: 'https://docs.starknet.io/learn/protocol/strk' },
];
export const unlockEvents = ['2026-12','2027-01','2027-02','2027-03'].flatMap(month => tokens.map(token => ({
  ...token, date: month + '-' + token.day, at: Date.parse(month + '-' + token.day + 'T00:00:00Z'),
})));
type Event = typeof unlockEvents[number];
type Arm = 'event' | 'control';
type Entry = { beta: number; supply: number; at: number; tokenUnits: number; ethUnits: number; short: number; long: number };
type Exit = { at: number; cover: number; sell: number };
type Observation = { entry: Entry; exit: Exit; net: number; funding: number; fees: number };
type Feed = Pick<ReturnType<typeof marketDataClient>, 'getCandles' | 'getBookSnapshot' | 'getFundingRates'>;
const series = (symbol: string, arm: Arm, phase: string) => ['unlock-v1', symbol, arm, phase].join(':');

export function hedgeRatio(asset: Map<number, number>, eth: Map<number, number>, today: number) {
  const pairs = [];
  for (let d = today - 60 * DAY; d < today; d += DAY) {
    const a = asset.get(d), b = asset.get(d - DAY), c = eth.get(d), e = eth.get(d - DAY);
    if (!a || !b || !c || !e || ![a,b,c,e].every(v => Number.isFinite(v) && v > 0)) return null;
    pairs.push([Math.log(a/b), Math.log(c/e)]);
  }
  const mx = pairs.reduce((s,p) => s + p[1], 0) / pairs.length;
  const my = pairs.reduce((s,p) => s + p[0], 0) / pairs.length;
  const variance = pairs.reduce((s,p) => s + (p[1]-mx)**2, 0);
  const beta = pairs.reduce((s,p) => s + (p[1]-mx)*(p[0]-my), 0) / variance;
  return Number.isFinite(beta) && beta > 0 ? beta : null;
}

async function supply(id: string) {
  const response = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=' + id,
    { cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Circulating supply unavailable');
  const [row] = await response.json();
  if (row?.id !== id || !Number.isFinite(row.circulating_supply) || row.circulating_supply <= 0 ||
    !(Math.abs(Date.now() - Date.parse(row.last_updated)) <= HOUR)) throw new Error('Current circulating supply unavailable');
  return Number(row.circulating_supply);
}
function mid(book: Snapshot, time: number) {
  const bid = book.bids[0]?.px, ask = book.asks[0]?.px;
  if (!book.time || time - book.time > 12_000 || book.time > time + 1000 || !(bid > 0 && ask >= bid)) throw new Error('Waiting for a current order book');
  return (bid + ask) / 2;
}
async function books(feed: Feed, event: Event, now: () => number) {
  const [token, eth] = await Promise.all([feed.getBookSnapshot(event.symbol), feed.getBookSnapshot('ETH')]);
  const time = now(), tokenMid = mid(token, time), ethMid = mid(eth, time);
  if (Math.abs(token.time! - eth.time!) > 4000) throw new Error('Waiting for simultaneous quotes');
  return { token, eth, time, tokenMid, ethMid };
}
type Rate = { time: number; rate: number };
export function fundingCash(rates: Rate[], prices: Map<number, number>, start: number, end: number, units: number) {
  const hourly = new Map(rates.map(row => [Math.round(row.time/HOUR)*HOUR, row.rate]));
  let total = 0;
  for (let t = Math.floor(start/HOUR)*HOUR + HOUR; t <= end; t += HOUR) {
    const rate = hourly.get(t), price = prices.get(t);
    if (rate == null || !Number.isFinite(rate) || price == null || !Number.isFinite(price) || price <= 0) throw new Error('Waiting for hourly funding history');
    total += rate * price * units;
  }
  return total;
}
async function funding(feed: Feed, symbol: string, entry: Entry, exit: Exit, units: number) {
  const [rates, bars] = await Promise.all([feed.getFundingRates(symbol, entry.at, exit.at),
    feed.getCandles(symbol, '1h', entry.at - HOUR, exit.at)]);
  return fundingCash(rates, new Map(bars.map(b => [b.t + HOUR, b.c])), entry.at, exit.at, units);
}

export function unlockWindow(event: Event, arm: Arm) {
  const start = event.at - (arm === 'event' ? 7 : 21) * DAY;
  return { start, end: start + 6 * DAY };
}
export async function captureUnlock(db: Database, event: Event, arm: Arm, time: number, feed: Feed, now = Date.now, readSupply = supply) {
  const { start, end } = unlockWindow(event, arm);
  if (start < ARCHIVED || time < start || time > end + 21 * DAY) return;
  const key = (phase: string) => series(event.symbol, arm, phase);
  if (time < start + 15 * 60_000) {
    if (await observation(db, key('entry'), event.date) || await observation(db, key('skip'), event.date)) return;
    const [circ, assetBars, ethBars] = await Promise.all([readSupply(event.id),
      feed.getCandles(event.symbol, '1d', start - 61*DAY, start - 1), feed.getCandles('ETH', '1d', start - 61*DAY, start - 1)]);
    if (event.amount / circ < 0.01) {
      await record(db, key('skip'), event.date, now(), { reason: 'Below the 1% supply threshold', circ });
      return;
    }
    const beta = hedgeRatio(new Map(assetBars.map(b => [b.t,b.c])), new Map(ethBars.map(b => [b.t,b.c])), start);
    if (!beta) throw new Error('Waiting for a valid 60-day ETH hedge');
    const { token, eth, tokenMid, ethMid, time: at } = await books(feed, event, now);
    if (at >= start + 15 * 60_000 || Math.min(token.time!, eth.time!) < start) return;
    const tokenUnits = CAPITAL / (1 + beta) / tokenMid, ethUnits = CAPITAL * beta / (1 + beta) / ethMid;
    const short = averageFill(token.bids, tokenUnits), long = averageFill(eth.asks, ethUnits);
    if (!short || !long) throw new Error('Insufficient depth for both legs');
    await record(db, key('entry'), event.date, at, { beta, supply: circ, at, short, long, tokenUnits, ethUnits } satisfies Entry);
    return;
  }
  if (time < end) return;
  const entry = (await observation<Entry>(db, key('entry'), event.date))?.detail;
  if (!entry || await observation(db, key('result'), event.date)) return;
  let exit = (await observation<Exit>(db, key('exit'), event.date))?.detail;
  if (!exit) {
    if (time >= end + 15 * 60_000) return;
    const { token, eth, time: at } = await books(feed, event, now);
    const cover = averageFill(token.asks, entry.tokenUnits), sell = averageFill(eth.bids, entry.ethUnits);
    if (!cover || !sell || at >= end + 15 * 60_000 || Math.min(token.time!, eth.time!) < end) return;
    await record(db, key('exit'), event.date, at, { at, cover, sell } satisfies Exit);
    // A concurrent scan can have captured the exit first.
    exit = (await observation<Exit>(db, key('exit'), event.date))!.detail;
  }
  const [shortCredit,longDebit] = await Promise.all([funding(feed, event.symbol, entry, exit, entry.tokenUnits), funding(feed, 'ETH', entry, exit, entry.ethUnits)]);
  const fees = FEE * ((entry.short + exit.cover)*entry.tokenUnits + (entry.long + exit.sell)*entry.ethUnits);
  const pnl = (entry.short - exit.cover)*entry.tokenUnits + (exit.sell - entry.long)*entry.ethUnits + shortCredit - longDebit - fees;
  await record(db, key('result'), event.date, now(), { entry, exit, net: pnl / CAPITAL, funding: shortCredit - longDebit, fees } satisfies Observation);
}

export async function unlockReport(db: Database, time: number): Promise<StudyCard> {
  const upcoming = unlockEvents.filter(e => e.at > time).sort((a,b) => a.at - b.at)[0];
  const keys = tokens.flatMap(t => [...['result','entry','exit','skip'].map(p => series(t.symbol,'event',p)),series(t.symbol,'control','result')]);
  const { data, error } = await db.from('forward_test_days').select('strategy,day,detail').in('strategy',keys);
  if (error) throw new Error(error.message);
  const journal = new Map((data ?? []).map(row => [row.strategy + '/' + row.day, row.detail]));
  const rows = unlockEvents.filter(e => unlockWindow(e,'event').start <= time).map(e => {
    const read = <T>(arm: Arm, phase: string) => journal.get(series(e.symbol,arm,phase) + '/' + e.date) as T | undefined;
    const result = read<Observation>('event','result'), control = read<Observation>('control','result');
    const entry = read<Entry>('event','entry'), exit = read<Exit>('event','exit'), skip = read<{ reason: string }>('event','skip');
    const window = unlockWindow(e,'event');
    const note = skip?.reason ?? (result ? undefined : exit ? 'Funding pending' : time < window.start + 900_000 ? 'Checking quotes' :
      !entry ? 'Entry window missed' : time < window.end + 900_000 ? 'Paper pair open' : 'Exit window missed');
    return { date: e.date, label: e.symbol + ' / ETH', net: result?.net ?? null, control: control?.net ?? null, note };
  });
  const issuers = new Map<string,number[]>();
  for (const row of rows) {
    if (row.net == null || row.control == null) continue;
    const spreads = issuers.get(row.label) ?? [];
    spreads.push(row.net - row.control);
    issuers.set(row.label,spreads);
  }
  const mean = (v: number[]) => v.reduce((sum,n) => sum+n,0) / v.length;
  const ranked = [...issuers].sort((a,b) => mean(b[1]) - mean(a[1]));
  const remaining = ranked.slice(1).flatMap(([,spreads]) => spreads);
  return { id: 'unlock', name: 'Token unlock hedge', status: upcoming ? 'Next unlock · ' + upcoming.symbol + ' on ' + upcoming.date : 'Published schedule complete',
    rule: 'Short ARB or STRK seven days before a scheduled release of at least 1% of circulating supply. Hedge with ETH and exit the day before. Fills use visible depth. Funding uses published rates and hourly closing prices. STRK uses the published maximum release.',
    comparison: 'Same pair two weeks earlier', results: rows.sort((a,b) => b.date.localeCompare(a.date)),
    sensitivity: remaining.length ? { label: 'Lead without the strongest issuer', value: mean(remaining),
      detail: ranked[0][0].split(' / ')[0] + ' removed · ' + remaining.length + ' matched events' } : undefined };
}
