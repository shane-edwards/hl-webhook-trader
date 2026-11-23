import type { EtoroClient, IntradayBar } from './etoro';
import { earningsBeforeOpen, type EarningsFiling } from './factor-research';
import { regularStockSessions } from './intraday';
import { researchStock, type StockReplayCost } from './research';
import { previousStockSession, stockMarketClock } from './session';
import { earningsRebound, recentEarnings, regularDailyBars } from './trade-signals';
import type { StockTradeRule, StockTradeSymbol } from './trade-rules';

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;
const CAPITAL = 10_000;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
const dayAnchor = (day: string) => Date.parse(`${day}T15:00:00Z`);

type EarningsWindow = { day: string; open: number; previousOpen: number };
type EarningsTrade = { day: string; ask: number; bid: number };

function openingTime(day: string) {
  const anchor = dayAnchor(day);
  return anchor + (570 - stockMarketClock(anchor).minutes) * MINUTE;
}

export function earningsReplayWindows(filings: EarningsFiling[], from: string, through: string) {
  const windows: EarningsWindow[] = [];
  for (let t = dayAnchor(from); date(t) <= through; t += DAY) {
    const clock = stockMarketClock(t);
    if (!clock.tradingDay || clock.close !== 960) continue;
    const prior = previousStockSession(t);
    if (!prior || stockMarketClock(dayAnchor(prior)).close !== 960) continue;
    const open = openingTime(clock.day);
    const previousOpen = openingTime(prior);
    if (earningsBeforeOpen(filings, previousOpen + 390 * MINUTE, open)) {
      windows.push({ day: clock.day, open, previousOpen });
    }
  }
  return windows;
}

export function earningsReplayFill(signal: ReturnType<typeof earningsRebound>, quotes: IntradayBar[], window: EarningsWindow): EarningsTrade | null {
  if (!signal?.exitAt) return null;
  const entry = quotes.find(bar => bar.t === window.open + 30 * MINUTE);
  const exit = quotes.find(bar => bar.t === signal.exitAt);
  if (!entry || !exit || (entry.askOpen - entry.bidOpen) / entry.askOpen > signal.maxSpread) return null;
  return { day: window.day, ask: entry.askOpen, bid: exit.bidOpen };
}

function simulateEarnings(trades: EarningsTrade[], cost: StockReplayCost) {
  let cash = CAPITAL, peak = CAPITAL, drawdown = 0, wins = 0;
  const slip = cost.slipBps / 10_000;
  const rows = trades.map(trade => {
    const before = cash;
    const units = Math.max(0, before - cost.commission) / (trade.ask * (1 + slip));
    cash = Math.max(0, units * trade.bid * (1 - slip) - cost.commission);
    if (cash > before) wins++;
    peak = Math.max(cash, peak);
    drawdown = Math.max(drawdown, 1 - cash / peak);
    return { ...trade, equity: cash, pnl: cash - before };
  });
  return { return: cash / CAPITAL - 1, drawdown, wins, trades: rows.length, rows };
}

