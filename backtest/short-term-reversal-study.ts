import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETF_DIR, ETF_NAMES, RESERVATION_ETFS } from './intraday-etf-data';
import { SWING_COINS, swingData } from './crypto-swing-data';
import type { StockBar } from '../lib/stocks/research';

type Bar = { day: string; open: number; close: number; high: number; low: number; ask: number; pay: number; receive: number };
type Market = { symbol: string; bars: Bar[] };
type Period = [string, string];
type Rule = { side: 1 | -1; rsi: number; maxHold: number; exitOnAverage: boolean; filterLength: number };
type Mark = { date: string; pnl: number };
const day = 86_400_000;
const stockPeriods: Period[] = [['2023-03-01', '2025-01-01'], ['2025-01-01', '2026-01-01'], ['2026-01-01', '2026-11-21']];
const perpPeriods: Period[] = [['2021-09-01', '2024-01-01'], ['2024-01-01', '2025-01-01'], ['2025-01-01', '2026-11-01']];

function indicators(bars: Bar[], period: number) {
  let rises = 0, falls = 0, slow = 0, fast = 0;
  const avg = [], quick = [], rsi = [];
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].close;
    slow += close - (i >= period ? bars[i - period].close : 0);
    fast += close - (i >= 5 ? bars[i - 5].close : 0);
    const change = i > 0 ? close - bars[i - 1].close : 0;
    rises += (Math.max(0, change) - rises) / 2;
    falls += (Math.max(0, -change) - falls) / 2;
    avg.push(slow / Math.min(period, i + 1));
    quick.push(fast / Math.min(5, i + 1));
    rsi.push(rises + falls > 0 ? 100 * rises / (rises + falls) : 50);
  }
  return { avg, quick, rsi };
}

function replay(bars: Bar[], rule: Rule, [from, to]: Period, fees: number) {
  const ind = indicators(bars, rule.filterLength);
  const marks: Mark[] = [], trades: Mark[] = [];
  const side = rule.side;
  let equity = 1, entry: { at: number; price: number; capital: number; prior: number; financing: number } | null = null;
  for (let i = rule.filterLength + 1; i < bars.length; i++) {
    const b = bars[i], last = bars[i - 1];
    if (b.day < from) continue;
    if (b.day >= to) break;
    const closingPeriod = !bars[i + 1] || bars[i + 1].day >= to;
    const current = entry;
    if (!current && !closingPeriod && side * (last.close - ind.avg[i - 1]) > 0 &&
      (side === 1 ? ind.rsi[i - 1] <= rule.rsi : ind.rsi[i - 1] >= 100 - rule.rsi)) {
      const price = (side === 1 ? b.ask : b.open) * (1 + side * fees);
      entry = { at: i, price, capital: equity, prior: 0, financing: 0 };
    }
    if (!entry) continue;
    const stop = entry.price * (1 - side * .075);
    const planned = closingPeriod || i - entry.at >= rule.maxHold ||
      (i > entry.at && rule.exitOnAverage && side * (last.close - ind.quick[i - 1]) > 0);
    const hitOpen = side * (b.open - stop) <= 0;
    const hitBar = !planned && (side === 1 ? b.low <= stop : b.high >= stop);
    const exit = planned || hitOpen || hitBar;
    // At the open, an existing position may incur the first scheduled funding. For held days charge observed
    // pay rates at the daily high and credit rates at the low. No assumed exchange rebates.
    if (!planned && !hitOpen) {
      entry.financing += side === 1 ? (b.pay * b.high - (hitBar ? 0 : b.receive * b.low)) / entry.price :
        (b.receive * b.high - (hitBar ? 0 : b.pay * b.low)) / entry.price;
    }
    const raw = planned || hitOpen ? side === 1 ? b.open : b.ask : hitBar ? stop : b.close;
    const pnl = side * (raw * (1 - side * (fees + (hitBar || hitOpen ? .001 : 0))) / entry.price - 1) - entry.financing;
    const movement = entry.capital * (pnl - entry.prior);
    marks.push({ date: b.day, pnl: movement });
    equity += movement;
    entry.prior = pnl;
    if (exit) { trades.push({ date: b.day, pnl }); entry = null; }
    if (equity <= 0) break;
  }
  return { marks, trades };
}

function metrics(results: ReturnType<typeof replay>[], [from, to]: Period) {
  const daily = new Map<string, number>();
  for (const row of results) for (const mark of row.marks) daily.set(mark.date, (daily.get(mark.date) ?? 0) + mark.pnl / results.length);
  const weeks = new Float64Array(Math.ceil((Date.parse(to) - Date.parse(from)) / (7 * day)));
  let total = 1, peak = 1, dd = 0;
  for (const [date, pnl] of [...daily].sort(([a], [b]) => a.localeCompare(b))) {
    total += pnl; peak = Math.max(peak, total); dd = Math.max(dd, 1 - total / peak);
    weeks[Math.floor((Date.parse(date) - Date.parse(from)) / (7 * day))] += pnl;
  }
  const m = weeks.reduce((a, b) => a + b, 0) / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, x) => sum + (x - m) ** 2, 0) / (weeks.length - 1) / weeks.length);
  const trades = results.flatMap(row => row.trades);
  return { net: total - 1, drawdown: dd, score: error ? m / error : 0, trades: trades.length, dates: new Set(trades.map(trade => trade.date)).size,
    averageBps: trades.length ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length * 10_000 : null,
    positiveMarkets: results.filter(row => row.trades.reduce((sum, trade) => sum + trade.pnl, 0) > 0).length };
}

