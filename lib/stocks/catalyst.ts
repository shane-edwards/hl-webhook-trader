import type { IntradayBar } from './etoro';
import { stockMarketClock, stockSessionMinute } from './session';

export const CATALYST_VERSION = 'opening-strength-v1';
export const CATALYST_HOLDS = [30, 60, 90] as const;
export const CATALYST_COSTS = { latencySeconds: 30, slipBps: 3, feePerSideUsd: 1, notionalUsd: 1000 };
const MINUTE = 60_000;
const BAR = 5 * MINUTE;

export type CatalystFiling = { at: string; accession: string; kind: 'Earnings' | 'Guidance'; url: string };
export type CatalystOpening = { moveBps: number; relativeVolume: number; low: number };
export type CatalystDecision = { status: 'Qualified' | 'Skip' | 'Watch'; reason: string; relativeBps: number | null; relativeVolume: number | null; stop: number | null };
export type CatalystSim = { hold: number; state: 'complete' | 'unfilled' | 'missing'; reason: string; entry?: number; exit?: number; pnlUsd?: number; netBps?: number; stressedBps?: number };
export type CatalystObservation = {
  id?: string; session_day: string; environment: 'demo' | 'real'; symbol: string; sector: string; instrument_id: number;
  for_symbol: string; lane: 'catalyst' | 'control'; filing: CatalystFiling | null; observed_at: string;
  eligible_at: string; settle_after: string; quote: { ask: number; bid: number; at: string } | null;
  decision: CatalystDecision; outcomes: CatalystSim[] | null;
};

function openingBars(bars: IntradayBar[], day: string) {
  const open = stockSessionMinute(day, 570);
  const initial = bars.filter(bar => bar.t >= open && bar.t < open + 3 * BAR);
  return initial.length === 3 && initial.every((bar, i) => bar.t === open + i * BAR) ? initial : null;
}

export function catalystOpening(bars: IntradayBar[], day: string): CatalystOpening | null {
  const current = openingBars(bars, day);
  const volume = (items: IntradayBar[]) => items.every(bar => Number.isFinite(bar.volume) && bar.volume > 0)
    ? items.reduce((sum, bar) => sum + bar.volume, 0) : 0;
  if (!current || volume(current) <= 0) return null;
  const days = [...new Set(bars.filter(bar => bar.t < current[0].t).map(bar => stockMarketClock(bar.t).day))].sort().slice(-25);
  const prior = days.flatMap(session => {
    const group = openingBars(bars, session);
    return group && volume(group) > 0 ? [volume(group)] : [];
  }).slice(-20);
  if (prior.length < 12) return null;
  return { moveBps: (current[2].bidClose / current[0].bidOpen - 1) * 10_000,
    relativeVolume: volume(current) / (prior.reduce((sum, v) => sum + v, 0) / prior.length),
    low: Math.min(...current.map(bar => bar.bidLow)) };
}

export function catalystSectorMove(bars: IntradayBar[], day: string) {
  const current = openingBars(bars, day);
  return current ? (current[2].bidClose / current[0].bidOpen - 1) * 10_000 : null;
}

export function catalystDecision(stock: CatalystOpening | null, sectorMove: number | null, quote: CatalystObservation['quote']): CatalystDecision {
  const relativeBps = stock && sectorMove != null ? stock.moveBps - sectorMove : null;
  const details = { relativeBps, relativeVolume: stock?.relativeVolume ?? null, stop: stock?.low ?? null };
  if (!stock || relativeBps == null || !quote) return { ...details, status: 'Watch', reason: 'Opening history, sector data or a fresh bid and ask is missing' };
  const spread = (quote.ask - quote.bid) / quote.ask * 10_000;
  const stopDistance = (quote.ask - stock.low) / quote.ask;
  if (quote.bid <= stock.low || stopDistance > 0.025) return { ...details, status: 'Skip', reason: 'The opening-range stop is already crossed or more than 2.5% away' };
  if (spread > 25) return { ...details, status: 'Skip', reason: 'The quoted spread exceeds 25 bps' };
  if (stock.moveBps <= 0 || relativeBps < 30 || stock.relativeVolume < 1.5) {
    return { ...details, status: 'Skip', reason: 'The first 15 minutes did not clear the strength and volume thresholds' };
  }
  return { ...details, status: 'Qualified', reason: 'Positive opening move, at least 30 bps ahead of its sector and at least 1.5× opening volume' };
}

