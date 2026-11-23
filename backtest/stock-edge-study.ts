import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IntradayBar } from '../lib/stocks/etoro';
import { stockRegime, type EvidenceTrade, type StockMarketRegime } from '../lib/stocks/evidence-model';
import { regularStockSessions } from '../lib/stocks/intraday';
import { replayNights } from '../lib/stocks/replay';
import { stockSignal, type DailyStockRule, type StockBar } from '../lib/stocks/research';
import { previousStockSession } from '../lib/stocks/session';
import { regularDailyBars } from '../lib/stocks/trade-signals';
import { STOCK_TRADE_SYMBOLS, supportsStockTradeRule } from '../lib/stocks/trade-rules';

const directory = 'backtest/data/intraday/stock-opening';
const files = readdirSync(directory);
const load = (symbol: string) => regularDailyBars(regularStockSessions(files.filter(name => name.startsWith(`${symbol}-`))
  .flatMap(name => JSON.parse(readFileSync(`${directory}/${name}`, 'utf8')) as IntradayBar[]), 30).sessions);
const spy = load('SPY');
const regime = new Map<string, StockMarketRegime>();
for (let i = 21; i < spy.length; i++) {
  const value = stockRegime(spy.slice(i - 21, i));
  if (value) regime.set(spy[i].day, value);
}

function study(bars: StockBar[], symbol: string, rule: DailyStockRule) {
  const output: EvidenceTrade[] = [];
  const closes = bars.map(bar => bar.bidClose);
  let entry: { i: number; phase: StockMarketRegime } | null = null;
  for (let i = 100; i < bars.length - 1; i++) {
    const next = bars[i + 1];
    if (next.day < '2026-01-01' || next.day >= '2026-11-21') continue;
    if (previousStockSession(Date.parse(`${next.day}T15:00:00Z`)) !== bars[i].day) continue;
    if (!stockSignal(bars, closes, i, rule, entry ? i - entry.i + 1 : null)) continue;
    if (entry) {
      const grossBps = Math.round((next.bidOpen / bars[entry.i].bidOpen - 1) * 10_000 * 10) / 10;
      const opened = bars[entry.i];
      const spreadBps = (opened.askOpen - opened.bidOpen) / opened.askOpen * 10_000;
      output.push({ symbol, rule, day: opened.day, closed: next.day, regime: entry.phase, grossBps, spreadBps: Number(spreadBps.toFixed(4)),
        nights: bars.slice(entry.i, i + 1).reduce((days, bar) => days + replayNights(bar.day), 0) });
      entry = null;
    } else {
      const phase = regime.get(next.day);
      if (phase && (next.askOpen - next.bidOpen) / next.askOpen <= 0.003) entry = { i: i + 1, phase };
    }
  }
  return output;
}

const trades = STOCK_TRADE_SYMBOLS.flatMap(symbol => {
  const bars = load(symbol);
  return (['breakout', 'pullback', 'inside-day'] as const).filter(rule => supportsStockTradeRule(rule, symbol))
    .flatMap(rule => study(bars, symbol, rule));
});
writeFileSync('lib/stocks/edge-evidence.json', JSON.stringify({ from: '2026-01-01', through: '2026-11-20', trades }, null, 2) + '\n');
console.log(`${trades.length} completed rule trades across ${new Set(trades.map(trade => trade.symbol)).size} symbols`);
