import { CRYPTO_RESEARCH_RULES, type AutomationMarket } from './model';
import type { SearchFrame, SearchPair } from '@/lib/strategy-search/model';

type IdeaRule = {
  market: AutomationMarket;
  rule: string;
  name: string;
  timeframe: string;
  symbols: readonly string[];
  executable: boolean;
  source?: string;
};

const openingPaper = 'https://www.ssrn.com/abstract=4729284';
const closingPaper = 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866';

export const IDEA_RULES: readonly IdeaRule[] = [
  { market: 'stocks', rule: 'orb-rvol', name: 'High-volume opening breakout', timeframe: '5 min', symbols: ['NVDA', 'AMD', 'AAPL', 'TSLA'], executable: false, source: openingPaper },
  { market: 'stocks', rule: 'close', name: 'Closing momentum', timeframe: '30 min', symbols: ['SPY'], executable: false, source: closingPaper },
  { market: 'stocks', rule: 'close-volume', name: 'High-volume closing momentum', timeframe: '30 min', symbols: ['SPY'], executable: false, source: closingPaper },
  { market: 'stocks', rule: 'vwap', name: 'VWAP reclaim', timeframe: '5 min', symbols: ['NVDA', 'AAPL', 'AMD', 'MSFT'], executable: false },
  { market: 'stocks', rule: 'inside-day', name: 'Inside-day breakout', timeframe: 'Swing', symbols: ['NVDA', 'AAPL', 'JPM', 'AMD'], executable: true },
  { market: 'stocks', rule: 'breakout', name: '20-session breakout', timeframe: 'Swing', symbols: ['AAPL', 'NVDA', 'JPM', 'MSFT'], executable: true },
  { market: 'stocks', rule: 'pullback', name: 'Trend pullback', timeframe: 'Swing', symbols: ['AAPL', 'NVDA', 'JPM', 'MSFT'], executable: true },
  ...CRYPTO_RESEARCH_RULES.map((rule): IdeaRule => ({
    market: 'crypto', rule, symbols: ['BTC', 'ETH', 'SOL'], executable: true,
    ...({ trend_breakout: { name: 'Trend breakout', timeframe: 'Swing' },
      trend_pullback: { name: 'Trend pullback', timeframe: 'Hours to days' },
      momentum_burst: { name: 'Momentum burst', timeframe: 'Up to 6 hours' } }[rule]),
  })).sort((a, b) => a.rule === 'momentum_burst' ? -1 : b.rule === 'momentum_burst' ? 1 : 0),
];

export type StrategyIdea = IdeaRule & { id: string; symbol: string };

export function ideaId(market: AutomationMarket, rule: string, symbol: string) {
  return `${market}:${rule}:${symbol}`;
}

export function ideaSearchFrame(idea: IdeaRule): SearchFrame {
  if (idea.market === 'crypto') return '1h';
  if (idea.executable) return '1d';
  return idea.rule === 'close' || idea.rule === 'close-volume' ? '30m' : '5m';
}

export function ideasForPair(pair: SearchPair) {
  return IDEA_RULES.filter(rule => rule.market === pair.market && rule.symbols.includes(pair.symbol) &&
    ideaSearchFrame(rule) === pair.frame);
}

export function findIdea(id: unknown): StrategyIdea | null {
  if (typeof id !== 'string') return null;
  const [market, rule, symbol, extra] = id.split(':');
  if (extra !== undefined) return null;
  const item = IDEA_RULES.find(row => row.market === market && row.rule === rule && row.symbols.includes(symbol));
  return item ? { ...item, id, symbol } : null;
}

export function versionedIdea(market: AutomationMarket, version: string | null | undefined) {
  if (!version) return null;
  const [, scope, symbol, rule, extra] = version.split('.');
  return scope === market && extra === undefined ? findIdea(ideaId(market, rule, symbol)) : null;
}
