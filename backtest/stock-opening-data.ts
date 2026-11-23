import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { EtoroClient, EtoroError } from '@/lib/stocks/etoro';

export const OPENING_BASKET = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'AMD', 'AVGO', 'META', 'GOOGL', 'PLTR', 'MU', 'JPM', 'XOM', 'LLY', 'CAT', 'BA', 'WMT', 'SPY'] as const;
export const OPENING_START = '2025-05-01';
export const OPENING_END = '2026-11-21';
export const OPENING_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-opening');
export const OPENING_WINDOW = 175 * 86_400_000;

async function main() {
  const { ETORO_API_KEY: apiKey, ETORO_USER_KEY: userKey } = process.env;
  if (!apiKey || !userKey) throw new Error('Set ETORO_API_KEY and ETORO_USER_KEY in your environment.');
  const broker = new EtoroClient({ apiKey, userKey, environment: 'real' });
  mkdirSync(OPENING_DIR, { recursive: true });
  let next = 0;
  const pace = async () => {
    const start = Math.max(Date.now(), next);
    next = start + 650;
    await wait(Math.max(0, start - Date.now()));
  };
  for (const symbol of OPENING_BASKET) {
    await pace();
    const instrument = await broker.instrument(symbol);
    if (!instrument) throw new Error(`No unique eToro match for ${symbol}`);
    let count = 0;
    for (let from = Date.parse(OPENING_START); from < Date.parse(OPENING_END); from += OPENING_WINDOW) {
      const to = Math.min(from + OPENING_WINDOW, Date.parse(OPENING_END));
      const name = join(OPENING_DIR, `${symbol}-${new Date(from).toISOString().slice(0, 10)}.json`);
      if (existsSync(name)) continue;
      for (let attempt = 1; ; attempt++) {
        try {
          const bars = await broker.intradayCandles(instrument.instrumentId, from, to, pace, '30m');
          if (!bars.length) throw new Error(`No paired candles for ${symbol}`);
          writeFileSync(`${name}.tmp`, JSON.stringify(bars));
          renameSync(`${name}.tmp`, name);
          count += bars.length;
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          await wait(error instanceof EtoroError && error.status === 429 ? 61_000 : 2000);
        }
      }
    }
    console.log(`${symbol}: downloaded ${count} paired candles`);
  }
}

if (process.argv[1]?.endsWith('stock-opening-data.ts')) main().catch(e => { console.error(e instanceof Error ? e.message : 'Download failed'); process.exitCode = 1; });
