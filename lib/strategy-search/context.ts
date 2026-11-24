import type { SearchBar, ContextFactor } from './model';

export const DAY = 86_400_000;
export type DailyContext = Map<number, Partial<Record<ContextFactor, number>>>;
type StockClose = { day: string; bidClose: number };
export type EpsFact = { start?: string; end: string; filed: string; form: string; val: number; accn?: string };

// Compare fiscal quarters in the same original filing so splits use the same share basis.
export function earningsChanges(facts: EpsFact[]) {
  const filings = new Map<string, EpsFact[]>();
  for (const f of facts) {
    const days = (Date.parse(f.end) - Date.parse(f.start ?? '')) / DAY;
    if (!f.accn || !['10-Q','10-K'].includes(f.form) || !(days >= 75 && days <= 105) || !Number.isFinite(f.val)) continue;
    const group = filings.get(f.accn) ?? [];
    group.push(f);
    filings.set(f.accn, group);
  }
  const events: { available: number; delta: number }[] = [];
  for (const group of filings.values()) {
    group.sort((a,b) => b.end.localeCompare(a.end));
    const current = group[0], end = Date.parse(current.end), filed = Date.parse(current.filed);
    if (!(filed >= end && filed - end < 100 * DAY)) continue;
    const prior = group.find(f => Math.abs(end - Date.parse(f.end) - 365 * DAY) <= 10 * DAY);
    if (prior) events.push({ available: filed + DAY, delta: current.val - prior.val });
  }
  return events.sort((a,b) => a.available - b.available);
}

export function stockContext(bars: SearchBar[], stock: StockClose[], sector: StockClose[], facts: EpsFact[]): DailyContext {
  const closes = new Map(sector.map(r => [r.day, r.bidClose]));
  const sessions = [...stock].sort((a,b) => a.day.localeCompare(b.day));
  const strength = new Map<number, number>();
  for (let i = 5; i < sessions.length; i++) {
    const end = sessions[i], start = sessions[i-5];
    const first = closes.get(start.day), last = closes.get(end.day);
    if (first && last && start.bidClose > 0 && end.bidClose > 0 && Date.parse(end.day) - Date.parse(start.day) <= 12 * DAY)
      strength.set(Date.parse(end.day), end.bidClose / start.bidClose - last / first);
  }
  const days = [...new Set(bars.map(b => Math.floor(b.t / DAY) * DAY))];
  const events = earningsChanges(facts);
  let index = -1;
  const result: DailyContext = new Map();
  for (const day of days) {
    while (index + 1 < events.length && events[index + 1].available <= day) index++;
    const event = events[index];
    const values: Partial<Record<ContextFactor, number>> = {};
    if (event && day - event.available <= 210 * DAY) values.earnings = day - event.available < 45 * DAY ? event.delta : 0;
    // Use only the preceding session, also for intraday strategies.
    const prior = [1,2,3,4,5,6,7].map(offset => day - offset * DAY).find(date => closes.has(new Date(date).toISOString().slice(0,10)));
    if (prior !== undefined && strength.has(prior)) values.sector = strength.get(prior)!;
    result.set(day, values);
  }
  return result;
}

export function cryptoContext(oi: Map<number, number>, funding: Map<number, number>): DailyContext {
  const result: DailyContext = new Map();
  for (const day of new Set([...oi.keys(), ...funding.keys()])) {
    const values: Partial<Record<ContextFactor, number>> = {};
    const interest = oi.get(day), previous = oi.get(day - DAY);
    if (interest && previous) values.openInterest = interest / previous - 1;
    const rate = funding.get(day), prior = funding.get(day - DAY);
    if (rate !== undefined && prior !== undefined) values.fundingChange = rate - prior;
    // Publish only after the entire UTC observation day has elapsed.
    result.set(day + DAY, values);
  }
  return result;
}

export function attachContext(bars: SearchBar[], context: DailyContext) {
  return bars.map(b => Object.assign(b, context.get(Math.floor(b.t / DAY) * DAY)));
}
