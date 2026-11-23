import type { StockSession } from './intraday';

export const OPENING_RULES = [
  { id: 'control', name: '30m breakout by usual liquidity', interval: 30, slots: 3, rank: 'liquidity', maxMinutes: 390, aligned: false },
  { id: 'ranked', name: '30m breakout ranked by opening volume', interval: 30, slots: 3, rank: 'rvol', maxMinutes: 390, aligned: false },
  { id: 'ranked-90', name: '30m ranked breakout, 90-minute exit', interval: 30, slots: 3, rank: 'rvol', maxMinutes: 90, aligned: false },
  { id: 'market-90', name: '30m ranked momentum, next open', interval: 30, slots: 3, rank: 'rvol', maxMinutes: 90, aligned: false, marketEntry: true },
  { id: 'aligned', name: '30m ranked breakout with SPY filter', interval: 30, slots: 3, rank: 'rvol', maxMinutes: 90, aligned: true },
  { id: 'fast', name: '5m ranked breakout, 90-minute exit', interval: 5, slots: 1, rank: 'rvol', maxMinutes: 90, aligned: false },
] as const;

type Rule = typeof OPENING_RULES[number];
export type OpeningCandidate = { symbol: string; session: StockSession; relativeVolume: number; liquidity: number; atr: number };
const capital = 10_000;

function sessionTotals(s: StockSession) {
  return {
    high: Math.max(...s.bars.map(b => b.bidHigh)), low: Math.min(...s.bars.map(b => b.bidLow)),
    close: s.bars.at(-1)!.bidClose, volume: s.bars.reduce((sum, b) => sum + (Number.isFinite(b.volume) ? b.volume : 0), 0),
  };
}

/** Rank using the finished opening bar and 14 preceding complete sessions only. */
export function openingCandidate(symbol: string, session: StockSession, prior: StockSession[]): OpeningCandidate | null {
  const open = session.bars[0];
  const history = prior.slice(-15);
  if (!open || open.bidOpen <= 5 || open.bidClose <= open.bidOpen || !Number.isFinite(open.volume) || open.volume <= 0 || history.length < 15) return null;
  const openingVolumes = history.slice(1).map(s => s.bars[0].volume);
  if (openingVolumes.some(v => !Number.isFinite(v) || v <= 0)) return null;
  const days = history.map(sessionTotals);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const avgShares = mean(days.slice(1).map(d => d.volume));
  const atr = mean(days.slice(1).map((d, i) => Math.max(d.high - d.low, Math.abs(d.high - days[i].close), Math.abs(d.low - days[i].close))));
  if (avgShares < 1_000_000 || atr <= 0.5) return null;
  return {
    symbol, session, atr, relativeVolume: open.volume / mean(openingVolumes), liquidity: mean(days.slice(1).map(d => d.close * d.volume)),
  };
}

export function selectOpening(candidates: OpeningCandidate[], rule: Rule) {
  return candidates.filter(c => rule.rank !== 'rvol' || c.relativeVolume >= 1)
    .sort((a, b) => {
      const score = (c: OpeningCandidate) => rule.rank === 'rvol' ? c.relativeVolume : c.liquidity;
      return score(b) - score(a) || a.symbol.localeCompare(b.symbol);
    }).slice(0, rule.slots);
}

