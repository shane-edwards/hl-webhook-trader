import { sma } from '@/lib/strategy/trend';
import { replayEntry, replayExit, replayNights, replayStop, stockReplayCosts, STOCK_REPLAY_CAPITAL as START, type StockReplayCost } from './replay';
export type { StockReplayCost } from './replay';

export const STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'WMT', 'COST', 'UNH', 'SPY'] as const;
export type StockSymbol = typeof STOCKS[number];
export type StockBar = { day: string; bidOpen: number; askOpen: number; bidClose: number; high: number; low: number;
  askHigh?: number; askLow?: number; askClose?: number };
export const STOCK_RULES = [
  { id: 'breakout', name: '20-session breakout', entry: 'Close above the previous 20-session high and the 100-session average', exit: 'Close below the previous 10-session low' },
  { id: 'pullback', name: 'Trend pullback', entry: 'Close reclaims its five-session average while above the 50-session average', exit: 'Close below the five-session average or hold 10 sessions' },
] as const;
export type StockRule = typeof STOCK_RULES[number]['id'];
export type DailyStockRule = StockRule | 'inside-day';

export function stockSignal(bars: StockBar[], closes: number[], i: number, rule: DailyStockRule, held: number | null) {
  if (rule === 'inside-day') {
    if (i < 50) return false;
    const close = closes[i];
    if (held != null) return close < sma(closes, 10, i) || held >= 5;
    const inside = bars[i - 1];
    const prior = bars[i - 2];
    return close > sma(closes, 50, i) && inside.high < prior.high && inside.low > prior.low && close > inside.high;
  }
  if (i < 100) return false;
  const close = closes[i];
  if (rule === 'breakout') {
    if (held != null) return close < Math.min(...bars.slice(i - 10, i).map(bar => bar.low));
    return close > sma(closes, 100, i) && close > Math.max(...bars.slice(i - 20, i).map(bar => bar.high));
  }
  const fast = sma(closes, 5, i);
  if (held != null) return close < fast || held >= 10;
  return close > sma(closes, 50, i) && close > fast && closes[i - 1] <= sma(closes, 5, i - 1);
}

export function stockSetups(bars: StockBar[]) {
  const i = bars.length - 1;
  if (i < 100) return null;
  const closes = bars.map(bar => bar.bidClose);
  return {
    day: bars[i].day, close: closes[i], average50: sma(closes, 50, i),
    rangeHigh: Math.max(...bars.slice(i - 20, i).map(bar => bar.high)),
    setups: STOCK_RULES.filter(rule => stockSignal(bars, closes, i, rule.id, null)).map(rule => rule.id),
  };
}

function simulate(bars: StockBar[], rule: DailyStockRule, start: number, end: number, cost: StockReplayCost, canEnter?: (previous: StockBar, current: StockBar) => boolean) {
  const closes = bars.map(bar => bar.bidClose);
  let cash = START, entryIndex = -1, entryCash = 0, trades = 0, wins = 0, stops = 0, financing = 0, skipped = 0;
  let position: ReturnType<typeof replayEntry> = null;
  let pending: 'buy' | 'sell' | null = null;
  let peak = START, drawdown = 0;
  const series = [];
  for (let i = start; i < end; i++) {
    const bar = bars[i];
    if (pending === 'buy' && i < end - 1 && (!canEnter || canEnter(bars[i - 1], bar))) {
      entryCash = cash;
      entryIndex = i;
      position = replayEntry(cash, bar.askOpen, bar.bidOpen, cost);
      if (!position) skipped++;
    }
    if (position) {
      const stop = pending === 'sell' ? null : replayStop(position.stop, bar.bidOpen, bar.low);
      const exit = pending === 'sell' ? bar.bidOpen : stop ?? (i === end - 1 ? bar.bidClose : null);
      if (exit != null) {
        cash = replayExit(position, exit, cost);
        stops += Number(stop != null);
        wins += Number(cash > entryCash);
        trades++;
        position = null;
      }
    }
    if (position) {
      const fee = position.nightlyFee * replayNights(bar.day);
      position.cash -= fee;
      financing += fee;
    }
    const triggered = stockSignal(bars, closes, i, rule, position ? i - entryIndex + 1 : null);
    pending = triggered ? position ? 'sell' : 'buy' : null;
    const equity = position ? replayExit(position, bar.bidClose, cost) : cash;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    series.push({ day: bar.day, equity });
  }
  const baseline = replayEntry(START, bars[start].askOpen, bars[start].bidOpen, { slipBps: cost.slipBps, commission: cost.commission })!;
  return { return: cash / START - 1, hold: replayExit(baseline, bars[end - 1].bidClose, cost) / START - 1, drawdown, trades, wins, stops, financing, skipped, series };
}

export function researchStock(bars: StockBar[], rule: DailyStockRule, cost: StockReplayCost, canEnter?: (previous: StockBar, current: StockBar) => boolean) {
  const start = rule === 'inside-day' ? 50 : 100;
  if (bars.length < (rule === 'inside-day' ? 120 : 260)) return null;
  const split = start + Math.floor((bars.length - start) * 0.7);
  const result = simulate(bars, rule, start, bars.length, cost, canEnter);
  const first = simulate(bars, rule, start, split, cost, canEnter);
  const later = simulate(bars, rule, split, bars.length, cost, canEnter);
  const stress = simulate(bars, rule, split, bars.length, stockReplayCosts(cost), canEnter);
  return {
    ...result, from: bars[start].day, to: bars.at(-1)!.day, holdoutFrom: bars[split].day,
    earlyReturn: first.return, holdoutReturn: later.return, holdoutHold: later.hold, holdoutTrades: later.trades, stressReturn: stress.return,
  };
}
