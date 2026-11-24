import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { stockFeed } from '../lib/automation/research';
import { EtoroError } from '../lib/stocks/etoro';
import { createServiceClient } from '../lib/supabase/server';
import { regularStockSessions } from '../lib/stocks/intraday';

export const ETF_NAMES = ['SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLE', 'GLD', 'TLT'] as const;
export const RESERVATION_ETFS = ['DIA', 'EEM', 'EFA', 'XLY', 'XLC', 'XLI', 'XLB', 'XLP', 'XLU', 'XLV', 'VNQ', 'SMH'] as const;
export const INTRADAY_ETFS = ETF_NAMES.slice(0, 5);
export const ETF_FROM = '2023-01-01';
export const ETF_TO = '2026-11-21';
export const ETF_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'etf-strategies');
const day = 86_400_000;

async function download(symbols: readonly string[]) {
  const db = createServiceClient();
  const accounts = await db.from('etoro_connections').select('user_id').eq('environment', 'real').limit(2);
  if (accounts.error || accounts.data.length !== 1) throw new Error('Expected one eToro feed for the research download.');
  const broker = await stockFeed(db, accounts.data[0].user_id);
  mkdirSync(ETF_DIR, { recursive: true });
  let next = 0;
  const pace = async () => {
    const target = Math.max(Date.now(), next);
    next = target + 450;
    await wait(Math.max(0, target - Date.now()));
  };
  for (let offset = 0; offset < symbols.length; offset += 2) {
    const completed = await Promise.allSettled(symbols.slice(offset, offset + 2).map(async symbol => {
      const output = join(ETF_DIR, `${symbol}.json`);
      if (existsSync(output)) return;
      await pace();
      const instrument = await broker.instrument(symbol, 15_000, 'etf');
      if (!instrument) throw new Error(`No exact eToro listing for ${symbol}`);
      const daily = await broker.candles(instrument.instrumentId, 1750, Date.parse(ETF_TO), true, false, 15_000);
      const sessions = [];
      if (INTRADAY_ETFS.some(item => item === symbol)) {
        const span = 160 * day;
        for (let from = Date.parse(ETF_FROM) - 45 * day; from < Date.parse(ETF_TO); from += span) {
          const to = Math.min(from + span, Date.parse(ETF_TO));
          for (let retry = 0; ; retry++) {
            try {
              const rows = await broker.intradayCandles(instrument.instrumentId, from, to, pace, '30m', false, 14_000);
              sessions.push(...regularStockSessions(rows, 30).sessions);
              break;
            } catch (error) {
              if (retry >= 2) throw error;
              await wait(error instanceof EtoroError && error.status === 429 ? 61_000 : 2500);
            }
          }
        }
      }
      const unique = [...new Map(sessions.map(session => [session.day, session])).values()].sort((a, b) => a.day.localeCompare(b.day));
      writeFileSync(`${output}.tmp`, JSON.stringify({ symbol, daily, sessions: unique }));
      renameSync(`${output}.tmp`, output);
      console.log(`${symbol}: ${daily.length} daily quotes, ${unique.length} complete regular 30-minute sessions`);
    }));
    for (const item of completed) if (item.status === 'rejected') console.log(item.reason instanceof Error ? item.reason.message : 'Market data unavailable');
  }
}

if (process.argv[1]?.endsWith('intraday-etf-data.ts')) void download(process.argv.includes('--reserve') ? RESERVATION_ETFS : ETF_NAMES).catch(error => {
  console.error(error instanceof Error ? error.message : 'ETF data download failed');
  process.exitCode = 1;
});
