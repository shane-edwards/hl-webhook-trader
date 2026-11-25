import { checkRisk, DEFAULT_RISK, MIN_NOTIONAL_USD, type RiskConfig, type RiskState } from '@/lib/autopilot/risk';
import { COST, STOP_SLIPPAGE } from '@/lib/autopilot/simulate';
import type { Bar } from '@/lib/autopilot/strategies';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const START = 10_000;
const MAX_ORDER = 1_000; // Same paper order ceiling as controlledCryptoConfig.
const books = ['one', 'shared'] as const;
type Book = typeof books[number];
type Amounts = Record<Book, number>;
export type IdeaSignal = { id: string; version: string; symbol: string; rule: string; name: string; bar: number; stopPct: number };
type Lot = IdeaSignal & { entry: number; time: number; stop: number; funding: number; sizes: Amounts };
type Portfolio = { cash: number; equity: number; drawdown: number; risk: RiskState | null; entered: number; skipped: number; closed: number };
type Trial = { symbol: string; name: string; count: number; closed: number; totalReturn: number };
export type PaperComparison = { started: number; through: number; risk: RiskConfig; one: Portfolio; shared: Portfolio;
  lots: Lot[]; seen: Record<string, number>; trials: Record<string, Trial>;
  missing: string[]; recent: PaperEvent[]; pending: { at: number; signals: IdeaSignal[]; exits: string[] } | null };
export type PaperEvent = { id: string; at: number; type: 'entry' | 'exit'; symbol: string; name: string;
  one?: string; shared?: string; sizes: Amounts; net?: number };
export type MinuteMarket = { bar: Bar; funding: number };
const portfolio = (): Portfolio => ({ cash: START, equity: START, risk: null, drawdown: 0, entered: 0, skipped: 0, closed: 0 });

export function newComparison(time: number, risk = DEFAULT_RISK): PaperComparison {
  return { started: time, through: time, risk: { ...risk, maxLeveragePerPosition: 1 }, one: portfolio(), shared: portfolio(),
    lots: [], seen: {}, trials: {}, missing: [], recent: [], pending: null };
}

// Freeze signals before their modeled fill. Both books use the same first future minute open.
export function scheduleSignals(s: PaperComparison, observedAt: number, signals: IdeaSignal[], exits: string[]) {
  if (s.pending) throw new Error('Prior paper decisions are still pending.');
  const fresh = signals.filter(sig => {
    if (!(sig.stopPct > 0 && sig.stopPct < 1) || sig.bar <= (s.seen[sig.version] ?? -1)) return false;
    s.seen[sig.version] = sig.bar;
    return true;
  });
  if (fresh.length || exits.length) s.pending = { at: (Math.floor(observedAt / MINUTE) + 1) * MINUTE, signals: fresh, exits };
}

function mark(s: PaperComparison, book: Book, markets: Map<string, MinuteMarket>, field: 'o' | 'c', time: number) {
  const p = s[book];
  p.equity = s.lots.reduce((sum, l) => sum + l.sizes[book] / l.entry * markets.get(l.symbol)!.bar[field] * (1 - COST), p.cash);
  const check = checkRisk(p.risk, p.equity, time, s.risk);
  p.risk = check.state;
  p.drawdown = Math.max(p.drawdown, check.drawdownPct);
  return check.canOpen;
}

function close(s: PaperComparison, lot: Lot, price: number, time: number, events: PaperEvent[]) {
  for (const book of books) {
    const amount = lot.sizes[book];
    if (amount > 0) {
      s[book].cash += amount / lot.entry * price * (1 - COST);
      s[book].closed++;
    }
  }
  const net = (price * (1 - COST) - lot.funding) / lot.entry - (1 + COST);
  const trial = s.trials[lot.version];
  trial.closed++;
  trial.totalReturn += net;
  events.push({ id: lot.id, at: time, type: 'exit', symbol: lot.symbol, name: lot.name, sizes: lot.sizes, net });
  s.lots = s.lots.filter(l => l.id !== lot.id);
}

