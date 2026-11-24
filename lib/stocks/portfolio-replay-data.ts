import { loadEarningsReplay } from './backtest';
import type { EtoroClient } from './etoro';
import { regularStockSessions } from './intraday';
import type { StockPortfolioInput } from './portfolio-replay';
import { regularDailyBars } from './trade-signals';
import { STOCK_INSTRUMENTS, supportsStockTradeRule, type StockTradeRule, type StockTradeSymbol } from './trade-rules';

const DAY = 86_400_000;

export async function loadPortfolioReplayMarket(broker: EtoroClient, symbol: StockTradeSymbol, rules: StockTradeRule[], from: string, to: string, requireStopPath: boolean, dailyWarmupDays = 185): Promise<StockPortfolioInput> {
  const end = Date.parse(to) + DAY + 15 * 3_600_000;
  const days = Math.ceil((end - Date.parse(from)) / DAY);
  const id = STOCK_INSTRUMENTS[symbol];
  const active = rules.filter(rule => supportsStockTradeRule(rule, symbol));
  const includeDaily = symbol === 'SPY' || active.includes('breakout') || active.includes('pullback');
  const includeInside = active.includes('inside-day');
  const includeEvents = active.includes('earnings-rebound');
  const [daily, regular, events] = await Promise.all([
    includeDaily ? broker.candles(id, days + dailyWarmupDays, end, true, false, 15_000) : [],
    includeInside ? Promise.all([
      broker.intradayCandles(id, end - Math.max(125, days + 105) * DAY, end - 120 * DAY, undefined, '30m', false, 15_000),
      broker.intradayCandles(id, end - 120 * DAY, end, undefined, '30m', false, 15_000),
    ]).then(chunks => regularDailyBars(regularStockSessions(chunks.flat(), 30).sessions).filter(bar => bar.day <= to)) : [],
    includeEvents ? loadEarningsReplay(broker, id, symbol, end, days, requireStopPath) : null,
  ]);
  return { symbol, daily: daily.filter(bar => bar.day <= to), regular,
    events: events?.trades.filter(trade => trade.day >= from && trade.day <= to) ?? [], missingEvents: events?.missing ?? 0 };
}
