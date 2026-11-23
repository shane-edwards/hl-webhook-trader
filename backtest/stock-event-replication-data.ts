import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { EtoroClient, EtoroError, type IntradayBar } from '@/lib/stocks/etoro';
import type { EarningsFiling } from '@/lib/stocks/factor-research';

// Fixed before examining returns. None were in the first research universe.
export const REPLICATION_SYMBOLS = ['COST', 'UNH', 'BAC', 'GS', 'CVX', 'SLB', 'UNP', 'UPS', 'HD', 'LOW', 'ORCL', 'CRM', 'ADP', 'INTC', 'QCOM', 'NFLX', 'DIS', 'MCD', 'PEP', 'KO', 'MRK', 'PFE', 'TXN', 'AMAT', 'GE', 'IBM'] as const;
export const REPLICATION_START = '2026-04-01';
export const REPLICATION_END = '2026-11-21';
export const REPLICATION_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-event-replication');
const day = 86_400_000;

async function sec<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'User-Agent': process.env.SEC_USER_AGENT ?? 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`SEC returned ${response.status}`);
  return response.json();
}

export async function downloadEventWindows(broker: EtoroClient, { directory, from, to }: { directory: string; from: string; to: string }) {
  mkdirSync(directory, { recursive: true });
  const listings = await sec<Record<string, { ticker: string; cik_str: number }>>('https://www.sec.gov/files/company_tickers.json');
  const ciks = new Map(Object.values(listings).map(i => [i.ticker, i.cik_str]));
  const first = Date.parse(from), last = Date.parse(to);
  let next = 0;
  const pace = async () => {
    const start = Math.max(Date.now(), next);
    next = start + 650;
    await wait(Math.max(0, start - Date.now()));
  };
  for (const symbol of REPLICATION_SYMBOLS) {
    const path = join(directory, `${symbol}.json`);
    if (existsSync(path)) continue;
    const cik = ciks.get(symbol);
    if (!cik) throw new Error(`No SEC ticker match for ${symbol}`);
    const { filings: { recent } } = await sec<{ filings: { recent: { form: string[]; items: string[]; acceptanceDateTime: string[]; reportDate: string[] } } }>(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`);
    const filings: EarningsFiling[] = [];
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] !== '8-K' || !recent.items[i]?.split(/[,;]/).some(x => x.trim() === '2.02')) continue;
      const time = Date.parse(recent.acceptanceDateTime[i]), reportDate = recent.reportDate[i];
      if (time >= first - 4 * day && time < last && Math.abs(time - Date.parse(`${reportDate}T00:00:00Z`)) <= 36 * 3_600_000) filings.push({ time, reportDate });
    }
    if (!filings.length) {
      writeFileSync(`${path}.tmp`, JSON.stringify({ filings, bars: [] }));
      renameSync(`${path}.tmp`, path);
      continue;
    }
    await pace();
    const instrument = await broker.instrument(symbol);
    if (!instrument) {
      writeFileSync(`${path}.tmp`, JSON.stringify({ filings, bars: [], unavailable: true }));
      renameSync(`${path}.tmp`, path);
      console.log(`${symbol}: no unique eToro US match`);
      continue;
    }
    const all = new Map<number, IntradayBar>();
    for (const event of filings) {
      const from = Math.floor(event.time / day) * day - 5 * day;
      const to = Math.min(last, from + 10 * day);
      for (let attempt = 1; ; attempt++) {
        try {
          for (const b of await broker.intradayCandles(instrument.instrumentId, from, to, pace, '30m')) all.set(b.t, b);
          break;
        } catch (err) {
          if (attempt === 3) throw err;
          await wait(err instanceof EtoroError && err.status === 429 ? 61_000 : 2000);
        }
      }
    }
    writeFileSync(`${path}.tmp`, JSON.stringify({ filings, bars: [...all.values()] }));
    renameSync(`${path}.tmp`, path);
    console.log(`${symbol}: ${filings.length} filings, ${all.size} paired candles`);
  }
}

async function main() {
  const { ETORO_API_KEY: apiKey, ETORO_USER_KEY: userKey } = process.env;
  if (!apiKey || !userKey) throw new Error('Set ETORO_API_KEY and ETORO_USER_KEY in your environment.');
  const broker = new EtoroClient({ apiKey, userKey, environment: 'real' });
  await downloadEventWindows(broker, { directory: REPLICATION_DIR, from: REPLICATION_START, to: REPLICATION_END });
}

if (process.argv[1]?.endsWith('stock-event-replication-data.ts')) main().catch(error => { console.error(error instanceof Error ? error.message : 'Replication download failed'); process.exitCode = 1; });
