import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { IntradayBar } from '../lib/stocks/etoro';
import { regularStockSessions } from '../lib/stocks/intraday';
import { LAB_SYMBOLS, replayLabMarket, stockLabWindows, summarizeStockLab } from '../lib/stocks/intraday-lab';

const asOf = process.argv[2] ?? '2026-11-21';
const options = { slipBps: 3, fee: 1 };
const { from } = stockLabWindows(asOf);
const fromTime = Date.parse(from);
const throughTime = Date.parse(asOf);
const legacy = 'backtest/data/intraday/stock-replay';
const supplemental = 'backtest/data/intraday/stock-lab';
const files = readdirSync(legacy);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as IntradayBar[];
const results = LAB_SYMBOLS.map(symbol => {
  const byTime = new Map<number, IntradayBar>();
  for (const file of files.filter(name => name.startsWith(`${symbol}-`))) {
    for (const bar of read(`${legacy}/${file}`)) if (bar.t >= fromTime && bar.t < throughTime) byTime.set(bar.t, bar);
  }
  const extra = `${supplemental}/${symbol}.json`;
  if (existsSync(extra)) {
    for (const bar of read(extra)) if (bar.t >= fromTime && bar.t < throughTime) byTime.set(bar.t, bar);
  }
  if (!byTime.size) throw new Error(`Missing paired five-minute bars for ${symbol}`);
  const { sessions } = regularStockSessions([...byTime.values()]);
  return replayLabMarket(symbol, sessions, asOf, options);
});
const report = summarizeStockLab(results, asOf, options);
writeFileSync('lib/stocks/intraday-lab-evidence.json', JSON.stringify(report, null, 2) + '\n');
console.table(report.reports.map(({ rule, status, validation, dateHoldout, tickerHoldout }) => ({
  rule, status, validation: validation.trades, dateHoldout: dateHoldout.trades, tickerHoldout: tickerHoldout.trades,
})));
