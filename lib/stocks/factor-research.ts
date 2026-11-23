import type { StockSession } from './intraday';

export type EarningsFiling = { time: number; reportDate: string };
type Family = 'reversal' | 'close' | 'earnings';
type Rule = {
  id: string; name: string; family: Family; entry: number; hold: number; threshold: number;
  lookback?: number; direction?: 1 | -1;
};
const halfHour = 30 * 60_000;
const calendarDay = 24 * 60 * 60_000;
const size = 5000;
const o = (bar: { bidOpen: number; askOpen: number }) => (bar.bidOpen + bar.askOpen) / 2;
const clock = (i: number) => {
  const minute = 570 + 30 * i;
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
};

export const FACTOR_SOURCES = [
  { family: 'reversal', name: 'Intraday cross-sectional returns', url: 'https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6261.2010.01573.x' },
  { family: 'close', name: 'End-of-day reversal research', url: 'https://www.efmaefm.org/0EFMAMEETINGS/EFMA%20ANNUAL%20MEETINGS/2024-Lisbon/papers/EndofDayReversal_withnames.pdf' },
  { family: 'earnings', name: 'After-hours earnings price discovery', url: 'https://onlinelibrary.wiley.com/doi/full/10.1111/1475-679X.12394' },
] as const;

export const FACTOR_RULES: Rule[] = [
  ...[2, 4, 7].flatMap(entry => [...new Set([2, entry])].flatMap(lookback => [0.006, 0.012].flatMap(threshold => [1, 3].map(hold => ({
    id: `rev-${entry}-${lookback}-${threshold}-${hold}`, family: 'reversal' as const, entry, lookback, threshold, hold,
    name: `${clock(entry)} reversal, ${lookback * 30}m signal, ${(threshold * 100).toFixed(1)}% lag, ${hold * 30}m hold`,
  }))))),
  ...[0.006, 0.012].map(threshold => ({ id: `close-${threshold}`, family: 'close' as const, entry: 12, lookback: 12, threshold, hold: 1, name: `15:30 reversal, ${(threshold * 100).toFixed(1)}% lag` })),
  ...([-1, 1] as const).flatMap(direction => [0.01, 0.02, 0.03].flatMap(threshold => [2, 12].map(hold => ({
    id: `event-${direction}-${threshold}-${hold}`, family: 'earnings' as const, entry: 1, direction, threshold, hold,
    name: `Earnings ${direction < 0 ? 'gap-down rebound' : 'gap-up follow-through'}, ${(threshold * 100).toFixed(0)}% gap, ${hold === 12 ? 'to close' : '60m hold'}`,
  })))),
];

export function earningsBeforeOpen(filings: EarningsFiling[], previousClose: number, todayOpen: number): boolean {
  return filings.some(f => f.time >= previousClose && f.time < todayOpen - 5 * 60_000 &&
    Math.abs(f.time - Date.parse(`${f.reportDate}T00:00:00Z`)) <= 36 * 3_600_000);
}

type Aligned = { symbol: string; day: string; stock: StockSession; spy: StockSession; earningsGap: number | null; otherGap: number | null };

export function alignFactorSessions(history: Record<string, StockSession[]>, filings: Record<string, EarningsFiling[]>) {
  const byDay = new Map<string, Aligned[]>();
  const market = new Map((history.SPY ?? []).map((s, i, xs) => [s.day, { session: s, prior: xs[i - 1] }]));
  for (const [symbol, sessions] of Object.entries(history)) {
    if (symbol === 'SPY') continue;
    for (let i = 0; i < sessions.length; i++) {
      const stock = sessions[i], prev = sessions[i - 1], spy = market.get(stock.day);
      if (!spy || stock.bars[0].t !== spy.session.bars[0].t) continue;
      let earningsGap: number | null = null, otherGap: number | null = null;
      if (prev && spy.prior?.day === prev.day && Date.parse(stock.day) - Date.parse(prev.day) <= 4 * calendarDay) {
        const gap = o(stock.bars[0]) / prev.bars.at(-1)!.bidClose - o(spy.session.bars[0]) / spy.prior.bars.at(-1)!.bidClose;
        if (Math.abs(gap) < 0.25) {
          if (earningsBeforeOpen(filings[symbol] ?? [], prev.bars.at(-1)!.t + halfHour, stock.bars[0].t)) earningsGap = gap;
          else otherGap = gap;
        }
      }
      const row = { symbol, day: stock.day, stock, spy: spy.session, earningsGap, otherGap };
      const rows = byDay.get(stock.day) ?? [];
      rows.push(row);
      byDay.set(stock.day, rows);
    }
  }
  return byDay;
}

