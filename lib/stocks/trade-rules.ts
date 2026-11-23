import { STOCKS, STOCK_RULES } from './research';

export const STOCK_TRADE_SYMBOLS = [...STOCKS, 'AMD', 'AVGO', 'BA', 'CAT', 'LLY', 'MU', 'PLTR'] as const;
export type StockTradeSymbol = typeof STOCK_TRADE_SYMBOLS[number];
// Exact eToro US listings, resolved by ticker on the broker's instrument search.
export const STOCK_INSTRUMENTS: Record<StockTradeSymbol, number> = {
  AAPL: 1001, MSFT: 1004, NVDA: 1137, AMZN: 1005, GOOGL: 6434, META: 1003, TSLA: 1111, JPM: 1023,
  XOM: 1036, WMT: 1035, COST: 1461, UNH: 1032, SPY: 3000, AMD: 1832, AVGO: 4236, BA: 1010,
  CAT: 1012, LLY: 1567, MU: 1130, PLTR: 7991,
};
export const INSIDE_DAY_SYMBOLS = STOCK_TRADE_SYMBOLS.filter(symbol => !['SPY', 'UNH', 'COST'].includes(symbol));

export const INSIDE_BREAKOUT = {
  id: 'inside-day',
  name: 'Inside-day breakout',
  description: 'Buy the next session after a breakout above an inside day in a rising trend. Exit below the 10-session average or after five sessions.',
} as const;

export const EARNINGS_REBOUND = {
  id: 'earnings-rebound',
  name: 'Earnings gap-down rebound',
  description: 'Look for a stock down at least 1% versus SPY after a qualifying earnings filing. Entry around 10 a.m. ET, with an exit before the close.',
} as const;

export const STOCK_TRADE_RULES = [
  ...STOCK_RULES.map(rule => ({ id: rule.id, name: rule.name, description: rule.entry })),
  INSIDE_BREAKOUT, EARNINGS_REBOUND,
] as const;

export type StockTradeRule = typeof STOCK_TRADE_RULES[number]['id'];
export const STOCK_EXIT_LABELS: Record<StockTradeRule, string> = {
  breakout: STOCK_RULES[0].exit,
  pullback: STOCK_RULES[1].exit,
  'inside-day': 'Close below the 10-session average or after five sessions',
  'earnings-rebound': 'Scheduled exit at 3:50 p.m. ET',
};

export function isStockTradeRule(id: unknown): id is StockTradeRule {
  return STOCK_TRADE_RULES.some(rule => rule.id === id);
}

export function isStockTradeSymbol(symbol: unknown): symbol is StockTradeSymbol {
  return STOCK_TRADE_SYMBOLS.some(ticker => ticker === symbol);
}

export function supportsStockTradeRule(id: StockTradeRule, symbol: StockTradeSymbol) {
  if (id === INSIDE_BREAKOUT.id) return INSIDE_DAY_SYMBOLS.includes(symbol);
  if (id === EARNINGS_REBOUND.id) return symbol !== 'SPY';
  return true;
}
