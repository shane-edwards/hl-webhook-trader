// One table for "which forward test is making the most money". Every test's closed results are put on the
// same footing, a share of the capital the test needs, and set against what the same money would have
// earned in Hyperliquid's HLP vault over the same dates. Each row is also judged against one bar: the record
// a test needs before real money is worth considering. Pure functions; lib/automation/scoreboard-read.ts
// gathers the tests. Nothing here changes what Paper or Live trades.
import { STRATEGIES } from '@/lib/autopilot/strategies';

const DAY = 86_400_000;

/**
 * The record a test needs before it is worth considering real money: long enough to have seen more than one
 * kind of market, enough results, ahead of simply holding HLP, a bearable worst drop, not resting on one coin,
 * and an average result unlikely to be luck. Trade results are judged by day, because coins move together:
 * ten trades closing on one bad day are one result, not ten.
 */
export const SCOREBOARD_BAR = { days: 56, trades: 50, weeks: 8, events: 20, maxDrawdown: 0.1, tStat: 2 } as const;

export type Unit = 'trades' | 'weeks' | 'events';
export type Market = 'crypto' | 'stocks';
/** One closed result: when it closed, what it made as a fraction of the test's capital, and on which asset. */
export type Close = { at: number; value: number; asset?: string };

export interface TestInput {
  id: string; name: string; detail: string; market: Market; unit: Unit;
  /** When the test began recording (ms). Null when it has not started. */
  start: number | null;
  /** The dollar amount the fractions are measured against, when the test has one. */
  capitalUsd: number | null;
  closes: Close[]; open: number;
  /** Set when the test's results could not be read or it cannot run yet. */
  unavailable?: string;
}

export interface Check { label: string; value: string; met: boolean }

export interface ScoreRow {
  id: string; name: string; detail: string; market: Market; unit: Unit;
  started: string | null; days: number; capitalUsd: number | null;
  closed: number; open: number;
  /** Closed results added up, as a fraction of capital. Null before anything has closed. */
  ret: number | null;
  netUsd: number | null;
  /** What HLP would have paid over the same days at its current yearly rate. */
  hlp: number | null;
  /** Deepest fall of the running total from its high, as a fraction of capital. */
  drawdown: number | null;
  tStat: number | null;
  /** The asset that contributed most, and the total without it. */
  best: { asset: string; without: number } | null;
  checks: Check[];
  /** What is still missing on time and sample size, in short words. */
  missing: string[];
  verdict: string;
  ready: boolean;
  unavailable?: string;
}

