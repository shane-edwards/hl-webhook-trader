export const SCALP_MARKETS = ['BTC', 'ETH', 'SOL'] as const;
export const SCALP_INTERVALS = { '5m': 300_000, '15m': 900_000 } as const;
export type ScalpMarket = typeof SCALP_MARKETS[number];
export type ScalpInterval = keyof typeof SCALP_INTERVALS;
export interface ScalpBar { t: number; o: number; h: number; l: number; c: number; v: number }

export const SCALP_RULES = [
  { id: 'vwap', name: 'Rolling VWAP reclaim', source: 'https://www.tradingview.com/script/ZU2UUu9T-Rolling-VWAP/', description: 'Close crosses a two-hour VWAP in the direction of the four-hour SMA trend.' },
  { id: 'sweep', name: 'Range sweep and reclaim', source: 'https://in.tradingview.com/script/JRqryeJ5-Liquidity-Sweeps-LuxAlgo/', description: 'Price wicks through the previous two-hour range and closes back inside it. Skip bars that sweep both sides.' },
  { id: 'opening', name: 'Opening range breakout', source: 'https://www.tradingview.com/script/b7IJ7mmW-NQ-Scalping-ORB-VWAP-Bias-ATR-Brackets/', description: 'In the first two UTC hours, take the first close crossing the initial 30-minute range in the direction of session VWAP.' },
  { id: 'squeeze', name: 'Volatility squeeze release', source: 'https://www.tradingview.com/script/nqQ1DT5a-Squeeze-Momentum-Indicator-LazyBear/', description: 'Trade in the direction of momentum when 20-bar Bollinger bands expand beyond a 1.5 ATR channel after compression.' },
  { id: 'bands', name: 'VWAP band reversal', source: 'https://www.tradingview.com/script/P8OmXhlb-Simple-VWAP-Bands/', description: 'Fade a wick that pierces the prior two-hour VWAP’s two-standard-deviation band and closes back inside it.' },
] as const;
export type RuleId = typeof SCALP_RULES[number]['id'];
type Side = 1 | -1;
type Order = { side: Side; distance: number };
type Position = { side: Side; entry: number; t: number; stop: number; target: number };
export type ScalpTrade = { t: number; grossBps: number; netBps: number; stressBps: number; costBps: number };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export function scalpCoverage(bars: ScalpBar[], interval: ScalpInterval, from: number, to: number): number {
  const ms = SCALP_INTERVALS[interval];
  if (bars.some((bar, i) => !Object.values(bar).every(Number.isFinite) || bar.t % ms !== 0 || bar.o <= 0 || bar.c <= 0 || bar.l <= 0 || bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c) || bar.v < 0 || (i > 0 && bars[i - 1].t >= bar.t))) {
    throw new Error('Invalid or duplicate candle');
  }
  return bars.filter(b => b.t >= from && b.t < to).length / ((to - from) / ms);
}

function intervalPrefix(values: number[], end: number, length: number): number {
  return values[end + 1] - values[Math.max(0, end + 1 - length)];
}

