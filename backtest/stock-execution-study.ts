import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IntradayBar } from '@/lib/stocks/etoro';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { type StockBar } from '@/lib/stocks/research';
import { dailyTradeSignal, regularDailyBars } from '@/lib/stocks/trade-signals';
import { INSIDE_DAY_SYMBOLS } from '@/lib/stocks/trade-rules';

const directory = join(process.cwd(), 'backtest/data/intraday/stock-opening');
const files = readdirSync(directory);
const covered = INSIDE_DAY_SYMBOLS;
const markets = covered.map(symbol => {
  const raw = files.filter(file => file.startsWith(`${symbol}-`)).flatMap(file => JSON.parse(readFileSync(join(directory, file), 'utf8')) as IntradayBar[]);
  if (!raw.length) throw new Error(`Missing 30-minute history for ${symbol}`);
  return { symbol, bars: regularDailyBars(regularStockSessions(raw, 30).sessions) };
});

const net = (buy: number, sell: number, bps: number, fee: number) => {
  const slip = bps / 10_000;
  return (((10_000 - fee) / (buy * (1 + slip)) * sell * (1 - slip) - fee) / 10_000 - 1) * 10_000;
};

function replay(bars: StockBar[], start: string, end: string) {
  const trades = [];
  let entry = -1;
  // Use the screen's 100-session observation floor before counting candidate trades.
  for (let i = 100; i < bars.length - 1; i++) {
    const next = bars[i + 1];
    if (next.day < start || next.day >= end) continue;
    if (!dailyTradeSignal(bars.slice(0, i + 1), 'inside-day', entry < 0 ? null : i - entry + 1)) continue;
    if (entry < 0) { entry = i + 1; continue; }
    trades.push({ day: bars[entry].day, base: net(bars[entry].askOpen, next.bidOpen, 3, 1), stress: net(bars[entry].askOpen, next.bidOpen, 6, 2) });
    entry = -1;
  }
  return trades;
}

const stages = [
  ['2025 screen', '2025-08-01', '2026-01-01'],
  ['2026 H1 validation', '2026-01-01', '2026-07-01'],
  ['2026 H2 holdout', '2026-07-01', '2026-11-21'],
].map(([label, from, to]) => {
  const results = markets.map(({ bars }) => replay(bars, from, to));
  const trades = results.flat();
  const sum = (key: 'base' | 'stress') => trades.reduce((total, t) => total + t[key], 0);
  return { label, from, to, trades: trades.length, activeDays: new Set(trades.map(t => t.day)).size,
    positiveMarkets: results.filter(ts => ts.reduce((total, t) => total + t.stress, 0) > 0).length,
    netBps: trades.length ? sum('base') / trades.length : null, stressBps: trades.length ? sum('stress') / trades.length : null };
});
const evidence = { symbols: covered, stages };
writeFileSync('lib/stocks/inside-day-evidence.json', JSON.stringify(evidence, null, 2) + '\n');
console.table(stages);