export function catalystEntryTime(observed: number) {
  return Math.ceil((observed + CATALYST_COSTS.latencySeconds * 1000) / BAR) * BAR;
}

export function replayCatalyst(observation: Pick<CatalystObservation, 'eligible_at' | 'decision' | 'quote'>, bars: IntradayBar[]): CatalystSim[] {
  const entryTime = Date.parse(observation.eligible_at);
  const lookup = new Map(bars.map(bar => [bar.t, bar]));
  const opening = lookup.get(entryTime);
  return CATALYST_HOLDS.map(hold => {
    const stop = observation.decision.stop;
    if (!observation.quote || stop == null) return { hold, state: 'missing', reason: 'Decision quote or valid stop unavailable' };
    if (!opening) return { hold, state: 'missing', reason: 'Scheduled entry quote is missing' };
    if (opening.bidOpen <= stop) return { hold, state: 'unfilled', reason: 'The bid traded through the stop before the simulated entry' };
    const end = entryTime + hold * MINUTE;
    let exit: number | undefined;
    let reason = 'Timed exit';
    for (let cursor = entryTime; cursor <= end; cursor += BAR) {
      const bar = lookup.get(cursor);
      if (!bar) return { hold, state: 'missing', reason: 'A quote is missing before the simulated exit' };
      if (cursor === end) { exit = bar.bidOpen; break; }
      if (bar.bidLow <= stop) { exit = Math.min(bar.bidOpen, stop); reason = 'Stop triggered'; break; }
    }
    if (exit == null) return { hold, state: 'missing', reason: 'Exit quote unavailable' };
    const { notionalUsd, feePerSideUsd, slipBps } = CATALYST_COSTS;
    const pnl = (slippage: number, fee: number) => {
      const buy = opening.askOpen * (1 + slippage / 10_000);
      const units = (notionalUsd - fee) / buy;
      return units * exit! * (1 - slippage / 10_000) - fee - notionalUsd;
    };
    const pnlUsd = pnl(slipBps, feePerSideUsd);
    return { hold, state: 'complete', reason, entry: opening.askOpen, exit, pnlUsd, netBps: pnlUsd / notionalUsd * 10_000,
      stressedBps: pnl(slipBps * 2, feePerSideUsd * 2) / notionalUsd * 10_000 };
  });
}

export function catalystComparison(observations: CatalystObservation[]) {
  const pair = (row: CatalystObservation) => `${row.environment}:${row.session_day}:${row.for_symbol}`;
  const peer = new Map(observations.filter(row => row.lane === 'control').map(row => [pair(row), row]));
  return CATALYST_HOLDS.map(hold => {
    let qualified = 0, skipped = 0, paired = 0, qualifiedNet = 0, skippedNet = 0;
    const daily = new Map<string, { total: number; count: number }>();
    for (const row of observations) {
      if (row.lane !== 'catalyst') continue;
      const result = row.outcomes?.find(outcome => outcome.hold === hold);
      if (result?.state !== 'complete' || result.netBps == null || result.stressedBps == null) continue;
      if (row.decision.status === 'Skip') { skipped++; skippedNet += result.netBps; }
      if (row.decision.status !== 'Qualified') continue;
      qualified++; qualifiedNet += result.netBps;
      const control = peer.get(pair(row));
      const matched = control?.outcomes?.find(outcome => outcome.hold === hold);
      if (control?.decision.status !== 'Qualified' || matched?.state !== 'complete' || matched.stressedBps == null) continue;
      paired++;
      const point = daily.get(row.session_day) ?? { total: 0, count: 0 };
      point.total += result.stressedBps - matched.stressedBps;
      point.count++;
      daily.set(row.session_day, point);
    }
    return { hold, qualified, skipped, paired, matchedDays: daily.size,
      qualifiedBps: qualified ? qualifiedNet / qualified : null, skippedBps: skipped ? skippedNet / skipped : null,
      liftBps: daily.size ? [...daily.values()].reduce((sum, point) => sum + point.total / point.count, 0) / daily.size : null };
  });
}
