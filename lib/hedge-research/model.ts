import type { Book, BookLevel } from '@/lib/liquidity';

export const HEDGE_MARKETS = { BTC: '@142', ETH: '@151' } as const;
export type HedgeMarket = keyof typeof HEDGE_MARKETS;
export const HEDGE_REVISION = 'funding-hedge-v1';
export const HOUR = 3_600_000;
export const SIMULATED_CAPITAL = 2500;
const ENTRY_RATE = .0027;
const EXIT_RATE = .0003;
const SPOT_FEE = .0007;
const PERP_FEE = .00045;
const EXTRA_SLIPPAGE = .0002;
const MAX_BOOK_COST = .0035;

export type Snapshot = Book & { time: number | null };
export type FundingPayment = { time: number; rate: number; referencePrice?: number };
type Position = { units: number; spotEntry: number; perpEntry: number; entryFee: number; paid: number; lastPaid: number; opened: number };
export type HedgeState = { position: Position | null; completed: number; realized: number; gaps: number; lastHour: number | null };
export const EMPTY_HEDGE: HedgeState = { position: null, completed: 0, realized: 0, gaps: 0, lastHour: null };
export type HedgeObservation = {
  status: 'watching' | 'holding' | 'opened' | 'closed' | 'unavailable';
  detail: string;
  rate14d: number | null;
  simulatedNet: number | null;
  spreadCostBps: number | null;
  state: HedgeState;
};

function averageFill(levels: BookLevel[], units: number) {
  let remaining = units, value = 0;
  for (const level of levels) {
    if (!Number.isFinite(level.px) || level.px <= 0 || !Number.isFinite(level.sz) || level.sz <= 0) continue;
    const fill = Math.min(remaining, level.sz);
    value += fill * level.px;
    remaining -= fill;
    if (remaining <= units * 1e-8) return value / units;
  }
  return null;
}

function mid(book: Snapshot) {
  const ask = book.asks[0]?.px, bid = book.bids[0]?.px;
  return ask > 0 && bid > 0 && ask >= bid ? (ask + bid) / 2 : NaN;
}
const fees = (spot: number, perp: number, units: number) => units * (spot * SPOT_FEE + perp * PERP_FEE);
const complete = (time: number, latest: number) => time >= latest - 12_000 && time <= latest + 1000;

export function projectHedge(state: HedgeState, spot: Snapshot, perp: Snapshot, funding: FundingPayment[], observedAt: number): HedgeObservation {
  const hour = Math.floor(observedAt / HOUR) * HOUR;
  const dailyCheck = hour % (24 * HOUR) === 0;
  const entryWindow = dailyCheck && observedAt - hour <= 10 * 60_000;
  const gap = state.lastHour == null ? 0 : Math.max(0, Math.floor((hour - state.lastHour) / HOUR) - 1);
  const next: HedgeState = { ...state, position: state.position ? { ...state.position } : null, lastHour: hour, gaps: state.gaps + gap };
  const blank = { rate14d: null, simulatedNet: null, spreadCostBps: null, state: next };
  if (spot.time == null || perp.time == null || !complete(spot.time, observedAt) || !complete(perp.time, observedAt) ||
      Math.abs(spot.time - perp.time) > 4000) return { ...blank, status: 'unavailable', detail: 'The spot and perpetual quotes could not be matched.' };
  const spotMid = mid(spot), perpMid = mid(perp);
  if (!(spotMid > 0 && perpMid > 0)) return { ...blank, status: 'unavailable', detail: 'One of the order books is empty.' };
  const perHour = new Map(funding.filter(row => Number.isFinite(row.rate)).map(row => [Math.round(row.time / HOUR) * HOUR, row]));
  let rate14d = 0;
  for (let t = hour - 335 * HOUR; t <= hour; t += HOUR) {
    const payment = perHour.get(t);
    if (payment == null) return { ...blank, status: 'unavailable', detail: 'Funding records are incomplete.' };
    rate14d += payment.rate;
  }
  const position = next.position;
  const units = position?.units ?? SIMULATED_CAPITAL / (2.5 * Math.max(spotMid, perpMid));
  const buySpot = averageFill(spot.asks, units), sellPerp = averageFill(perp.bids, units);
  const sellSpot = averageFill(spot.bids, units), buyPerp = averageFill(perp.asks, units);
  if (buySpot == null || sellPerp == null || sellSpot == null || buyPerp == null) {
    return { ...blank, rate14d, status: 'unavailable', detail: 'The visible order books cannot fill both legs at the simulated size.' };
  }
  const openSpot = buySpot * (1 + EXTRA_SLIPPAGE), openPerp = sellPerp * (1 - EXTRA_SLIPPAGE);
  const closeSpot = sellSpot * (1 - EXTRA_SLIPPAGE), closePerp = buyPerp * (1 + EXTRA_SLIPPAGE);
  const openFee = fees(openSpot, openPerp, units), closeFee = fees(closeSpot, closePerp, units);
  const bookCost = ((openSpot - closeSpot + closePerp - openPerp) * units + openFee + closeFee) / (units * Math.max(spotMid, perpMid));
  const sample = { ...blank, rate14d, spreadCostBps: bookCost * 10_000 };
  if (position) {
    for (let t = position.lastPaid + HOUR; t <= hour; t += HOUR) {
      const payment = perHour.get(t);
      if (payment == null) return { ...blank, rate14d, status: 'unavailable', detail: 'An open simulation has unverified funding.' };
    }
    for (let t = position.lastPaid + HOUR; t <= hour; t += HOUR) {
      const payment = perHour.get(t)!;
      position.paid += payment.rate * (payment.referencePrice ?? perpMid) * units;
    }
    position.lastPaid = hour;
    const simulatedNet = units * (closeSpot - position.spotEntry + position.perpEntry - closePerp) + position.paid - position.entryFee - closeFee;
    const collateralReset = perpMid > position.perpEntry * 1.75 || perpMid < position.perpEntry * .65;
    if (collateralReset || dailyCheck && rate14d < EXIT_RATE) {
      next.position = null;
      next.completed++;
      next.realized += simulatedNet;
      return { ...sample, simulatedNet, status: 'closed', detail: collateralReset ? 'Collateral reset' : 'Funding fell below the exit threshold.' };
    }
    return { ...sample, simulatedNet, status: 'holding', detail: 'Paper hedge open' };
  }
  if (entryWindow && rate14d >= ENTRY_RATE && bookCost <= MAX_BOOK_COST) {
    next.position = { units, spotEntry: openSpot, perpEntry: openPerp, entryFee: openFee, paid: 0, lastPaid: hour, opened: observedAt };
    return { ...sample, simulatedNet: -bookCost * units * Math.max(spotMid, perpMid), status: 'opened', detail: 'Both legs priced from the live order books.' };
  }
  return { ...sample, status: 'watching', detail: rate14d < ENTRY_RATE ? 'Funding below the entry threshold' :
    bookCost > MAX_BOOK_COST ? 'Both legs were too expensive' : 'Waiting for the next daily entry check' };
}
