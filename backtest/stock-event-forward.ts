import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EtoroClient, type IntradayBar } from '@/lib/stocks/etoro';
import { alignFactorSessions, FACTOR_RULES, runFactorRule, type EarningsFiling } from '@/lib/stocks/factor-research';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { downloadEventWindows, REPLICATION_SYMBOLS } from './stock-event-replication-data';

const FROM = '2026-11-23';
const day = 86_400_000;
const dir = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-event-forward');

async function main() {
  // The current UTC date is exclusive. Never evaluate partial current-day bars.
  const to = new Date().toISOString().slice(0, 10);
  if (to <= FROM) { console.log(JSON.stringify({ from: FROM, to, trades: 0, status: 'No completed forward dates yet' })); return; }
  const { ETORO_API_KEY: apiKey, ETORO_USER_KEY: userKey } = process.env;
  if (!apiKey || !userKey) throw new Error('Set ETORO_API_KEY and ETORO_USER_KEY in your environment.');
  const broker = new EtoroClient({ apiKey, userKey, environment: 'real' });
  const directory = join(dir, to);
  await downloadEventWindows(broker, { directory, from: FROM, to });
  const items = REPLICATION_SYMBOLS.map(symbol => ({
    symbol, ...JSON.parse(readFileSync(join(directory, `${symbol}.json`), 'utf8')) as { bars: IntradayBar[]; filings: EarningsFiling[]; unavailable?: boolean },
  }));
  const history = Object.fromEntries(items.map(item => [item.symbol, regularStockSessions(item.bars, 30).sessions]));
  const spy = await broker.instrument('SPY');
  if (!spy) throw new Error('No unique SPY match');
  const spyBars = [];
  for (let t = Date.parse(FROM) - 5 * day; t < Date.parse(to); t += 175 * day) {
    spyBars.push(...await broker.intradayCandles(spy.instrumentId, t, Math.min(t + 175 * day, Date.parse(to)), undefined, '30m'));
  }
  history.SPY = regularStockSessions(spyBars, 30).sessions;
  const data = alignFactorSessions(history, Object.fromEntries(items.map(i => [i.symbol, i.filings])));
  const rule = FACTOR_RULES.find(r => r.id === 'event--1-0.01-12')!;
  const result = runFactorRule(data, rule, FROM, to);
  const report = { from: FROM, to, rule: rule.id, marketThrough: history.SPY.at(-1)?.day ?? null, unavailable: items.filter(i => i.unavailable).map(i => i.symbol), result };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Forward research failed'); process.exitCode = 1; });
