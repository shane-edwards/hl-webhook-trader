import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { EtoroClient, EtoroError } from '@/lib/stocks/etoro';

export const STUDY_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'TSLA', 'SPY'] as const;
export const STUDY_START = '2025-05-01';
export const STUDY_END = '2026-11-21';
export const STUDY_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-replay');

async function main() {
  const { ETORO_API_KEY: apiKey, ETORO_USER_KEY: userKey } = process.env;
  if (!apiKey || !userKey) throw new Error('Set ETORO_API_KEY and ETORO_USER_KEY in your environment.');
  const broker = new EtoroClient({ apiKey, userKey, environment: 'real' });
  mkdirSync(STUDY_DIR, { recursive: true });
  let nextRequest = 0;
  const pace = async () => {
    const slot = Math.max(Date.now(), nextRequest);
    nextRequest = slot + 650;
    await wait(Math.max(0, slot - Date.now()));
  };
  const day = 86_400_000;
  for (const symbol of STUDY_SYMBOLS) {
    await pace();
    const instrument = await broker.instrument(symbol);
    if (!instrument) throw new Error(`No unique match for ${symbol}`);
    let count = 0;
    for (let from = Date.parse(STUDY_START); from < Date.parse(STUDY_END); from += 28 * day) {
      const to = Math.min(from + 28 * day, Date.parse(STUDY_END));
      const name = join(STUDY_DIR, `${symbol}-${new Date(from).toISOString().slice(0, 10)}.json`);
      if (existsSync(name)) continue;
      for (let attempt = 1; ; attempt++) {
        try {
          const bars = await broker.intradayCandles(instrument.instrumentId, from, to, pace);
          if (!bars.length) throw new Error(`${symbol}: no paired candles`);
          const temporary = `${name}.tmp`;
          writeFileSync(temporary, JSON.stringify(bars));
          renameSync(temporary, name);
          count += bars.length;
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          await wait(error instanceof EtoroError && error.status === 429 ? 61_000 : 2000);
        }
      }
    }
    console.log(`${symbol}: downloaded ${count} paired bars`);
  }
}

if (process.argv[1]?.endsWith('stock-intraday-data.ts')) main().catch(error => { console.error(error instanceof Error ? error.message : 'Data download failed'); process.exitCode = 1; });