export interface Scoreboard {
  rows: ScoreRow[];
  /** HLP's current yearly rate (its last 90 days), the yardstick in every row. */
  hlpAnnual: number | null;
  bar: typeof SCOREBOARD_BAR;
  asOf: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const pct = (v: number | null, digits = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(digits)}%`);

/** One-sided t-statistic of the mean: is the average result distinguishable from zero? */
export function tStatistic(values: number[]) {
  const n = values.length;
  if (n < 2) return null;
  const mean = sum(values) / n;
  const deviation = Math.sqrt(values.reduce((total, v) => total + (v - mean) ** 2, 0) / (n - 1));
  // Identical results carry no information about variability, so they never produce a statistic.
  return deviation > Math.abs(mean) * 1e-9 && deviation > 0 ? mean / (deviation / Math.sqrt(n)) : null;
}

/** Closed results summed by UTC day from the test's first day to today, with quiet days as zero. */
export function dailyResults(closes: Close[], start: number, now: number) {
  const first = Math.floor(start / DAY), days = new Array(Math.max(0, Math.floor(now / DAY) - first + 1)).fill(0);
  for (const close of closes) {
    const i = Math.floor(close.at / DAY) - first;
    if (i >= 0 && i < days.length) days[i] += close.value;
  }
  return days;
}

export function scoreTest(test: TestInput, now: number, hlpAnnual: number | null): ScoreRow {
  const closes = test.closes.filter(c => Number.isFinite(c.at) && Number.isFinite(c.value)).sort((a, b) => a.at - b.at);
  const start = test.start ?? closes[0]?.at ?? null;
  const days = start == null ? 0 : Math.max(0, (now - start) / DAY);
  const closed = closes.length;
  const ret = closed ? sum(closes.map(c => c.value)) : null;
  let running = 0, peak = 0, drop = 0;
  for (const close of closes) {
    running += close.value;
    peak = Math.max(peak, running);
    drop = Math.max(drop, peak - running);
  }
  const drawdown = closed ? drop : null;
  const hlp = hlpAnnual != null && start != null ? (1 + hlpAnnual) ** (days / 365) - 1 : null;
  const tStat = start == null || !closed ? null : tStatistic(test.unit === 'trades' ? dailyResults(closes, start, now) : closes.map(c => c.value));
  const byAsset = new Map<string, number>();
  for (const close of closes) if (close.asset) byAsset.set(close.asset, (byAsset.get(close.asset) ?? 0) + close.value);
  const top = [...byAsset].sort((a, b) => b[1] - a[1])[0];
  const best = top && ret != null ? { asset: top[0], without: ret - top[1] } : null;

  const need = SCOREBOARD_BAR[test.unit];
  const assetWord = test.market === 'stocks' ? 'stock' : 'coin';
  const checks: Check[] = [
    { label: 'Time', value: `${Math.floor(days)} of ${SCOREBOARD_BAR.days} days`, met: days >= SCOREBOARD_BAR.days },
    { label: 'Closed results', value: `${closed} of ${need} ${test.unit}`, met: closed >= need },
    { label: 'Ahead of HLP', value: `${pct(ret)} against ${pct(hlp)}`, met: ret != null && ret > Math.max(0, hlp ?? 0) },
    { label: 'Worst drop', value: drawdown == null ? '—' : `${pct(-drawdown)} (limit ${pct(-SCOREBOARD_BAR.maxDrawdown, 0)})`,
      met: drawdown != null && drawdown <= SCOREBOARD_BAR.maxDrawdown },
    { label: `Without its best ${assetWord}`, value: best ? `${pct(best.without)} without ${best.asset}` : 'Not applicable',
      met: best ? best.without > 0 : closed > 0 },
    { label: 'Unlikely to be luck', value: tStat == null ? 'Not enough results' : `t-statistic ${tStat.toFixed(2)} (needs ${SCOREBOARD_BAR.tStat})`,
      met: tStat != null && tStat >= SCOREBOARD_BAR.tStat },
  ];
  const missing = [
    ...(start != null && days < SCOREBOARD_BAR.days ? [`${Math.ceil(SCOREBOARD_BAR.days - days)} more days`] : []),
    ...(closed < need ? [`${need - closed} more ${test.unit}`] : []),
  ];
  const ready = !test.unavailable && checks.every(check => check.met);
  const verdict = test.unavailable ? test.unavailable
    : !closed ? (test.open ? 'Open, nothing closed yet' : 'No closed results yet')
    : ready ? 'Meets the bar'
    : ret! <= 0 ? 'Losing so far'
    : hlp != null && ret! <= hlp ? 'Behind HLP so far'
    : 'Ahead of HLP so far';

  return {
    id: test.id, name: test.name, detail: test.detail, market: test.market, unit: test.unit,
    started: start == null ? null : new Date(start).toISOString().slice(0, 10), days, capitalUsd: test.capitalUsd,
    closed, open: test.open, ret, netUsd: ret != null && test.capitalUsd != null ? ret * test.capitalUsd : null,
    hlp, drawdown, tStat, best, checks, missing, verdict, ready, ...(test.unavailable ? { unavailable: test.unavailable } : {}),
  };
}

/** Every test scored and ranked: the most money first, then the tests with nothing closed, then any that could not be read. */
export function buildScoreboard(tests: TestInput[], now: number, hlpAnnual: number | null): Scoreboard {
  const rank = (row: ScoreRow) => (row.unavailable ? 2 : row.ret == null ? 1 : 0);
  const rows = tests.map(test => scoreTest(test, now, hlpAnnual))
    .sort((a, b) => rank(a) - rank(b) || (b.ret ?? 0) - (a.ret ?? 0) || b.open - a.open || a.name.localeCompare(b.name));
  return { rows, hlpAnnual, bar: SCOREBOARD_BAR, asOf: now };
}

// ---- turning each forward test's own records into closed results ----

export type PaperPosition = {
  strategy_id: string; symbol: string; side: string; status: string;
  entry_time: string; exit_time: string | null; pnl: number | string | null; notional_usd: number | string;
};

/**
 * Keep a position only if the same rule had nothing open on that coin when it opened. This is how Paper runs
 * now, and it removes the stacked entries an earlier version made while one setup stayed true for hours.
 */
export function onePerCoin<T extends PaperPosition>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.strategy_id}|${row.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const kept: T[] = [];
  for (const group of groups.values()) {
    let busyUntil = -Infinity;
    for (const row of [...group].sort((a, b) => Date.parse(a.entry_time) - Date.parse(b.entry_time))) {
      if (Date.parse(row.entry_time) < busyUntil) continue;
      kept.push(row);
      busyUntil = row.exit_time ? Date.parse(row.exit_time) : Infinity;
    }
  }
  return kept;
}

const closedResults = (rows: PaperPosition[], capital: number): Close[] => rows
  .filter(row => row.status === 'closed' && row.pnl != null && row.exit_time && Number.isFinite(Number(row.pnl)))
  .map(row => ({ at: Date.parse(row.exit_time!), value: Number(row.pnl) / capital, asset: row.symbol }));

/**
 * Each Autopilot rule and direction in Paper. Capital is the fixed paper stake for every coin the rule may
 * trade, because that money has to be set aside whether or not a signal comes.
 */
export function paperRuleTests(rows: PaperPosition[], coins: number): TestInput[] {
  const kept = onePerCoin(rows.filter(row => STRATEGIES.some(s => s.id === row.strategy_id)));
  return STRATEGIES.flatMap(strategy => (['long', 'short'] as const).map(side => {
    const line = kept.filter(row => row.strategy_id === strategy.id && row.side === side);
    // The usual position size, so an odd older entry sized another way does not set the capital.
    const sizes = line.map(row => Number(row.notional_usd)).filter(size => Number.isFinite(size) && size > 0).sort((a, b) => a - b);
    const stake = sizes.length ? sizes[Math.floor((sizes.length - 1) / 2)] : 0;
    const width = Math.max(coins, new Set(kept.filter(row => row.strategy_id === strategy.id).map(row => row.symbol)).size);
    const capital = stake > 0 ? stake * width : null;
    return {
      id: `paper.${strategy.id}.${side}`, name: `${strategy.name} · ${side}`, market: 'crypto' as const, unit: 'trades' as const,
      detail: capital ? `Paper · $${stake.toLocaleString('en-US')} a position on up to ${width} coins` : `Paper · up to ${width} coins`,
      start: line.length ? Math.min(...line.map(row => Date.parse(row.entry_time))) : null,
      capitalUsd: capital, closes: capital ? closedResults(line, capital) : [],
      open: line.filter(row => row.status === 'open').length,
    };
  }));
}

/** The weekly momentum basket in Paper. Capital is the most it had open at once, long and short legs together. */
export function momentumTest(legs: PaperPosition[]): TestInput {
  const moves = legs.flatMap(row => {
    const size = Number(row.notional_usd);
    return [{ t: Date.parse(row.entry_time), d: size }, ...(row.exit_time ? [{ t: Date.parse(row.exit_time), d: -size }] : [])];
  }).filter(move => Number.isFinite(move.t) && Number.isFinite(move.d)).sort((a, b) => a.t - b.t || a.d - b.d);
  let open = 0, peak = 0;
  for (const move of moves) { open += move.d; peak = Math.max(peak, open); }
  return {
    id: 'paper.momentum', name: 'Momentum basket (90-day)', market: 'crypto', unit: 'trades',
    detail: 'Paper · weekly, long the strongest quarter of coins, short the weakest',
    start: legs.length ? Math.min(...legs.map(row => Date.parse(row.entry_time))) : null,
    capitalUsd: peak > 0 ? peak : null, closes: peak > 0 ? closedResults(legs, peak) : [],
    open: legs.filter(row => row.status === 'open').length,
  };
}

/** The weekly funding carry basket. Its weekly results are already fractions of its capital. */
export function fundingBasketTest(weeks: { ended: string; price: number; funding: number; cost: number }[], start: number, holding: boolean): TestInput {
  return {
    id: 'forward.funding_basket', name: 'Funding carry basket', market: 'crypto', unit: 'weeks',
    detail: 'Record only · weekly, long the coins paying the least funding, short those paying the most',
    start, capitalUsd: null, open: holding ? 1 : 0,
    closes: weeks.map(week => ({ at: Date.parse(`${week.ended}T00:00:00Z`), value: week.price + week.funding - week.cost })),
  };
}

/** The crowded break trade. Each trade is a fraction of one coin's equal share of the capital. */
export function crowdedBreakTest(trades: { symbol: string; status: string; exit_day: string | null; net: number | string | null }[],
  start: number, coins: number): TestInput {
  return {
    id: 'forward.crowded_break', name: 'Crowded break', market: 'crypto', unit: 'trades',
    detail: `Record only · daily, follows a breakout against crowded positioning on ${coins} coins`,
    start, capitalUsd: null, open: trades.filter(trade => trade.status === 'open').length,
    closes: trades.filter(trade => trade.status === 'closed' && trade.exit_day && trade.net != null && Number.isFinite(Number(trade.net)))
      .map(trade => ({ at: Date.parse(`${trade.exit_day}T00:00:00Z`), value: Number(trade.net) / coins, asset: trade.symbol })),
  };
}

/** The spot and perpetual funding hedge: simulated dollars on a fixed amount of capital per coin. */
export function fundingHedgeTest(closes: { symbol: string; at: string; net: number }[], start: number | null, open: number,
  capitalPerCoin: number, coins: string[]): TestInput {
  const capital = capitalPerCoin * coins.length;
  return {
    id: 'forward.funding_hedge', name: `Funding hedge (${coins.join(', ')})`, market: 'crypto', unit: 'trades',
    detail: `Record only · long spot and short perpetual while funding is high, $${capitalPerCoin.toLocaleString('en-US')} a coin`,
    start, capitalUsd: capital, open,
    closes: closes.map(close => ({ at: Date.parse(close.at), value: close.net / capital, asset: close.symbol })),
  };
}

/** The event studies: one position per event, each result a fraction of that position. */
export function eventTests(studies: { id: string; name: string; rule: string; needsConnection?: boolean;
  results: { date: string; net: number | null }[] }[]): TestInput[] {
  return studies.map(study => {
    const closes = study.results.filter(result => result.net != null && Number.isFinite(result.net))
      .map(result => ({ at: Date.parse(`${result.date}T00:00:00Z`), value: result.net! }));
    return {
      id: `event.${study.id}`, name: study.name, market: study.id === 'unlock' ? 'crypto' as const : 'stocks' as const, unit: 'events' as const,
      detail: study.rule, start: closes.length ? Math.min(...closes.map(close => close.at)) : null, capitalUsd: null, closes, open: 0,
      ...(study.needsConnection ? { unavailable: 'Connect eToro Demo to run this test' } : {}),
    };
  });
}
