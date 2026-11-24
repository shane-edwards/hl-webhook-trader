import { join } from 'node:path';
import { END, FLOW_MARKETS, START } from './crypto-flow-data';
import { archiveRows, DAY } from './price-action-data';

const folder = join(process.cwd(), 'backtest', 'data', 'intraday', 'crypto-positioning');
const days = Array.from({ length: (END - START) / DAY }, (_, i) => new Date(START + i * DAY).toISOString().slice(0, 10));

export async function openInterest(coin: string) {
  const snapshots = new Map<number, number>();
  const missingDays: string[] = [];
  const symbol = `${coin}USDT`;
  for (let offset = 0; offset < days.length; offset += 4) {
    await Promise.all(days.slice(offset, offset + 4).map(async day => {
      const name = `${symbol}-metrics-${day}`;
      const url = `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${name}.zip`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          for (const line of await archiveRows(join(folder, symbol), name, url)) {
            const [stamp, ticker, quantity] = line.split(',', 3);
            if (ticker !== symbol || !stamp.startsWith(day)) continue;
            const time = Date.parse(stamp.replace(' ', 'T') + 'Z');
            const value = Number(quantity);
            if (Number.isFinite(time) && Number.isFinite(value) && value > 0) snapshots.set(time, value);
          }
          return;
        } catch (error) {
          if (/HTTP 404\b/.test(String(error))) {
            missingDays.push(day);
            return;
          }
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
    }));
  }
  return { snapshots, missingDays: missingDays.sort() };
}

if (process.argv[1]?.endsWith('crypto-positioning-data.ts')) void Promise.all(FLOW_MARKETS.map(async coin => {
  const { snapshots, missingDays } = await openInterest(coin);
  console.log(`${coin}: ${snapshots.size} snapshots, ${missingDays.length} missing archive days`);
})).catch(error => { console.error(error.message); process.exitCode = 1; });