function score(candidate: Aligned, rule: Rule, maxSpreadBps: number, eventControl: boolean): number | null {
  const { stock, spy, earningsGap, otherGap } = candidate;
  const entry = stock.bars[rule.entry];
  if ((entry.askOpen - entry.bidOpen) / o(entry) * 10_000 > maxSpreadBps) return null;
  if (rule.family === 'earnings') {
    const gap = eventControl ? otherGap : earningsGap;
    return gap == null ? null : gap * (rule.direction ?? 1);
  }
  const start = rule.entry - (rule.lookback ?? rule.entry);
  return o(spy.bars[rule.entry]) / o(spy.bars[start]) - o(entry) / o(stock.bars[start]);
}

function fill(c: Aligned, rule: Rule) {
  const entry = c.stock.bars[rule.entry];
  const target = rule.entry + rule.hold;
  const exit = c.stock.bars[target];
  const sell = exit ? exit.bidOpen : c.stock.bars.at(-1)!.bidClose;
  const net = (slip: number, fee: number) => {
    const rate = slip / 10_000;
    const shares = (size - fee) / (entry.askOpen * (1 + rate));
    return ((shares * sell * (1 - rate) - fee) / size - 1) * 10_000;
  };
  return {
    day: c.day, symbol: c.symbol, gross: ((exit ? o(exit) : sell) / o(entry) - 1) * 10_000,
    net: net(2, 1), stress: net(5, 2), minutes: (Math.min(target, 13) - rule.entry) * 30,
  };
}

/** Resample whole session days so simultaneous trades stay together. */
function intervalByDay(days: Array<{ net: number; trades: number }>) {
  if (days.length < 10) return null;
  let seed = 0x5a3c426f;
  const estimates = [];
  for (let iteration = 0; iteration < 1200; iteration++) {
    let net = 0, trades = 0;
    for (let j = 0; j < days.length; j++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const day = days[Math.floor(seed / 2 ** 32 * days.length)];
      net += day.net;
      trades += day.trades;
    }
    estimates.push(net / trades);
  }
  estimates.sort((a, b) => a - b);
  return [estimates[30], estimates[1169]] as const;
}

export function runFactorRule(data: Map<string, Aligned[]>, rule: Rule, from: string, to: string, maxSpreadBps = 10, eventControl = false) {
  const trades = [];
  for (const [day, list] of data) {
    if (day < from || day >= to) continue;
    const picked = list.map(row => ({ row, strength: score(row, rule, maxSpreadBps, eventControl) })).filter(c => (c.strength ?? 0) >= rule.threshold)
      .sort((a, b) => b.strength! - a.strength! || a.row.symbol.localeCompare(b.row.symbol)).slice(0, 2);
    for (const { row } of picked) trades.push(fill(row, rule));
  }
  const dayPnl = new Map<string, { net: number; trades: number }>();
  const symbolPnl = new Map<string, number>();
  for (const t of trades) {
    const day = dayPnl.get(t.day) ?? { net: 0, trades: 0 };
    day.net += t.net;
    day.trades++;
    dayPnl.set(t.day, day);
    symbolPnl.set(t.symbol, (symbolPnl.get(t.symbol) ?? 0) + t.net);
  }
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const days = [...dayPnl.values()];
  const series = days.map(d => d.net);
  const mean = avg(series) ?? 0;
  const variance = series.length > 1 ? series.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (series.length - 1) : 0;
  return {
    trades: trades.length, activeDays: dayPnl.size, positiveSymbols: [...symbolPnl.values()].filter(v => v > 0).length,
    grossBps: avg(trades.map(t => t.gross)), netBps: avg(trades.map(t => t.net)), stressBps: avg(trades.map(t => t.stress)),
    averageMinutes: avg(trades.map(t => t.minutes)), tByDay: variance > 0 ? mean / Math.sqrt(variance / series.length) : null,
    interval95Bps: intervalByDay(days),
  };
}
