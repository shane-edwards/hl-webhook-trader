// Scoring trade ideas after the fact: did price reach the target or the stop
// first, and what was the return 1, 3 and 7 days later? Pure functions, shared
// by the live scorecard (lib/market-scan.ts) and the historical replay
// (backtest/suggestions.ts).
import type { Bar } from '@/lib/autopilot/strategies';

const HOUR = 3_600_000;

export interface Outcome {
  /** Which was touched first; null while neither has been. */
  outcome: 'target' | 'stop' | null;
  outcomeT: number | null;
  /** Return in the direction of the idea, percent; null until enough time has passed. */
  ret1d: number | null; ret3d: number | null; ret7d: number | null;
}

/**
 * `bars` are the hourly bars AFTER the idea was shown (oldest first). A bar
 * that touches both the stop and the target counts as the stop: the order
 * inside one bar is unknown, so the harsher reading is used.
 */
export function resolveOutcome(entry: number, dir: 1 | -1, stopPct: number, targetPct: number, shownAt: number, bars: Bar[]): Outcome {
  const stop = entry * (1 - (dir * stopPct) / 100), target = entry * (1 + (dir * targetPct) / 100);
  let outcome: Outcome['outcome'] = null, outcomeT: number | null = null;
  for (const b of bars) {
    const hitStop = dir === 1 ? b.l <= stop : b.h >= stop;
    const hitTarget = dir === 1 ? b.h >= target : b.l <= target;
    if (hitStop || hitTarget) { outcome = hitStop ? 'stop' : 'target'; outcomeT = b.t; break; }
  }
  const retAfter = (days: number) => {
    // The close of the last bar that ends within `days` of the idea.
    const cutoff = shownAt + days * 24 * HOUR;
    const b = [...bars].reverse().find(x => x.t + HOUR <= cutoff);
    const complete = bars.length > 0 && bars[bars.length - 1].t + HOUR >= cutoff;
    return b && complete ? (dir * (b.c / entry - 1)) * 100 : null;
  };
  return { outcome, outcomeT, ret1d: retAfter(1), ret3d: retAfter(3), ret7d: retAfter(7) };
}

export interface ScoredIdea {
  bias: 'long' | 'short'; strength: string; stopKind: 'level' | 'volatility';
  stopPct: number; targetPct: number;
  outcome: 'target' | 'stop' | 'neither' | null;
  ret1d: number | null; ret3d: number | null; ret7d: number | null;
}

export interface ScoreRow {
  group: string; ideas: number;
  /** Ideas where the target or the stop has been reached. */
  decided: number;
  /** Share of decided ideas that reached the target first, percent. */
  hitRate: number | null;
  /** Average result per decided idea in multiples of the amount risked (target = +target/stop, stop = -1). */
  avgR: number | null;
  avgRet1d: number | null; avgRet3d: number | null; avgRet7d: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function scoreGroup(group: string, ideas: ScoredIdea[]): ScoreRow {
  const decided = ideas.filter(i => i.outcome === 'target' || i.outcome === 'stop');
  const wins = decided.filter(i => i.outcome === 'target');
  const nums = (k: 'ret1d' | 'ret3d' | 'ret7d') => mean(ideas.map(i => i[k]).filter((x): x is number => x != null));
  return {
    group, ideas: ideas.length, decided: decided.length,
    hitRate: decided.length ? (wins.length / decided.length) * 100 : null,
    avgR: mean(decided.map(i => (i.outcome === 'target' ? i.targetPct / i.stopPct : -1))),
    avgRet1d: nums('ret1d'), avgRet3d: nums('ret3d'), avgRet7d: nums('ret7d'),
  };
}

/** The scorecard tables: overall, by direction, by strength and by where the stop came from. */
export function buildScorecard(ideas: ScoredIdea[]): ScoreRow[] {
  const pick = (label: string, f: (i: ScoredIdea) => boolean) => scoreGroup(label, ideas.filter(f));
  return [
    scoreGroup('All ideas', ideas),
    pick('Long', i => i.bias === 'long'), pick('Short', i => i.bias === 'short'),
    pick('Strong', i => i.strength === 'strong'), pick('Moderate', i => i.strength === 'moderate'),
    pick('Stop beyond a level', i => i.stopKind === 'level'), pick('Stop from volatility only', i => i.stopKind === 'volatility'),
  ];
}
