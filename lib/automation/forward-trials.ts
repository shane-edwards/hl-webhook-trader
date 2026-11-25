import type { Evidence } from './model';

export type TrialFill = { entry: number; exit: number; net: number };
export type NamedTrial = {
  version: string; started: number; checked: number; admission: 'passed' | 'sample' | 'exploratory';
  fills: TrialFill[]; count?: number; peak?: number; equity: number; drawdown: number; state: 'tracking' | 'completed' | 'stopped' | 'data-gap';
};

export function trialAdmission(e: Evidence) {
  if (e.qualified) return 'passed' as const;
  if (e.reason === 'Too few closed trades' && e.holdoutTrades > 0 && e.trades > e.holdoutTrades &&
      e.early > 0 && e.later > 0 && e.stress > Math.max(0, e.benchmark) && e.drawdown <= .12) return 'sample' as const;
  const evaluated = ['Too few closed trades','Returns were uneven across periods','Higher-cost results fell short of the benchmark','Drawdown exceeded the research limit'].includes(e.reason);
  if (evaluated && e.trades > e.holdoutTrades && e.holdoutTrades >= 2 && e.later > 0 && e.stress > 0) return 'exploratory' as const;
  return null;
}

export function updateTrial(e: Evidence, previous: NamedTrial | null, observed: TrialFill[], availableFrom: number, through: number, now: number): NamedTrial | null {
  const admission = trialAdmission(e);
  if (!previous || previous.version !== e.version) return admission ? { version: e.version, started: now, checked: now,
    admission, fills: [], equity: 1, drawdown: 0, state: 'tracking' } : null;
  if (previous.state === 'completed' || previous.state === 'stopped' || through <= previous.checked) return previous;
  if (availableFrom > previous.checked) return { ...previous, state: 'data-gap' };
  const fills = previous.fills.slice(-1);
  let count = previous.count ?? previous.fills.length;
  let equity = previous.equity, peak = previous.peak ?? 1, drawdown = previous.drawdown;
  if (previous.peak == null) {
    let historical = 1;
    for (const f of previous.fills) { historical *= 1 + f.net; peak = Math.max(peak,historical); }
  }
  const mark = (net: number) => {
    equity *= 1 + net;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  };
  for (const fill of observed) {
    if (fill.entry <= previous.started || fill.entry <= (fills.at(-1)?.exit ?? 0) || fill.exit > through ||
        fill.exit < fill.entry || !Number.isFinite(fill.net)) continue;
    fills.push(fill);
    count++;
    mark(fill.net);
  }
  return { ...previous, checked: through, fills, count, peak, equity, drawdown, state:'tracking' };
}