function allocate(s: PaperComparison, book: Book, entries: Lot[], markets: Map<string, MinuteMarket>, time: number) {
  const p = s[book];
  const canOpen = mark(s, book, markets, 'o', time);
  const held = s.lots.filter(l => l.sizes[book] > 0);
  const occupied = new Set(held.map(l => l.symbol));
  const reasons = new Map<string, string>();
  const eligible: Lot[] = [];
  for (const l of entries) {
    const why = !canOpen ? 'Risk pause' : occupied.has(l.symbol) ? 'Coin already held' :
      book === 'one' && (held.length || eligible.length) ? 'One-position limit' : null;
    if (why) reasons.set(l.id, why);
    else { occupied.add(l.symbol); eligible.push(l); }
  }
  // Include spread/fees and a modeled adverse gap in the loss reserved for each stop.
  const allowance = .0075;
  const reserved = held.reduce((sum, l) => {
    const price = markets.get(l.symbol)!.bar.o;
    return sum + l.sizes[book] / l.entry * (Math.max(0, price - l.stop) + price * allowance);
  }, 0);
  let riskLeft = Math.max(0, p.equity * s.risk.riskPerTradePct / 100 - reserved);
  for (const [i, l] of eligible.entries()) {
    const remaining = eligible.length - i;
    const unitRisk = l.stopPct + allowance;
    const amount = Math.min(MAX_ORDER, riskLeft / remaining / unitRisk, p.cash / remaining / (1 + COST));
    if (amount < MIN_NOTIONAL_USD) { reasons.set(l.id, 'Insufficient risk or cash'); continue; }
    l.sizes[book] = amount;
    p.cash -= amount * (1 + COST);
    riskLeft -= amount * unitRisk;
    p.entered++;
  }
  p.skipped += reasons.size;
  return reasons;
}

export function advanceMinute(s: PaperComparison, time: number, markets: Map<string, MinuteMarket>, events: PaperEvent[]) {
  if (time !== s.through) throw new Error('Nonconsecutive comparison minute.');
  const pending = s.pending?.at === time ? s.pending : null;
  if (s.pending && s.pending.at < time) throw new Error('Unprocessed comparison decision.');
  const needed = [...s.lots, ...(pending?.signals ?? [])];
  for (const l of needed) {
    const m = markets.get(l.symbol);
    if (!m || m.bar.t !== time || ![m.bar.o,m.bar.h,m.bar.l,m.bar.c].every(v => Number.isFinite(v) && v > 0) ||
      m.bar.l > Math.min(m.bar.o,m.bar.c) || m.bar.h < Math.max(m.bar.o,m.bar.c) || !Number.isFinite(m.funding)) throw new Error('Incomplete comparison market data.');
  }
  // Opening gaps and already-scheduled exits release cash before simultaneous entries are sized.
  for (const l of [...s.lots]) {
    const open = markets.get(l.symbol)!.bar.o;
    if (open <= l.stop) close(s, l, open * (1 - STOP_SLIPPAGE), time, events);
    else if (pending?.exits.includes(l.id)) close(s, l, open, time, events);
  }
  if (pending) {
    const entries = pending.signals.map((sig): Lot => {
      const entry = markets.get(sig.symbol)!.bar.o;
      return { ...sig, entry, time, stop: entry * (1 - sig.stopPct), funding: 0, sizes: { one: 0, shared: 0 } };
    });
    const single = allocate(s, 'one', entries, markets, time);
    const shared = allocate(s, 'shared', entries, markets, time);
    for (const l of entries) {
      const trial = s.trials[l.version] ??= { symbol: l.symbol, name: l.name, count: 0, closed: 0, totalReturn: 0 };
      trial.count++;
      events.push({ id: l.id, at: time, type: 'entry', symbol: l.symbol, name: l.name, sizes: l.sizes,
        one: single.get(l.id) ?? 'Entered', shared: shared.get(l.id) ?? 'Entered' });
    }
    s.lots.push(...entries);
    s.pending = null;
  }
  for (const l of [...s.lots]) {
    const { bar, funding } = markets.get(l.symbol)!;
    if (bar.l <= l.stop) { close(s, l, l.stop * (1 - STOP_SLIPPAGE), time, events); continue; }
    l.funding += funding * bar.c;
    for (const book of books) s[book].cash -= funding * bar.c * l.sizes[book] / l.entry;
  }
  for (const book of books) mark(s, book, markets, 'c', time);
  s.through = time + MINUTE;
}

export function comparisonSummary(s: PaperComparison) {
  const summarize = (book: Book) => ({ net: s[book].equity / START - 1, drawdown: s[book].drawdown / 100,
    opened: s[book].entered, closed: s[book].closed, skipped: s[book].skipped, open: s.lots.filter(l => l.sizes[book] > 0).length });
  return { started: s.started, through: s.through, capital: START, riskPct: s.risk.riskPerTradePct,
    signals: Object.values(s.trials).reduce((sum, t) => sum + t.count, 0), pending: s.pending?.signals.length ?? 0,
    one: summarize('one'), shared: summarize('shared'), recent: s.recent, missing: s.missing, trials: Object.values(s.trials) };
}
export type ComparisonSummary = ReturnType<typeof comparisonSummary>;