function renderTrade(candidate: OpeningCandidate, rule: Rule) {
  const bars = candidate.session.bars;
  const trigger = bars[0].bidHigh;
  // Keep a live session open long enough to close by the final regular bid.
  const atMarket = 'marketEntry' in rule;
  const entry = atMarket ? 1 : bars.findIndex((b, i) => i > 0 && i < bars.length - 1 && b.bidHigh >= trigger);
  if (entry < 0) return null;
  const bar = bars[entry];
  const entryBid = atMarket ? bar.bidOpen : Math.max(trigger, bar.bidOpen);
  const entryAsk = entryBid + (bar.askOpen - bar.bidOpen);
  const stop = entryBid - candidate.atr * 0.1;
  const deadline = Math.min(bars.length, entry + rule.maxMinutes / rule.interval);
  let exitBid = deadline < bars.length ? bars[deadline].bidOpen : bars.at(-1)!.bidClose;
  let held = deadline - entry;
  for (let i = entry; !atMarket && i < deadline; i++) {
    if (bars[i].bidLow > stop) continue;
    // The entry bar's pre-entry open cannot serve as the stop fill.
    exitBid = i === entry ? stop : Math.min(stop, bars[i].bidOpen);
    held = i - entry + 1;
    break;
  }
  const size = capital / rule.slots;
  const result = (slipBps: number, perSide: number, proportionalBps = 0) => {
    const buyRate = 1 + slipBps / 10_000;
    const sellRate = 1 - slipBps / 10_000;
    const commissionRate = proportionalBps / 10_000;
    const qty = (size - perSide) / (entryAsk * buyRate * (1 + commissionRate));
    const proceeds = qty * exitBid * sellRate * (1 - commissionRate) - perSide;
    return (proceeds / size - 1) * 10_000;
  };
  return {
    symbol: candidate.symbol, day: candidate.session.day, minutes: held * rule.interval,
    grossBps: (exitBid / entryBid - 1) * 10_000, netBps: result(2, 1), stressBps: result(5, 2), cfdBps: result(2, 0, 15),
  };
}

type OpeningTrade = NonNullable<ReturnType<typeof renderTrade>>;

/** Build one list for each day. The selection is made before any breakout bar. */
export function prepareOpening(sessions: Record<string, StockSession[]>) {
  const byDay = new Map<string, OpeningCandidate[]>();
  for (const [symbol, history] of Object.entries(sessions)) {
    if (symbol === 'SPY') continue;
    for (let i = 15; i < history.length; i++) {
      const session = history[i];
      const c = openingCandidate(symbol, session, history.slice(i - 15, i));
      if (!c) continue;
      const list = byDay.get(session.day) ?? [];
      list.push(c);
      byDay.set(session.day, list);
    }
  }
  const positiveSpy = new Set((sessions.SPY ?? []).filter(s => s.bars[0].bidClose > s.bars[0].bidOpen).map(s => s.day));
  return { byDay, positiveSpy };
}

export function replayOpening(data: ReturnType<typeof prepareOpening>, rule: Rule, from: string, to: string) {
  let setups = 0;
  const trades: OpeningTrade[] = [];
  for (const [day, candidates] of data.byDay) {
    if (day < from || day >= to || (rule.aligned && !data.positiveSpy.has(day))) continue;
    for (const candidate of selectOpening(candidates, rule)) {
      setups++;
      const trade = renderTrade(candidate, rule);
      if (trade) trades.push(trade);
    }
  }
  return { setups, trades };
}

export function summarizeOpening({ setups, trades }: ReturnType<typeof replayOpening>) {
  const days = new Map<string, number>();
  const symbols = new Map<string, number>();
  for (const trade of trades) {
    days.set(trade.day, (days.get(trade.day) ?? 0) + trade.netBps);
    symbols.set(trade.symbol, (symbols.get(trade.symbol) ?? 0) + trade.netBps);
  }
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const daily = [...days.values()];
  const mean = avg(daily) ?? 0;
  const sd = daily.length > 1 ? Math.sqrt(daily.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (daily.length - 1)) : 0;
  return {
    setups, trades: trades.length, days: days.size, symbols: symbols.size,
    positiveSymbols: [...symbols.values()].filter(v => v > 0).length,
    grossBps: avg(trades.map(t => t.grossBps)), netBps: avg(trades.map(t => t.netBps)),
    stressBps: avg(trades.map(t => t.stressBps)), cfdBps: avg(trades.map(t => t.cfdBps)),
    minutes: avg(trades.map(t => t.minutes)), tByDay: sd > 0 ? mean / sd * Math.sqrt(daily.length) : null,
  };
}
