import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { stockFeed } from '../lib/automation/research';
import { createServiceClient } from '../lib/supabase/server';
import { EtoroError } from '../lib/stocks/etoro';
import { regularStockSessions, type StockSession } from '../lib/stocks/intraday';
import { STOCK_INSTRUMENTS } from '../lib/stocks/trade-rules';

export const GAP_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'JPM', 'XOM', 'WMT', 'UNH'] as const;
export const GAP_DIR = join('backtest', 'data', 'intraday', 'stock-gaps');
export const GAP_END = '2026-11-21';

async function download() {
  const db = createServiceClient();
  const accounts = await db.from('etoro_connections').select('user_id').eq('environment', 'real').limit(2);
  if (accounts.error || accounts.data.length !== 1) throw new Error('Expected one eToro historical feed.');
  const broker = await stockFeed(db, accounts.data[0].user_id);
  mkdirSync(GAP_DIR, { recursive: true });
  const begin = Date.UTC(2022, 10, 10);
  const end = Date.parse(GAP_END);
  const step = 110 * 86_400_000;
  let next = 0;
  const pace = async () => {
    const target = Math.max(Date.now(), next);
    next = target + 350;
    await wait(Math.max(0, target - Date.now()));
  };
  for (let offset = 0; offset < GAP_SYMBOLS.length; offset += 2) {
    const completed = await Promise.allSettled(GAP_SYMBOLS.slice(offset, offset + 2).map(async symbol => {
      const file = join(GAP_DIR, `${symbol}.json`);
      if (existsSync(file)) return;
      const sessions: StockSession[] = [];
      for (let from = begin; from < end; from += step) {
        const to = Math.min(from + step, end);
        const page = join(GAP_DIR, `${symbol}-${from}.json`);
        if (existsSync(page)) {
          sessions.push(...JSON.parse(readFileSync(page, 'utf8')));
          continue;
        }
        for (let attempt = 0; ; attempt++) {
          try {
            const quotes = await broker.intradayCandles(STOCK_INSTRUMENTS[symbol], from, to, pace, '30m', false, 13_000);
            const batch = regularStockSessions(quotes, 30).sessions;
            if (batch.length < 12) throw new Error('Insufficient quotes in broker page');
            writeFileSync(`${page}.tmp`, JSON.stringify(batch));
            renameSync(`${page}.tmp`, page);
            sessions.push(...batch);
            break;
          } catch (error) {
            if (attempt === 3) throw error;
            await wait(error instanceof EtoroError && error.status === 429 ? 61_000 : 2500);
          }
        }
      }
      const sorted = [...new Map(sessions.map(session => [session.day, session])).values()].sort((a, b) => a.day.localeCompare(b.day));
      if (sorted.length < 950) throw new Error(`Incomplete intraday history for ${symbol}: ${sorted.length} sessions`);
      writeFileSync(`${file}.tmp`, JSON.stringify(sorted));
      renameSync(`${file}.tmp`, file);
      console.log(symbol, sorted.length);
    }));
    for (const [i, result] of completed.entries()) if (result.status === 'rejected') {
      console.log(GAP_SYMBOLS[offset + i], result.reason instanceof Error ? result.reason.message : 'Unable to download history');
    }
  }
}

if (process.argv[1]?.endsWith('stock-gap-data.ts')) void download().catch(error => { console.error(error.message); process.exitCode = 1; });
