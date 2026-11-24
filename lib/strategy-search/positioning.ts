import { strFromU8, unzipSync } from 'fflate';
import seed from './positioning-history.json';
import { DAY, type DailyContext } from './context';

// Raw observations are shared across the five timeframes of this symbol.
export type PositionDay = [day: number, interest: number | null, funding: number | null, checked: number];
const HOUR = 3_600_000;

async function readInterest(symbol: string, day: number) {
  const iso = new Date(day).toISOString().slice(0,10);
  const name = `${symbol}-metrics-${iso}`;
  const response = await fetch(`https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${name}.zip`,
    { next: { revalidate: 86400 }, signal: AbortSignal.timeout(4000) });
  if (!response.ok) return null;
  const file = unzipSync(new Uint8Array(await response.arrayBuffer()))[name+'.csv'];
  if (!file) return null;
  const row = strFromU8(file).split('\n').find(line => line.startsWith(iso+' 23:55:00,'+symbol+','));
  const oi = Number(row?.split(',')[2]);
  return Number.isFinite(oi) && oi > 0 ? oi : null;
}

// At most 14 UTC days per call, below the venue's 500-hour page size.
async function readFunding(asset: string, from: number, through: number) {
  const response = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ type:'fundingHistory', coin:asset, startTime:from, endTime:through+DAY-1 }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Funding unavailable');
  const body = await response.json() as { coin: string; time: number; fundingRate: string }[];
  const hours = new Map<number,number>();
  for (const r of body) {
    const rate = Number(r.fundingRate);
    if (r.coin === asset && r.time >= from && r.time < through + DAY && Number.isFinite(rate))
      hours.set(Math.floor(r.time/HOUR),rate);
  }
  const rates = new Map<number,number>();
  for (let day = from; day <= through; day += DAY) {
    const values = Array.from({length:24}, (_,i) => hours.get(day/HOUR+i));
    if (values.every((r): r is number => r !== undefined)) rates.set(day,values.reduce((a,b) => a+b,0));
  }
  return rates;
}

export function dailySignals(rows: Map<number, (number | null)[]>) {
  const values: DailyContext = new Map();
  for (const [day,[oi,rate]] of rows) {
    const prior = rows.get(day - DAY);
    if (!prior) continue;
    const [previousOi, previousRate] = prior;
    values.set(day + DAY, {
      ...(oi && previousOi ? {binanceInterest:oi/previousOi-1} : {}),
      ...(rate != null && previousRate != null ? {venueFunding:rate-previousRate} : {}),
    });
  }
  return values;
}

export async function archivePositioning(asset: string, now: number, saved: PositionDay[]) {
  const today = Math.floor(now/DAY)*DAY;
  const through = Date.parse(seed.through);
  const floor = Math.max(through + DAY, today - 1200*DAY);
  const tail = new Map(saved.filter(r => r[0] >= floor && r[0] < today).map(r => [r[0],r]));
  const due: number[] = [];
  for (let day = today-DAY; day >= floor; day -= DAY) {
    const row = tail.get(day);
    if (!row || ((row[1] === null || row[2] === null) && now - row[3] >= DAY)) due.push(day);
  }
  // Normal refreshes add a handful of days. Bound catch-up after a long interruption.
  const batch = due.slice(0,28).sort((a,b) => a-b);
  const groups: number[][] = [];
  for (const day of batch) {
    const group = groups.at(-1);
    if (!group || day-group[0] >= 14*DAY) groups.push([day]);
    else group.push(day);
  }
  const funding = new Map((await Promise.all(groups.map(group =>
    readFunding(asset,group[0],group.at(-1)!).catch(() => new Map<number,number>())))).flatMap(m => [...m]));
  for (let i=0; i<batch.length; i+=8) {
    await Promise.all(batch.slice(i,i+8).map(async day => {
      const prior = tail.get(day);
      const oi = prior?.[1] ?? await readInterest(asset+'USDT',day).catch(() => null);
      tail.set(day,[day,oi,prior?.[2] ?? funding.get(day) ?? null,now]);
    }));
  }
  const start = Date.parse(seed.first);
  const history = (seed.assets as Record<string,(number|null)[][]>)[asset] ?? [];
  const rows = new Map(history.map((r,i) => [start+i*DAY,r]));
  for (const [t,oi,funding] of tail.values()) rows.set(t,[oi,funding]);
  return { context:dailySignals(rows), tail:[...tail.values()].sort((a,b) => a[0]-b[0]) };
}
