import evidence from './evidence.json';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from './strategies';

export const HOUR_MS = 3_600_000;
export const BARS_NEEDED = WARMUP_BARS + 30;

export function isLiveEligible(id: string, allowShort: boolean) {
  return evidence.accountingVersion === 2 && evidence.strategies.some(row => row.id === id && row.allowShort === allowShort && row.liveEligible);
}

export function strategyDirection(id: string, allowShort: boolean, useAllRules: boolean) {
  if (useAllRules) return allowShort;
  const shorts = allowShort && isLiveEligible(id, true);
  return isLiveEligible(id, shorts) ? shorts : null;
}

export function entrySignal(id: string, market: { bars: Bar[]; ind: ReturnType<typeof computeIndicators>; last: number }, now: number, allowShort: boolean) {
  const strategy = getStrategy(id);
  const bar = market.bars[market.last];
  if (!strategy || !bar || now < bar.t + HOUR_MS || now - (bar.t + HOUR_MS) > 2 * HOUR_MS) return null;
  const signal = strategy.evaluate(market.ind, market.bars, market.last, 0, allowShort);
  if (signal.target === 0) return null;
  return { ...signal, side: signal.target === 1 ? 'long' as const : 'short' as const, barT: bar.t };
}