function research(markets: Market[], periods: Period[], sides: Rule['side'][], cost: number[]) {
  const rules: Rule[] = sides.flatMap(side => [5, 10, 15].flatMap(rsi => [3, 5, 8].flatMap(maxHold =>
    [true, false].flatMap(exitOnAverage => [100, 200].map(filterLength => ({ rsi, side, maxHold, exitOnAverage, filterLength }))))));
  const contest = rules.map(rule => {
    const score = (n: number, stress: boolean) => metrics(markets.map(market => replay(market.bars, rule, periods[n], cost[Number(stress)])), periods[n]);
    const first = score(0, false), second = score(1, true);
    return { rule, first, second, rank: Math.min(first.score, second.score), score };
  }).sort((a, b) => b.rank - a.rank);
  const picks = sides.flatMap(side => {
    const selected = contest.find(x => x.rule.side === side && [x.first, x.second].every(r => r.net > 0 && r.trades >= 32 &&
      r.positiveMarkets >= Math.ceil(markets.length / 2) && r.drawdown <= .20 && r.score >= 1.25));
    if (!selected) return [];
    const holdout = selected.score(2, false), stressed = selected.score(2, true);
    const { rule, first, second } = selected;
    return [{ rule, first, second, holdout, stressed,
      passes: stressed.net > 0 && stressed.score >= 2.3 && stressed.trades >= 30 && stressed.positiveMarkets >= Math.ceil(markets.length / 2) &&
        stressed.drawdown <= .20 }];
  });
  return { tested: rules.length, markets: markets.map(row => row.symbol), periods, picks,
    diagnostic: contest.slice(0, 2).map(({ rule, first, second, rank }) => ({ rule, first, second, rank })) };
}

function readEtf(symbols: readonly string[]): Market[] {
  return symbols.flatMap(symbol => {
    const file = join(ETF_DIR, `${symbol}.json`);
    if (!existsSync(file)) return [];
    const entry = JSON.parse(readFileSync(file, 'utf8')) as { daily: StockBar[] };
    return [{ symbol, bars: entry.daily.map(x => ({ day: x.day, open: x.bidOpen, ask: x.askOpen,
      close: x.bidClose, high: x.high, low: x.low, pay: 0, receive: 0 })) }];
  });
}

function replicate(stock: Market[], outside: Market[]) {
  if (outside.length < 9) return null;
  // Freeze the highest-ranked early diagnostic before reading later returns. Use the wider ticker group
  // to test the sample-size shortfall from the original ETF group without lowering its trade threshold.
  const rule: Rule = { rsi: 5, side: 1, maxHold: 5, exitOnAverage: false, filterLength: 200 };
  const compute = (markets: Market[], period: Period) => metrics(markets.map(market => replay(market.bars, rule, period, .00065)), period);
  const validation = compute(outside, stockPeriods[1]);
  const enough = (row: ReturnType<typeof compute>) => row.net > 0 && row.score >= 2 && row.trades >= 32 && row.dates >= 16 &&
    row.positiveMarkets >= 6 && row.drawdown <= .16;
  const holdout = enough(validation) ? compute(stock, stockPeriods[2]) : null;
  const reserveHoldout = enough(validation) ? compute(outside, stockPeriods[2]) : null;
  const passes = enough(validation) && !!holdout && !!reserveHoldout && holdout.net > 0 && enough(reserveHoldout);
  return { rule, reserve: outside.map(market => market.symbol), validation, holdout, reserveHoldout, passes };
}

async function main() {
  const stocks = readEtf(ETF_NAMES);
  const ready = await Promise.allSettled(SWING_COINS.map(async symbol => ({ symbol, bars: (await swingData(symbol)).map(x => ({
    day: new Date(x.t).toISOString().slice(0, 10), open: x.o, ask: x.o, close: x.c, high: x.h, low: x.l, pay: x.pay, receive: x.receive,
  })) })));
  const perps = ready.flatMap(item => item.status === 'fulfilled' ? [item.value] : []);
  if (stocks.length < 6 || perps.length < 5) throw new Error('Missing market series for the short-term reversal study.');
  const result = { stocks: research(stocks, stockPeriods, [1], [.00025, .00065]),
    crypto: research(perps, perpPeriods, [1, -1], [.00085, .0015]),
    independentEtf: replicate(stocks, readEtf(RESERVATION_ETFS)) };
  writeFileSync(join(process.cwd(), 'backtest', 'short-term-reversal-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
