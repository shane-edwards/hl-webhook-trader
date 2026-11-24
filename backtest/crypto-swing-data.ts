import { join } from 'node:path';
import { archiveRows, candle } from './price-action-data';

export const SWING_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'LINK', 'LTC', 'ADA', 'DOGE'] as const;
export const SWING_FROM = Date.UTC(2021, 0, 1);
export const SWING_END = Date.UTC(2026, 10, 1);
const cache = join(process.cwd(), 'backtest', 'data', 'intraday', 'crypto-swing');
const months = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2021, i, 1)).toISOString().slice(0, 7));
const day = 86_400_000;

async function batch<T>(load: (month: string) => Promise<T[]>) {
  const items: T[] = [];
  for (let i = 0; i < months.length; i += 8) items.push(...(await Promise.all(months.slice(i, i + 8).map(load))).flat());
  return items;
}

export async function swingData(coin: string) {
  const symbol = `${coin}USDT`;
  const root = 'https://data.binance.vision/data/futures/um/monthly';
  const [bars, rates] = await Promise.all([
    batch(async month => {
      const name = `${symbol}-1d-${month}`;
      return (await archiveRows(join(cache, 'prices'), name, `${root}/klines/${symbol}/1d/${name}.zip`)).flatMap(line => candle(line) ?? []);
    }),
    batch(async month => {
      const name = `${symbol}-fundingRate-${month}`;
      return (await archiveRows(join(cache, 'funding'), name, `${root}/fundingRate/${symbol}/${name}.zip`)).flatMap(line => {
        const [time, hours, rate] = line.split(',').map(Number);
        return Number.isFinite(time) && hours > 0 && hours <= 8 && Number.isFinite(rate) ? [{ time, hours, rate }] : [];
      });
    }),
  ]);
  const ordered = [...new Map(rates.map(rate => [rate.time, rate])).values()].sort((a, b) => a.time - b.time);
  if (bars.length !== (SWING_END - SWING_FROM) / day || ordered[0].time - SWING_FROM > 8.01 * 3_600_000 ||
      SWING_END - ordered.at(-1)!.time > 8.01 * 3_600_000 ||
      ordered.some((row, i) => i > 0 && row.time - ordered[i - 1].time > 8.01 * 3_600_000)) throw new Error(`Incomplete swap history for ${coin}`);
  const bucket = new Map<number, { pay: number; receive: number }>();
  for (const rate of ordered) {
    const key = Math.floor(Math.round(rate.time / 60_000) * 60_000 / day) * day;
    const entry = bucket.get(key) ?? { pay: 0, receive: 0 };
    entry.pay += Math.max(0, rate.rate);
    entry.receive += Math.max(0, -rate.rate);
    bucket.set(key, entry);
  }
  return bars.map((bar, i) => {
    if (bar.t !== SWING_FROM + i * day || !bucket.has(bar.t)) throw new Error(`Gap in matched daily market data for ${coin}`);
    return { ...bar, ...bucket.get(bar.t)! };
  });
}

if (process.argv[1]?.endsWith('crypto-swing-data.ts')) void Promise.all(SWING_COINS.map(async coin => {
  try { console.log(`${coin}: ${(await swingData(coin)).length} days of prices and funding`); }
  catch (error) { console.log(`${coin}: ${(error as Error).message}`); }
}));
