import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Candle } from './engine';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

function readCsv(name: string): string[][] {
  return readFileSync(join(DATA_DIR, name), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
}

export function loadCandles(): Candle[] {
  return readCsv('btcusd-daily-bitstamp.csv').map(([date, open, high, low, close]) => ({
    date, open: +open, high: +high, low: +low, close: +close,
  }));
}

/**
 * Daily funding paid by longs. Real Hyperliquid BTC funding where it exists
 * (May 2023 onward); before that, `assumedDaily` (default 0.03%/day = the
 * 0.01%/8h baseline perps are anchored to, ~11%/yr).
 */
export function loadFunding(assumedDaily = 0.0003, multiplier = 1): (date: string) => number {
  const real = new Map(readCsv('btc-funding-daily-hyperliquid.csv').map(([d, sum]) => [d, +sum] as const));
  return date => (real.get(date) ?? assumedDaily) * multiplier;
}
