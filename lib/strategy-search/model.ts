import { STOCK_TRADE_SYMBOLS } from '@/lib/stocks/trade-rules';

export const SEARCH_REVISION = 1;
export const BAR_MS = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const;
export type SearchFrame = keyof typeof BAR_MS;
export type SearchMarket = 'stocks' | 'crypto';
export const SEARCH_FRAMES = { stocks: ['5m', '30m', '1d'], crypto: ['5m', '15m', '1h', '4h', '1d'] } as const;
export const SEARCH_ASSETS = {
  stocks: STOCK_TRADE_SYMBOLS,
  crypto: ['BTC', 'ETH', 'SOL', 'XRP', 'LTC', 'BCH', 'BNB', 'XLM', 'ADA', 'TRX', 'LINK', 'ATOM', 'ETC', 'DOGE', 'DASH', 'ZEC', 'ALGO', 'AVAX'],
} as const;

export type SearchPair = { market: SearchMarket; symbol: string; frame: SearchFrame };
export const searchKey = ({ market, symbol, frame }: SearchPair) => `search:${market}:${symbol}:${frame}`;

export function searchPair(market: string | null, symbol: string | null, frame: string | null): SearchPair | null {
  if (market !== 'stocks' && market !== 'crypto') return null;
  const symbols: readonly string[] = SEARCH_ASSETS[market];
  const frames: readonly string[] = SEARCH_FRAMES[market];
  return symbol && frame && symbols.includes(symbol) && frames.includes(frame) ? { market, symbol, frame: frame as SearchFrame } : null;
}

export function pairFromKey(key: unknown): SearchPair | null {
  if (typeof key !== 'string') return null;
  const [prefix, market, symbol, frame, extra] = key.split(':');
  return prefix === 'search' && extra === undefined ? searchPair(market, symbol, frame) : null;
}

export const FAMILIES = {
  range: 'Price-range breakout', rsi: 'RSI recovery', vwap: 'VWAP reclaim',
  band: 'Bollinger Band recovery', macd: 'MACD crossover', squeeze: 'Volatility squeeze release', supertrend: 'Supertrend reversal',
} as const;
export type Family = keyof typeof FAMILIES;
export type Rule = { family: Family; setting: number; trend: number; volume: number; stop: number; reward: number; maxBars: number };
export type SearchBar = { t: number; o: number; h: number; l: number; c: number; v: number; ask?: number; session?: string; funding?: number };
export type Performance = { trades: number; groups: number; net: number; average: number; drawdown: number; score: number | null };
export type SearchReport = {
  revision: number; pair: SearchPair; source: string; bars: number; from: string; through: string;
  tried: number; validationPassed: number; testedOnLaterData: number; holdoutFrom: string;
  verdict: 'insufficient-history' | 'no-candidate' | 'holdout-failed' | 'venue-failed' | 'paper-candidate';
  rule: Rule | null; holdout: Performance | null; stress: Performance | null; venue: Performance | null;
  benchmark: number | null; note?: string;
};

export function scheduledPair(market: SearchMarket, day: string): SearchPair {
  const starter = market === 'stocks' ? ['AAPL', 'NVDA', 'SPY'] : ['BTC', 'ETH', 'SOL'];
  const list = starter.flatMap(symbol => SEARCH_FRAMES[market].map(frame => ({ market, symbol, frame })));
  const position = Math.floor(Date.parse(day) / 86_400_000) % list.length;
  return list[position];
}
