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

// ---- predicted probability against what happened ----
// Each idea gets a predicted chance of reaching its target before its stop within the scoring week.
// The prediction uses only ideas whose result was already known when the new idea appeared, so it is
// always out of sample, and it is then scored against what the price did.

const WEEK = 7 * 24 * HOUR;
/** How many ideas' worth of weight the no-edge assumption carries before the record takes over. */
export const PRIOR_WEIGHT = 20;

export interface LoggedIdea {
  bias: 'long' | 'short'; strength: string;
  stopPct: number; targetPct: number;
  outcome: 'target' | 'stop' | 'neither' | null;
  resolved: boolean;
  createdAt: number;
  outcomeAt: number | null;
  /** The probability stored when the idea was logged, if it was. */
  predicted?: number | null;
}

/**
 * The chance of reaching the target first if the idea had no edge at all: a price with no drift
 * reaches a level in proportion to how close it is. The one-week limit only lowers the real figure.
 */
export function noEdgeProbability(stopPct: number, targetPct: number) {
  return stopPct > 0 && targetPct > 0 ? stopPct / (stopPct + targetPct) : null;
}

/** 1 if the target came first, 0 if the stop did or the week ran out, null while still open. */
export function ideaResult(idea: Pick<LoggedIdea, 'outcome' | 'resolved'>): 0 | 1 | null {
  if (idea.outcome === 'target') return 1;
  if (idea.outcome === 'stop' || (idea.outcome === 'neither' && idea.resolved)) return 0;
  return null;
}

/** When an idea's result became known, or null while it is still open. */
export function knownAt(idea: LoggedIdea): number | null {
  if (ideaResult(idea) == null) return null;
  return idea.outcome === 'neither' || idea.outcomeAt == null ? idea.createdAt + WEEK + HOUR : idea.outcomeAt + HOUR;
}

/**
 * Starts from the no-edge chance and moves by how much earlier ideas of the same direction and
 * strength beat or missed their own no-edge chance. With no record it is exactly the no-edge chance.
 */
export function predictProbability(idea: Pick<LoggedIdea, 'bias' | 'strength' | 'stopPct' | 'targetPct'>, history: LoggedIdea[], asOf: number) {
  const base = noEdgeProbability(idea.stopPct, idea.targetPct);
  if (base == null) return null;
  let sample = 0, excess = 0;
  for (const past of history) {
    if (past.bias !== idea.bias || past.strength !== idea.strength) continue;
    const known = knownAt(past), pastBase = noEdgeProbability(past.stopPct, past.targetPct);
    if (known == null || known > asOf || pastBase == null) continue;
    sample += 1;
    excess += ideaResult(past)! - pastBase;
  }
  const probability = Math.min(0.98, Math.max(0.02, base + excess / (sample + PRIOR_WEIGHT)));
  return { probability, sample };
}

export interface CalibrationBucket { label: string; ideas: number; predicted: number | null; actual: number | null }
export interface Calibration {
  /** Ideas with a known result and a prediction. */
  scored: number;
  /** How many of those had their prediction stored when logged; the rest are rebuilt from the earlier record. */
  stored: number;
  meanPredicted: number | null;
  hitRate: number | null;
  /** Mean squared gap between prediction and result: 0 is perfect, lower is better. */
  brier: number | null;
  /** The same score for always predicting the no-edge chance. */
  noEdgeBrier: number | null;
  /** 1 - brier / noEdgeBrier: above 0 means the predictions beat assuming no edge. */
  skill: number | null;
  buckets: CalibrationBucket[];
}

const BUCKETS: Array<[string, number]> = [['Under 30%', 0.3], ['30% to 40%', 0.4], ['40% to 50%', 0.5], ['50% to 60%', 0.6], ['60% and over', Infinity]];

export function buildCalibration(ideas: LoggedIdea[]): Calibration {
  const scored: Array<{ p: number; base: number; y: 0 | 1 }> = [];
  let stored = 0;
  for (const idea of ideas) {
    const y = ideaResult(idea), base = noEdgeProbability(idea.stopPct, idea.targetPct);
    if (y == null || base == null) continue;
    const kept = idea.predicted != null && idea.predicted >= 0 && idea.predicted <= 1 ? idea.predicted : null;
    const p = kept ?? predictProbability(idea, ideas, idea.createdAt)?.probability;
    if (p == null) continue;
    if (kept != null) stored += 1;
    scored.push({ p, base, y });
  }
  const brier = mean(scored.map(s => (s.p - s.y) ** 2)), noEdgeBrier = mean(scored.map(s => (s.base - s.y) ** 2));
  return {
    scored: scored.length, stored,
    meanPredicted: mean(scored.map(s => s.p)), hitRate: mean(scored.map(s => s.y)),
    brier, noEdgeBrier, skill: brier != null && noEdgeBrier ? 1 - brier / noEdgeBrier : null,
    buckets: BUCKETS.map(([label, top], i) => {
      const floor = i ? BUCKETS[i - 1][1] : -Infinity;
      const rows = scored.filter(s => s.p >= floor && s.p < top);
      return { label, ideas: rows.length, predicted: mean(rows.map(s => s.p)), actual: mean(rows.map(s => s.y)) };
    }),
  };
}

/** A row of `suggestion_log` as the calibration functions read it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loggedIdea(row: Record<string, any>): LoggedIdea {
  return {
    bias: row.bias, strength: row.strength, stopPct: Number(row.stop_pct), targetPct: Number(row.target_pct),
    outcome: row.outcome ?? null, resolved: row.resolved === true, createdAt: Date.parse(row.created_at),
    outcomeAt: row.outcome_at ? Date.parse(row.outcome_at) : null,
    predicted: row.predicted_prob == null ? null : Number(row.predicted_prob),
  };
}
