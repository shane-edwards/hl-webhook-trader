import { join } from 'node:path';
import { archiveRows, HOUR } from './price-action-data';

export const FLOW_MARKETS = ['BTC', 'ETH', 'SOL'] as const;
export const START = Date.UTC(2024, 0, 1);
export const END = Date.UTC(2026, 10, 1);
export const FRAME = HOUR / 4;
const folder = join(process.cwd(), 'backtest', 'data', 'intraday', 'crypto-flow');
const months = Array.from({ length: 34 }, (_, i) => new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 7));
export type FlowBar = { t: number; o: number; h: number; l: number; c: number; volume: number; aggressive: number };

async function read(symbol: string, month: string, venue: 'futures/um' | 'spot'): Promise<FlowBar[]> {
  const file = `${symbol}USDT-15m-${month}`;
  const archive = await archiveRows(join(folder, venue), file,
    `https://data.binance.vision/data/${venue}/monthly/klines/${symbol}USDT/15m/${file}.zip`);
  return archive.flatMap(line => {
    const raw = line.split(',', 11).map(Number);
    const [stamp, o, h, l, c] = raw;
    const t = stamp > 10 ** 14 ? Math.round(stamp / 1000) : stamp;
    const volume = raw[7];
    const aggressive = raw[10];
    return [t, o, h, l, c, volume, aggressive].every(Number.isFinite) && o > 0 && l > 0 && c > 0 &&
      l <= Math.min(o, c) && h >= Math.max(o, c) && volume > 0 && aggressive >= 0 && aggressive <= volume ? [{ t, o, h, l, c, volume, aggressive }] : [];
  });
}

export async function cryptoFlow(symbol: string) {
  const result: { spot: FlowBar; perp: FlowBar; t: number }[] = [];
  for (let i = 0; i < months.length; i += 6) {
    const parts = await Promise.all(months.slice(i, i + 6).map(async month => {
      const [spot, perpetual] = await Promise.all([read(symbol, month, 'spot'), read(symbol, month, 'futures/um')]);
      const index = new Map(perpetual.map(bar => [bar.t, bar]));
      return spot.flatMap(bar => {
        const perp = index.get(bar.t);
        return perp ? [{ spot: bar, perp, t: bar.t }] : [];
      });
    }));
    result.push(...parts.flat());
  }
  if (result.length < .995 * (END - START) / FRAME ||
    result.some((row, i) => i > 0 && row.t <= result[i - 1].t)) throw new Error(`Incomplete paired order-flow bars for ${symbol}`);
  return result;
}

if (process.argv[1]?.endsWith('crypto-flow-data.ts')) void Promise.all(FLOW_MARKETS.map(async symbol => {
  const rows = await cryptoFlow(symbol);
  console.log(`${symbol}: ${rows.length} matched spot and perpetual order-flow candles`);
})).catch(error => { console.error(error.message); process.exitCode = 1; });
