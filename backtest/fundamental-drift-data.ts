import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createServiceClient } from '../lib/supabase/server';
import { stockFeed } from '../lib/automation/research';
import { STOCK_INSTRUMENTS, STOCK_TRADE_SYMBOLS } from '../lib/stocks/trade-rules';
import { EtoroError } from '../lib/stocks/etoro';
import type { StockBar } from '../lib/stocks/research';

export const FILING_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'fundamental-drift');
export const FILING_THROUGH = '2026-11-21';
export type EPS = { start: string; end: string; val: number; accn: string; filed: string; form: string };
export type FilingRecord = { symbol: string; daily: StockBar[]; earnings: EPS[] };

async function readSec<T>(path: string) {
  const response = await fetch(path, { signal: AbortSignal.timeout(14_000),
    headers: { 'User-Agent': process.env.SEC_USER_AGENT ?? 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' } });
  if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
  return await response.json() as T;
}

async function retry<T>(work: () => Promise<T>) {
  for (let i = 0; ; i++) {
    try { return await work(); } catch (error) {
      if (i >= 2) throw error;
      await wait(error instanceof EtoroError && error.status === 429 ? 62_000 : (i + 1) * 2000);
    }
  }
}

async function download() {
  const db = createServiceClient();
  const accounts = await db.from('etoro_connections').select('user_id').eq('environment', 'real').limit(2);
  if (accounts.error || accounts.data.length !== 1) throw new Error('Expected one read-only eToro research feed.');
  const broker = await stockFeed(db, accounts.data[0].user_id);
  const listing = await readSec<Record<string, { ticker: string; cik_str: number }>>('https://www.sec.gov/files/company_tickers.json');
  const bySymbol = new Map(Object.values(listing).map(item => [item.ticker, item.cik_str]));
  mkdirSync(FILING_DIR, { recursive: true });
  for (let i = 0; i < STOCK_TRADE_SYMBOLS.length; i += 3) {
    const results = await Promise.allSettled(STOCK_TRADE_SYMBOLS.slice(i, i + 3).map(async symbol => {
      const file = join(FILING_DIR, `${symbol}.json`);
      if (existsSync(file)) return;
      const cik = bySymbol.get(symbol);
      const [daily, facts] = await Promise.all([
        retry(() => broker.candles(STOCK_INSTRUMENTS[symbol], 2375, Date.parse(FILING_THROUGH), true, false, 16_000)),
        cik && symbol !== 'SPY'
          ? retry(() => readSec<{ facts: { 'us-gaap'?: { EarningsPerShareDiluted?: { units: { 'USD/shares'?: EPS[] } } } } }>(
            `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`)) : null,
      ]);
      const source = facts?.facts['us-gaap']?.EarningsPerShareDiluted?.units['USD/shares'] ?? [];
      const earnings = source.filter(row => row.end >= '2018-01-01' && row.filed < FILING_THROUGH && ['10-Q', '10-K'].includes(row.form));
      const body: FilingRecord = { symbol, daily, earnings };
      writeFileSync(`${file}.tmp`, JSON.stringify(body));
      renameSync(`${file}.tmp`, file);
      console.log(`${symbol}: ${daily.length} price sessions and ${earnings.length} filed EPS observations`);
    }));
    results.forEach((result, j) => { if (result.status === 'rejected') console.log(`${STOCK_TRADE_SYMBOLS[i + j]}: ${(result.reason as Error).message}`); });
  }
}
if (process.argv[1]?.endsWith('fundamental-drift-data.ts')) void download().catch(error => { console.error(error.message); process.exitCode = 1; });