/** Rules consume completed bars. A signal can only fill at the following bar's open. */
export function replayScalp(bars: ScalpBar[], interval: ScalpInterval, ruleId: RuleId, from: number, to: number): ScalpTrade[] {
  const ms = SCALP_INTERVALS[interval];
  const window = 2 * HOUR / ms;
  const average = 4 * HOUR / ms;
  const trades: ScalpTrade[] = [];
  const volume = [0], weighted = [0], close = [0], trueRange = [0];
  const closeSquared = [0], weightedSquared = [0];
  let day = -1, start = 0, tradesToday = 0, rangeHigh = -Infinity, rangeLow = Infinity;
  let continuousStart = 0;
  let position: Position | undefined;
  let order: Order | undefined;

  function settle(p: Position, px: number, t: number, stopped = false) {
    const exitNotional = px / p.entry;
    const grossBps = p.side * (exitNotional - 1) * 10_000;
    // 4.5 bp taker + 2 bp adverse execution per fill. Stress adds 3 bp per fill.
    // Charge 1 bp at each crossed hourly boundary in either direction as a funding proxy.
    const funding = Math.max(0, Math.floor(t / HOUR) - Math.floor(p.t / HOUR));
    const costBps = 6.5 * (1 + exitNotional) + (stopped ? 3 * exitNotional : 0) + funding;
    trades.push({ t, grossBps, costBps, netBps: grossBps - costBps, stressBps: grossBps - costBps - 3 * (1 + exitNotional) });
    position = undefined;
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.t >= to) break;
    const prev = bars[i - 1];
    const gap = !prev || bar.t - prev.t !== ms;
    if (gap) {
      if (position) settle(position, bar.o, bar.t, true);
      continuousStart = i;
      order = undefined;
    }
    const dayStart = Math.floor(bar.t / DAY) * DAY;
    if (dayStart !== day) {
      day = dayStart;
      start = i;
      tradesToday = 0;
      rangeHigh = -Infinity;
      rangeLow = Infinity;
    }

    if (position && bar.t - position.t >= HOUR) settle(position, bar.o, bar.t);
    const last = !bars[i + 1] || bars[i + 1].t >= to;
    if (order && bar.t >= from) {
      const { side, distance } = order;
      const stop = bar.o - side * distance;
      const target = bar.o + side * distance * 1.5;
      if (stop > 0 && target > 0) {
        position = { side, entry: bar.o, t: bar.t, stop, target };
        tradesToday++;
      }
    }
    order = undefined;
    if (position) {
      const { side, stop, target } = position;
      // If both levels are touched in one candle, take the stop first. Never improve the target fill on a gap.
      if (side === 1 ? bar.l <= stop : bar.h >= stop) settle(position, side === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o), bar.t, true);
      else if (side === 1 ? bar.h >= target : bar.l <= target) settle(position, target, bar.t);
      else if (last) settle(position, bar.c, bar.t + ms - 1);
    }

    volume.push(volume[i] + bar.v);
    const typicalPrice = (bar.h + bar.l + bar.c) / 3;
    weighted.push(weighted[i] + typicalPrice * bar.v);
    weightedSquared.push(weightedSquared[i] + typicalPrice ** 2 * bar.v);
    close.push(close[i] + bar.c);
    closeSquared.push(closeSquared[i] + bar.c ** 2);
    trueRange.push(trueRange[i] + (gap ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c))));
    const sinceOpen = bar.t - day;
    if (sinceOpen < HOUR / 2) {
      rangeHigh = Math.max(rangeHigh, bar.h);
      rangeLow = Math.min(rangeLow, bar.l);
    }
    if (bar.t < from || last || position || i - continuousStart < average) continue;
    const relativeVolume = intervalPrefix(volume, i - 1, window) / window;
    if (relativeVolume <= 0 || bar.v < 1.5 * relativeVolume) continue;
    const vwap = (end: number, length: number) => intervalPrefix(weighted, end, length) / intervalPrefix(volume, end, length);
    let side: Side | undefined;
    if (ruleId === 'vwap') {
      const now = vwap(i, window), before = vwap(i - 1, window);
      const trend = intervalPrefix(close, i - 1, average) / average;
      if (bar.c > now && prev.c <= before && bar.c > trend) side = 1;
      if (bar.c < now && prev.c >= before && bar.c < trend) side = -1;
    } else if (ruleId === 'sweep') {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - window; j < i; j++) {
        hi = Math.max(hi, bars[j].h);
        lo = Math.min(lo, bars[j].l);
      }
      if (bar.l < lo && bar.h <= hi && bar.c > lo) side = 1;
      if (bar.h > hi && bar.l >= lo && bar.c < hi) side = -1;
    } else if (ruleId === 'squeeze') {
      const compressed = (end: number) => {
        const mean = intervalPrefix(close, end, 20) / 20;
        const sd = Math.sqrt(Math.max(0, intervalPrefix(closeSquared, end, 20) / 20 - mean ** 2));
        return 2 * sd < 1.5 * intervalPrefix(trueRange, end, 20) / 20;
      };
      if (compressed(i - 1) && !compressed(i) && bar.c !== bars[i - 20].c) {
        side = bar.c > bars[i - 20].c ? 1 : -1;
      }
    } else if (ruleId === 'bands') {
      const mean = vwap(i - 1, window);
      const sd = Math.sqrt(Math.max(0, intervalPrefix(weightedSquared, i - 1, window) / intervalPrefix(volume, i - 1, window) - mean ** 2));
      const lower = mean - 2 * sd, upper = mean + 2 * sd;
      if (bar.c > lower && bar.c < upper) {
        if (bar.l < lower && bar.h <= upper) side = 1;
        if (bar.h > upper && bar.l >= lower) side = -1;
      }
    } else if (sinceOpen >= HOUR / 2 && sinceOpen + ms < 2 * HOUR && tradesToday === 0 && bars[start].t === day && continuousStart <= start) {
      const session = vwap(i, i - start + 1);
      if (bar.c > rangeHigh && prev.c <= rangeHigh && bar.c > session) side = 1;
      if (bar.c < rangeLow && prev.c >= rangeLow && bar.c < session) side = -1;
    }
    const distance = 1.5 * intervalPrefix(trueRange, i, 14) / 14;
    if (side && distance > 0) order = { side, distance };
  }
  return trades;
}

export function summarizeScalps(byMarket: ScalpTrade[][]) {
  const trades = byMarket.flat();
  const total = (key: keyof ScalpTrade) => trades.reduce((sum, trade) => sum + trade[key], 0);
  const average = (key: keyof ScalpTrade) => trades.length ? total(key) / trades.length : null;
  const positiveMarkets = byMarket.filter(rows => rows.reduce((sum, trade) => sum + trade.netBps, 0) > 0).length;
  const daily = new Map<number, number>();
  for (const trade of trades) {
    const day = Math.floor(trade.t / DAY);
    daily.set(day, (daily.get(day) ?? 0) + trade.netBps);
  }
  return {
    trades: trades.length, grossBps: average('grossBps'), netBps: average('netBps'), stressBps: average('stressBps'),
    costBps: average('costBps'), positiveMarkets, activeDays: daily.size,
    positiveDays: [...daily.values()].filter(net => net > 0).length,
  };
}
