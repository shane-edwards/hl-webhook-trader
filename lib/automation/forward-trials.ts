import type { Evidence } from './model';

export type TrialFill = { entry: number; exit: number; net: number };
export type NamedTrial = {
  version: string; started: number; checked: number; admission: 'passed' | 'sample';
  fills: TrialFill[]; equity: number; drawdown: number; state: 'tracking' | 'completed' | 'stopped' | 'data-gap';
};

export function trialAdmission(e: Evidence) {
  if (e.qualified) return 'passed' as const;
  if (e.reason === 'Too few closed trades' && e.holdoutTrades > 0 && e.trades > e.holdoutTrades &&
      e.early > 0 && e.later > 0 && e.stress > Math.max(0, e.benchmark) && e.drawdown <= .12) return 'sample' as const;
  return null;
}

export function updateTrial(e: Evidence, previous: NamedTrial | null, observed: TrialFill[], availableFrom: number, through: number, now: number): NamedTrial | null {
  const admission = trialAdmission(e);
  if (!previous || previous.version !== e.version) return admission ? { version: e.version, started: now, checked: now,
    admission, fills: [], equity: 1, drawdown: 0, state: 'tracking' } : null;
  if (previous.state === 'completed' || previous.state === 'stopped' || through <= previous.checked) return previous;
  if (availableFrom > previous.checked) return { ...previous, state: 'data-gap' };
  const fills = [...previous.fills];
  let equity = 1, peak = 1, drawdown = 0;
  const mark = (net: number) => {
    equity *= 1 + net;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  };
  for (const fill of fills) mark(fill.net);
  for (const fill of observed) {
    if (fill.entry <= previous.started || fill.entry <= (fills.at(-1)?.exit ?? 0) || fill.exit > through ||
        fill.exit < fill.entry || !Number.isFinite(fill.net)) continue;
    fills.push(fill);
    mark(fill.net);
    if (fills.length >= 30 || drawdown > .16) break;
  }
  return { ...previous, checked: through, fills, equity, drawdown,
    state: drawdown > .16 ? 'stopped' : fills.length >= 30 ? 'completed' : 'tracking' };
}
