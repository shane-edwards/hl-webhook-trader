import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { EarningsFiling } from '@/lib/stocks/factor-research';

export const EVENT_ISSUERS = {
  AAPL: 320193, MSFT: 789019, NVDA: 1045810, AMZN: 1018724, TSLA: 1318605, AMD: 2488, AVGO: 1730168,
  META: 1326801, GOOGL: 1652044, PLTR: 1321655, MU: 723125, JPM: 19617, XOM: 34088, LLY: 59478,
  CAT: 18230, BA: 12927, WMT: 104169,
} as const;
export const EVENTS_DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-events');

async function main() {
  mkdirSync(EVENTS_DIR, { recursive: true });
  for (const [symbol, cik] of Object.entries(EVENT_ISSUERS)) {
    const response = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, {
      headers: { 'User-Agent': process.env.SEC_USER_AGENT ?? 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`SEC returned ${response.status} for ${symbol}`);
    const { filings: { recent } } = await response.json() as { filings: { recent: {
      form: string[]; acceptanceDateTime: string[]; reportDate: string[]; items: string[];
    } } };
    const events: EarningsFiling[] = [];
    for (let i = 0; i < recent.form.length; i++) {
      if (recent.form[i] !== '8-K' || !recent.items[i]?.split(/[,;]/).some(item => item.trim() === '2.02')) continue;
      const time = Date.parse(recent.acceptanceDateTime[i]);
      const reportDate = recent.reportDate[i];
      if (Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}$/.test(reportDate)) events.push({ time, reportDate });
    }
    const path = join(EVENTS_DIR, `${symbol}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(events));
    renameSync(`${path}.tmp`, path);
    console.log(`${symbol}: ${events.filter(x => x.time >= Date.UTC(2025, 4, 1) && x.time < Date.UTC(2026, 10, 21)).length} earnings filings in range`);
    await wait(175);
  }
}

if (process.argv[1]?.endsWith('stock-events-data.ts')) main().catch(error => { console.error(error instanceof Error ? error.message : 'SEC download failed'); process.exitCode = 1; });
