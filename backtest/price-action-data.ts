import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type { Bar } from '../lib/autopilot/strategies';

export const MAJORS = ['BTC', 'ETH', 'SOL'] as const;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const start = Date.UTC(2024, 0, 1);
export const DATA_END = Date.UTC(2026, 10, 1);
const months = Array.from({ length: 34 }, (_, i) => new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 7));
const cache = join(process.cwd(), 'backtest', 'data', 'intraday');

export type Funding = { time: number; rate: number; hours: number };
type ArchiveBar = Bar & { v: number };

export async function archiveRows(folder: string, name: string, url: string) {
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${name}.csv`);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim().split('\n');
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Archive returned HTTP ${response.status} for ${name}`);
  const zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  if (!zip[`${name}.csv`]) throw new Error(`Archive missing ${name}.csv`);
  const csv = new TextDecoder().decode(zip[`${name}.csv`]);
  writeFileSync(file, csv);
  return csv.trim().split('\n');
}

async function monthRead<T>(read: (month: string) => Promise<T[]>) {
  const rows: T[] = [];
  for (let i = 0; i < months.length; i += 6) rows.push(...(await Promise.all(months.slice(i, i + 6).map(read))).flat());
  return rows;
}

export async function perpFunding(coin: string): Promise<Funding[]> {
  const rows = await monthRead(async month => {
    const symbol = `${coin}USDT`;
    const name = `${symbol}-fundingRate-${month}`;
    return (await archiveRows(join(cache, 'price-action-funding'), name,
      `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${name}.zip`))
      .map(line => {
        const [t, hours, rate] = line.split(',').map(Number);
        return { time: Math.round(t / HOUR) * HOUR, hours, rate };
      }).filter(row => Number.isFinite(row.time) && Number.isFinite(row.rate) && [1, 2, 4, 8].includes(row.hours));
  });
  const unique = [...new Map(rows.map(row => [row.time, row])).values()].sort((a, b) => a.time - b.time);
  if (!unique.length || unique[0].time - start > 8 * HOUR || DATA_END - unique.at(-1)!.time > 8 * HOUR ||
      unique.some((row, i) => i > 0 && row.time - unique[i - 1].time > 8 * HOUR)) throw new Error(`Incomplete funding history for ${coin}`);
  return unique;
}

export const candle = (line: string): ArchiveBar | null => {
  const [stamp, o, h, l, c, v] = line.split(',', 6).map(Number);
  const t = stamp > 10 ** 14 ? Math.round(stamp / 1_000) : stamp;
  return Number.isFinite(t) && [o, h, l, c, v].every(Number.isFinite) && o > 0 && l > 0 && h >= Math.max(o, c) &&
    l <= Math.min(o, c) ? { t, o, h, l, c, v } : null;
};

export function loadPerps(coin: string, frame: number) {
  const step = 5 * 60_000;
  const expected = frame / step;
  const output: ArchiveBar[] = [];
  let bucket: ArchiveBar | null = null, bucketTime = -1, count = 0, contiguous = true;
  for (const month of months) {
    const path = join(cache, 'scalp-perps', `${coin}USDT-5m-${month}.csv`);
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      const bar = candle(line);
      if (!bar || bar.t < start || bar.t >= DATA_END) continue;
      const t = Math.floor(bar.t / frame) * frame;
      if (bucketTime !== t || !bucket) {
        if (bucket && contiguous && count === expected) output.push(bucket);
        bucket = { ...bar, t };
        bucketTime = t;
        count = 1;
        contiguous = bar.t === t;
      } else {
        contiguous &&= bar.t === t + count * step;
        bucket.h = Math.max(bucket.h, bar.h);
        bucket.l = Math.min(bucket.l, bar.l);
        bucket.c = bar.c;
        bucket.v += bar.v;
        count++;
      }
    }
  }
  if (bucket && contiguous && count === expected) output.push(bucket);
  if (output.length < .99 * (DATA_END - start) / frame) throw new Error(`Incomplete futures prices for ${coin}`);
  return output;
}

export async function spotHourly(coin: string) {
  return monthRead(async month => {
    const symbol = `${coin}USDT`;
    const name = `${symbol}-1h-${month}`;
    const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/1h/${name}.zip`;
    return (await archiveRows(join(cache, 'price-action-spot'), name, url)).flatMap(line => candle(line) ?? []);
  });
}

export async function perpetualHourly(coin: string) {
  const bars = await monthRead(async month => {
    const symbol = `${coin}USDT`;
    const name = `${symbol}-1h-${month}`;
    const url = `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${name}.zip`;
    return (await archiveRows(join(cache, 'price-action-hourly'), name, url)).flatMap(line => candle(line) ?? []);
  });
  if (bars.length < .99 * (DATA_END - start) / HOUR) throw new Error(`Incomplete hourly futures prices for ${coin}`);
  return bars;
}
