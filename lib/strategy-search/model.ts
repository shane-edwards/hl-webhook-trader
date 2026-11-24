import { STOCK_TRADE_SYMBOLS } from '@/lib/stocks/trade-rules';

export const SEARCH_REVISION = 5;
// Increment when changing any signal, fill, funding or exit semantics for frozen rules.
export const RULE_INTERPRETER_VERSION = 1;
export const SEARCH_REFRESH_MS = 7 * 86_400_000;
export const SEARCH_RETRY_MS = 12 * 3_600_000;
export const RECOMMENDATION_FRESH_MS = 4 * 86_400_000;
export const BAR_MS = { '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 } as const;
export type SearchFrame = keyof typeof BAR_MS;
export type SearchMarket = 'stocks' | 'crypto';
export const searchRevision = (market: SearchMarket) => market === 'crypto' ? SEARCH_REVISION + 1 : SEARCH_REVISION;
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
export const SETUPS = {
  coil: 'Narrowest range in seven bars', washout: 'Two-range selloff', shelf: 'Three higher lows',
  pullback: 'Retracement in a rising trend', sweep: 'Rejected ten-bar low', impulse: 'Wide bullish impulse',
  balance: 'Inside bar', fade: 'Three falling closes',
} as const;
export const TRIGGERS = {
  midpoint: 'prior midpoint reclaim', engulf: 'engulfing reversal', channel: 'five-bar high break',
  thrust: 'strong close near the high', pivot: 'confirmed swing-high break', reclaim: 'ten-bar mean reclaim',
  acceleration: 'accelerating two-bar advance', outside: 'bullish outside bar',
} as const;
export type Recipe = { setup: keyof typeof SETUPS; trigger: keyof typeof TRIGGERS; within: number };
export type SearchSide = 'long' | 'short';
export type Rule = ({ family: Family; recipe?: never } | { family: 'sequence'; recipe: Recipe }) &
  { setting: number; trend: number; volume: number; stop: number; reward: number; maxBars: number; side?: SearchSide };
const SHORT_SETUPS: Record<Recipe['setup'], string> = {
  coil: 'Narrowest range in seven bars', washout: 'Two-range rally', shelf: 'Three lower highs',
  pullback: 'Bounce in a falling trend', sweep: 'Rejected ten-bar high', impulse: 'Wide bearish impulse',
  balance: 'Inside bar', fade: 'Three rising closes',
};
const SHORT_TRIGGERS: Record<Recipe['trigger'], string> = {
  midpoint: 'break below prior midpoint', engulf: 'bearish engulfing reversal', channel: 'five-bar low break',
  thrust: 'weak close near the low', pivot: 'confirmed swing-low break', reclaim: 'break below ten-bar mean',
  acceleration: 'accelerating two-bar decline', outside: 'bearish outside bar',
};
export function ruleName(rule: Rule) {
  if (rule.family !== 'sequence') return FAMILIES[rule.family];
  const short = rule.side === 'short';
  return `${(short ? SHORT_SETUPS : SETUPS)[rule.recipe.setup]} → ${(short ? SHORT_TRIGGERS : TRIGGERS)[rule.recipe.trigger]}`;
}
export function ruleKey(rule: Rule) {
  return [rule.side ?? 'long', rule.family, rule.recipe?.setup, rule.recipe?.trigger, rule.recipe?.within,
    rule.setting, rule.trend, rule.volume, rule.stop, rule.reward, rule.maxBars].join(':');
}
export type ForwardFill = { entry: number; exit: number; price: number; exitPrice: number; net: number };
export type ForwardBook = { version: number; rule: Rule; started: number; cursor: number; lastExit: number; count: number; equity: number;
  peak: number; drawdown: number; recent: ForwardFill[]; state: 'tracking' | 'data-gap' | 'stopped' | 'completed' | 'archived';
  pending?: { signal: number; entry: number; price: number; stop: number; target: number } };
export type SearchBar = { t: number; o: number; h: number; l: number; c: number; v: number; ask?: number; session?: string;
  askHigh?: number; askLow?: number; askClose?: number; funding?: number; shortFunding?: number };
export type Performance = { trades: number; groups: number; net: number; average: number; drawdown: number; score: number | null };
export type SearchOutcome = {
  verdict: 'insufficient-history' | 'no-candidate' | 'holdout-failed' | 'venue-failed' | 'paper-candidate';
  rule: Rule | null; holdout: Performance | null; stress: Performance | null; venue: Performance | null;
  benchmark: number | null; note?: string;
  robustness?: { delayed: Performance; lowerGroupReturn: number };
};
export type SearchReport = SearchOutcome & {
  revision: number; pair: SearchPair; source: string; bars: number; from: string; through: string;
  tried: number; validationPassed: number; testedOnLaterData: number; holdoutFrom: string; alternatives?: SearchOutcome[];
  generation?: { tried: number; validated: number; uniquePairs: number }; forward?: ForwardBook[];
};

export function searchOutcomes({ verdict, rule, holdout, stress, venue, benchmark, note, robustness, alternatives }: SearchReport): SearchOutcome[] {
  return [{ verdict, rule, holdout, stress, venue, benchmark, note, robustness }, ...(alternatives ?? [])];
}

export type SearchJob = { status: string; as_of: string; revision?: number | null };

export function searchDue(job: SearchJob | undefined, now: number, search: boolean, revision = SEARCH_REVISION) {
  if (!job) return true;
  if (job.status === 'queued' || job.status === 'running') return false;
  const age = now - Date.parse(job.as_of);
  if (job.status === 'failed') return age >= SEARCH_RETRY_MS;
  if (search && job.revision !== revision) return true;
  return age >= (search ? SEARCH_REFRESH_MS : RECOMMENDATION_FRESH_MS);
}

export function marketSearchPairs(market: SearchMarket): SearchPair[] {
  const core = market === 'stocks' ? ['AAPL', 'NVDA', 'SPY'] : ['BTC', 'ETH', 'SOL'];
  const frame = market === 'stocks' ? '1d' : '1h';
  const pairs = SEARCH_FRAMES[market].flatMap(frame => SEARCH_ASSETS[market].map(symbol => ({ market, symbol, frame })));
  return [...new Map([...core.map(symbol => ({ market, symbol, frame } satisfies SearchPair)), ...pairs]
    .map(pair => [searchKey(pair), pair])).values()];
}

export const isSearchMarket = (value: unknown): value is SearchMarket => value === 'stocks' || value === 'crypto';