async function backtestEarnings(broker: EtoroClient, instrumentId: number, symbol: StockTradeSymbol, cost: StockReplayCost, now: number) {
  // The exchange calendar is verified from 2025. Exclude the current New York date.
  const from = date(Math.max(Date.parse('2025-01-01'), now - 540 * DAY));
  const to = date(dayAnchor(stockMarketClock(now).day) - DAY);
  const filings = await recentEarnings(symbol);
  const windows = earningsReplayWindows(filings, from, to);
  const spy = windows.length ? await broker.instrument('SPY') : null;
  if (windows.length && !spy) throw new Error('SPY benchmark unavailable');
  const trades: EarningsTrade[] = [];
  let missing = 0;

  for (let start = 0; start < windows.length; start += 3) {
    const batch = await Promise.all(windows.slice(start, start + 3).map(async window => {
      const entryAt = window.open + 30 * MINUTE;
      const [stock, market] = await Promise.all([
        broker.intradayCandles(instrumentId, window.previousOpen, entryAt, undefined, '30m'),
        broker.intradayCandles(spy!.instrumentId, window.previousOpen, entryAt, undefined, '30m'),
      ]);
      // One full prior session and the 9:30 opening bar are required by the live rule.
      const complete = (bars: IntradayBar[]) => bars.some(bar => bar.t === window.open)
        && regularStockSessions(bars.filter(bar => bar.t < window.open), 30).sessions.some(session => session.bars[0]?.t === window.previousOpen);
      if (!complete(stock) || !complete(market)) return { missing: true };
      const signal = earningsRebound(stock, market, filings, entryAt);
      if (!signal?.exitAt) return {};
      const prices = await broker.intradayCandles(instrumentId, entryAt, signal.exitAt + 5 * MINUTE);
      if (!prices.some(bar => bar.t === entryAt) || !prices.some(bar => bar.t === signal.exitAt)) return { missing: true };
      return { trade: earningsReplayFill(signal, prices, window) };
    }));
    for (const row of batch) {
      if (row.missing) missing++;
      if (row.trade) trades.push(row.trade);
    }
  }

  const startDay = Date.parse(from);
  const holdoutFrom = date(startDay + Math.floor((Date.parse(to) - startDay) / DAY * 0.7) * DAY);
  const full = simulateEarnings(trades, cost);
  const earlier = simulateEarnings(trades.filter(trade => trade.day < holdoutFrom), cost);
  const holdout = trades.filter(trade => trade.day >= holdoutFrom);
  const later = simulateEarnings(holdout, cost);
  const stress = simulateEarnings(holdout, { slipBps: cost.slipBps * 2, commission: cost.commission * 2 });
  const series = [
    { day: from, equity: CAPITAL },
    ...full.rows.map(row => ({ day: row.day, equity: row.equity })),
    { day: to, equity: full.rows.at(-1)?.equity ?? CAPITAL },
  ];
  return {
    kind: 'earnings' as const, from, to, holdoutFrom, return: full.return, hold: null, drawdown: full.drawdown,
    trades: full.trades, wins: full.wins, earlyReturn: earlier.return, holdoutReturn: later.return, holdoutHold: null,
    holdoutTrades: later.trades, stressReturn: stress.return, series, windows: windows.length, missing, rows: full.rows,
  };
}

export async function stockBacktest(broker: EtoroClient, symbol: StockTradeSymbol, instrumentId: number, rule: StockTradeRule, cost: StockReplayCost, now = Date.now()) {
  if (rule === 'earnings-rebound') return backtestEarnings(broker, instrumentId, symbol, cost, now);
  if (rule !== 'inside-day') {
    const result = researchStock(await broker.candles(instrumentId, 1800, now), rule, cost);
    return result && { kind: 'daily' as const, ...result };
  }

  const lastBar = Math.floor(now / (30 * MINUTE)) * 30 * MINUTE;
  const bars: IntradayBar[] = [];
  for (let block = 0; block < 6; block += 2) {
    const chunks = await Promise.all([block, block + 1].map(index => {
      const end = lastBar - index * 60 * DAY;
      return broker.intradayCandles(instrumentId, end - 60 * DAY, end, undefined, '30m');
    }));
    for (const chunk of chunks) bars.push(...chunk);
  }
  const today = stockMarketClock(now).day;
  const sessions = regularStockSessions(bars, 30).sessions.filter(session => session.day < today);
  const result = researchStock(regularDailyBars(sessions), rule, cost, (prev, current) =>
    previousStockSession(dayAnchor(current.day)) === prev.day && (current.askOpen - current.bidOpen) / current.askOpen <= 0.003);
  return result && { kind: 'daily' as const, ...result };
}

export type StockBacktestResult = NonNullable<Awaited<ReturnType<typeof stockBacktest>>>;
