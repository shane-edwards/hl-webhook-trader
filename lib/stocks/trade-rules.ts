import { STOCKS, STOCK_RULES } from './research';

export const STOCK_TRADE_SYMBOLS = [...STOCKS, 'AMD', 'AVGO', 'BA', 'CAT', 'LLY', 'MU', 'PLTR'] as const;
export type StockTradeSymbol = typeof STOCK_TRADE_SYMBOLS[number];
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
