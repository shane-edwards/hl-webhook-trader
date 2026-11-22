import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from './engine';

// Resolved from the project root so the same loader works from the CLI
// (npm run backtest) and inside the deployed app (see next.config.ts).
const DATA_DIR = join(process.cwd(), 'backtest', 'data');

function readCsv(name: string): string[][] {
  return readFileSync(join(DATA_DIR, name), 'utf8').trim().split('\n').slice(1).map(l => l.split(','));
}

function toCandles(rows: string[][]): Candle[] {
  return rows.map(([date, open, high, low, close]) => ({ date, open: +open, high: +high, low: +low, close: +close }));
}

/** BTC/USD daily candles from Bitstamp (2012 onward). */
export function loadCandles(): Candle[] {
  return toCandles(readCsv('btcusd-daily-bitstamp.csv'));
}

/** Daily candles for a basket coin from Binance spot (USDT pair). */
export function loadCoinCandles(coin: string): Candle[] {
  return toCandles(readCsv(`${coin.toLowerCase()}usdt-daily-binance.csv`));
}

export function hasCoin(coin: string): boolean {
  return /^[A-Za-z0-9]+$/.test(coin) && existsSync(join(DATA_DIR, `${coin.toLowerCase()}usdt-daily-binance.csv`));
}

/** Real Hyperliquid funding per UTC day (sum of the day's hourly rates), keyed by date. */
export function loadRealFunding(coin = 'BTC'): Map<string, number> {
  return new Map(readCsv(`${coin.toLowerCase()}-funding-daily-hyperliquid.csv`).map(([d, sum]) => [d, +sum] as const));
}

/**
 * Daily funding paid by longs. Real Hyperliquid funding where it exists
 * (May 2023 onward); before that, `assumedDaily` (default 0.03%/day = the
 * 0.01%/8h baseline perps are anchored to, ~11%/yr).
 */
export function loadFunding(assumedDaily = 0.0003, multiplier = 1, coin = 'BTC'): (date: string) => number {
  const real = loadRealFunding(coin);
  return date => (real.get(date) ?? assumedDaily) * multiplier;
}
