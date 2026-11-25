import evidence from './evidence.json';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from './strategies';

export const HOUR_MS = 3_600_000;
export const BARS_NEEDED = WARMUP_BARS + 30;

export function isLiveEligible(id: string, allowShort: boolean) {
  return evidence.accountingVersion === 2 && evidence.strategies.some(row => row.id === id && row.allowShort === allowShort && row.liveEligible);
}

/**
 * Which sides a rule may enter: null = none, false = long only, true = long and short.
 * `useAllRules` is for Paper and for a manual entry the owner reviewed. Automatic Live entries
 * always pass false, so no setting or confirmation can widen them beyond the evidence file.
 */
export function strategyDirection(id: string, allowShort: boolean, useAllRules: boolean) {
  if (useAllRules) return allowShort;
  const shorts = allowShort && isLiveEligible(id, true);
  return isLiveEligible(id, shorts) ? shorts : null;
}

/** The selected rules that take automatic Live entries. Every other selected rule stays on Paper. */
export function liveRules(ids: string[], allowShort: boolean) {
  return ids.flatMap(id => {
    const shorts = strategyDirection(id, allowShort, false);
    return shorts === null ? [] : [{ id, shorts }];
  });
}

/** Why Live Autopilot cannot start with this selection, or null when at least one rule may trade. */
export function liveStartProblem(ids: string[], allowShort: boolean) {
  return liveRules(ids, allowShort).length ? null
    : 'None of the selected strategies has passed the backtest required for automatic Live entries. Select one marked Live eligible, or continue in Paper.';
}

export function entrySignal(id: string, market: { bars: Bar[]; ind: ReturnType<typeof computeIndicators>; last: number }, now: number, allowShort: boolean) {
  const strategy = getStrategy(id);
  const bar = market.bars[market.last];
  if (!strategy || !bar || now < bar.t + HOUR_MS || now - (bar.t + HOUR_MS) > 2 * HOUR_MS) return null;
  const signal = strategy.evaluate(market.ind, market.bars, market.last, 0, allowShort);
  if (signal.target === 0) return null;
  return { ...signal, side: signal.target === 1 ? 'long' as const : 'short' as const, barT: bar.t };
}
