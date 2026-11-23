import { z } from 'zod';
import { STOCK_INSTRUMENTS, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, supportsStockTradeRule, type StockTradeSymbol } from './trade-rules';
import type { EtoroClient } from './etoro';

export const stockPortfolioSchema = z.object({
  symbols: z.array(z.enum(STOCK_TRADE_SYMBOLS)).min(1).max(STOCK_TRADE_SYMBOLS.length),
  strategies: z.array(z.enum(STOCK_TRADE_RULES.map(rule => rule.id))).min(1).max(STOCK_TRADE_RULES.length),
  maxExposure: z.number().min(1).max(1_000_000),
  maxGroup: z.number().min(1).max(1_000_000),
  maxPositions: z.number().int().min(1).max(10),
  dailyLoss: z.number().min(1).max(100_000),
  maxCostBps: z.number().min(1).max(200),
}).refine(settings => new Set(settings.symbols).size === settings.symbols.length
  && new Set(settings.strategies).size === settings.strategies.length && settings.maxGroup <= settings.maxExposure
  && settings.strategies.every(rule => settings.symbols.some(symbol => supportsStockTradeRule(rule, symbol))));

export type StockPortfolio = z.infer<typeof stockPortfolioSchema>;
type Book = Awaited<ReturnType<EtoroClient['portfolio']>>;

const groups: Record<StockTradeSymbol, string> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Semiconductors', AMZN: 'Consumer', GOOGL: 'Communications',
  META: 'Communications', TSLA: 'Consumer', JPM: 'Financials', XOM: 'Energy', WMT: 'Consumer', COST: 'Consumer',
  UNH: 'Healthcare', SPY: 'Broad market', AMD: 'Semiconductors', AVGO: 'Semiconductors', BA: 'Industrials',
  CAT: 'Industrials', LLY: 'Healthcare', MU: 'Semiconductors', PLTR: 'Technology',
};
const groupByInstrument = new Map(Object.entries(STOCK_INSTRUMENTS).map(([ticker, id]) => [id, groups[ticker as StockTradeSymbol]]));

export function stockPortfolioRisk(book: Book) {
  if (book.mirrors || book.pending || !Number.isFinite(book.credit)) return null;
  let equity = book.credit;
  let gross = 0;
  const positions = new Set<number>();
  const group = new Map<string, number>();
  for (const position of book.positions) {
    const { instrumentId, amount, leverage, pnl, side } = position;
    if (!Number.isSafeInteger(instrumentId) || !Number.isFinite(amount) || amount <= 0
        || !Number.isFinite(leverage) || leverage <= 0 || pnl == null || !Number.isFinite(pnl)) return null;
    // Never reduce measured risk because a position has moved against the account.
    const exposure = Math.max(amount * leverage, amount * leverage + (side === 'Long' ? pnl : -pnl));
    equity += amount + pnl;
    gross += exposure;
    positions.add(instrumentId);
    const key = groupByInstrument.get(instrumentId) ?? 'Other';
    group.set(key, (group.get(key) ?? 0) + exposure);
  }
  // SPY and unclassified positions may overlap any group.
  const overlappingExposure = (group.get('Other') ?? 0) + (group.get('Broad market') ?? 0);
  return { equity, gross, positions, group, overlappingExposure };
}

export function stockPortfolioEntry(settings: StockPortfolio, risk: NonNullable<ReturnType<typeof stockPortfolioRisk>>, instrumentId: number, exposure: number) {
  if (risk.positions.has(instrumentId)) return 'Ticker already held';
  if (risk.positions.size >= settings.maxPositions) return 'Position limit reached';
  if (risk.gross + exposure > settings.maxExposure) return 'Gross exposure limit';
  const group = groupByInstrument.get(instrumentId) ?? 'Other';
  const groupExposure = group === 'Broad market' ? Math.max(0, ...[...risk.group].filter(([key]) => !['Other', 'Broad market'].includes(key)).map(([, value]) => value))
    : risk.group.get(group) ?? 0;
  if (groupExposure + risk.overlappingExposure + exposure > settings.maxGroup) return 'Concentration limit';
  return null;
}
