import { previousStockSession, stockMarketClock } from '@/lib/stocks/session';

export const AUTOMATION_MARKETS = ['stocks', 'crypto'] as const;
export type AutomationMarket = typeof AUTOMATION_MARKETS[number];
export type AutomationKind = 'daily' | 'weekly';
export type AutomationMode = 'research' | 'paper' | 'live';
export type AutomationProfile = { user_id: string; market: AutomationMarket; enabled: boolean; mode: AutomationMode; entries_paused: boolean;
  live_version: string | null; paper_version?: string | null; loss_budget_usd: number | null; max_order_usd: number | null; updated_at: string };
export const AUTOMATION_REVISION = 'edge-v1';
export const STOCK_RESEARCH_SYMBOLS = ['SPY', 'AAPL', 'NVDA', 'JPM'] as const;
export const CRYPTO_RESEARCH_SYMBOLS = ['BTC', 'ETH', 'SOL'] as const;
export const STOCK_RESEARCH_RULES = ['breakout', 'pullback', 'inside-day'] as const;
export const CRYPTO_RESEARCH_RULES = ['trend_breakout', 'trend_pullback', 'momentum_burst'] as const;
const dayMs = 86_400_000;
const hourMs = 3_600_000;
export const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

export type Evidence = { version: string; market: AutomationMarket; symbol: string; rule: string; name: string; trades: number;
  holdoutTrades: number; early: number; later: number; stress: number; benchmark: number; drawdown: number; from: string; through: string;
  qualified: boolean; reason: string };
export type RunReport = { evidence: Evidence[]; summary: string; data: { missing?: { symbol: string; detail?: string }[]; [key: string]: unknown } };

export function automationVersion(market: AutomationMarket, symbol: string, strategy: string) {
  return [AUTOMATION_REVISION, market, symbol, strategy].join('.');
}

export function studyEvidence(input: Omit<Evidence, 'version' | 'qualified' | 'reason'>): Evidence {
  const reason = input.trades < 24 || input.holdoutTrades < 8 ? 'Too few closed trades'
    : input.early <= 0 || input.later <= 0 ? 'Returns were uneven across periods'
    : input.stress <= Math.max(0, input.benchmark) ? 'Higher-cost results fell short of the benchmark'
    : input.drawdown > 0.12 ? 'Drawdown exceeded the research limit' : null;
  return { ...input, version: automationVersion(input.market, input.symbol, input.rule), qualified: reason == null,
    reason: reason ?? 'Passed the backtest and higher-cost checks' };
}

export function latestStockReplaySession(now: number) {
  const clock = stockMarketClock(now);
  return clock.tradingDay && clock.minutes >= clock.close ? clock.day : previousStockSession(now);
}

export function automationSchedule(market: AutomationMarket, now: number): { kind: AutomationKind; key: string; asOf: string }[] {
  const utc = new Date(now);
  const result: { kind: AutomationKind; key: string; asOf: string }[] = [];
  if (market === 'stocks') {
    const clock = stockMarketClock(now);
    if (clock.tradingDay && clock.minutes >= 17 * 60 + 15) {
      result.push({ kind: 'daily', key: clock.day, asOf: new Date(now).toISOString() });
    }
  } else if (utc.getUTCHours() > 0 || utc.getUTCMinutes() >= 15) {
    result.push({ kind: 'daily', key: isoDay(now), asOf: new Date(Math.floor(now / hourMs) * hourMs).toISOString() });
  }
  if (utc.getUTCDay() === 6 && utc.getUTCHours() >= 2) {
    result.push({ kind: 'weekly', key: isoDay(now), asOf: new Date(now).toISOString() });
  }
  return result;
}

export function researchWindow(now: number, market: AutomationMarket) {
  const to = market === 'stocks' ? latestStockReplaySession(now) : isoDay(now);
  if (!to) throw new Error('The last completed market session is unavailable.');
  return { from: isoDay(Date.parse(to) - 112 * dayMs), to };
}

export function paperThreshold(closes: { at: string; pnl: number }[]) {
  const recent = closes.filter(item => Number.isFinite(item.pnl) && Number.isFinite(Date.parse(item.at)))
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-30);
  let net = 0, peak = 0, drawdown = 0;
  for (const trade of recent) {
    net += trade.pnl;
    peak = Math.max(peak, net);
    drawdown = Math.max(drawdown, peak - net);
  }
  const days = new Set(recent.map(item => item.at.slice(0, 10))).size;
  return { closed: recent.length, days, net, drawdown, passed: recent.length >= 10 && days >= 5 && net > 0 && drawdown <= 100 };
}
