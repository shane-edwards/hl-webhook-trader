// Support and resistance from candles: prices where the market has turned
// more than once. Used to place stops beyond a level and targets before one.
import type { Bar } from '@/lib/autopilot/strategies';

export interface Level {
  price: number;
  /** How many separate turning points formed this level. */
  touches: number;
  /** Open time (ms) of the most recent turning point at this level. */
  lastTouch: number;
}

/** Turning points: a bar whose high (or low) is the extreme of the `k` bars either side of it. */
function pivots(bars: Bar[], k: number, from: number): Array<{ price: number; t: number }> {
  const out: Array<{ price: number; t: number }> = [];
  for (let i = Math.max(k, from); i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (bars[j].h > bars[i].h) isHigh = false;
      if (bars[j].l < bars[i].l) isLow = false;
    }
    if (isHigh) out.push({ price: bars[i].h, t: bars[i].t });
    if (isLow) out.push({ price: bars[i].l, t: bars[i].t });
  }
  return out;
}

/**
 * Levels from the last `lookback` hourly bars. Turning points within
 * `tolerance` (a fraction of price) of each other are merged into one level.
 * Minor swings (6 hours either side) and major swings (24 hours either side)
 * both count, so a level that held on both scales has more touches.
 */
export function findLevels(bars: Bar[], tolerance: number, lookback = 720): Level[] {
  const from = Math.max(0, bars.length - lookback);
  const points = [...pivots(bars, 6, from), ...pivots(bars, 24, from)].sort((a, b) => a.price - b.price);
  const levels: Level[] = [];
  let group: typeof points = [];
  const flush = () => {
    if (!group.length) return;
    // The same bar can be both a minor and a major pivot; count distinct bars.
    const distinct = new Set(group.map(p => p.t)).size;
    levels.push({ price: group.reduce((a, p) => a + p.price, 0) / group.length, touches: distinct, lastTouch: Math.max(...group.map(p => p.t)) });
    group = [];
  };
  for (const p of points) {
    if (group.length && p.price > group[0].price * (1 + tolerance)) flush();
    group.push(p);
  }
  flush();
  return levels;
}

export interface Placement { pct: number; price: number; basis: string }

const fmt = (x: number) => (x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x >= 1 ? x.toFixed(2) : x.toPrecision(4));
const describe = (kind: string, l: Level) => `${kind} near ${fmt(l.price)} (${l.touches} touch${l.touches === 1 ? '' : 'es'})`;

/**
 * Stop just beyond the nearest level that protects the trade, if one sits at
 * a usable distance; otherwise null and the caller falls back to volatility.
 * `minPct`/`maxPct` bound the distance so a level hugging the price (noise)
 * or far away (too much risk) is not used.
 */
export function stopBeyondLevel(levels: Level[], price: number, dir: 1 | -1, bufferPct: number, minPct: number, maxPct: number): Placement | null {
  const side = levels
    .filter(l => (dir === 1 ? l.price < price : l.price > price))
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  // Prefer a level that has held at least twice; settle for a single turning point.
  for (const need of [2, 1]) {
    for (const l of side) {
      if (l.touches < need) continue;
      const stop = l.price * (1 - dir * bufferPct / 100);
      const pct = (dir * (price - stop) / price) * 100;
      if (pct > maxPct) break; // further levels are further still
      if (pct >= minPct) return { pct, price: stop, basis: `just ${dir === 1 ? 'below support' : 'above resistance'} ${describe('', l).trim()}` };
    }
  }
  return null;
}

/**
 * Target just before the first level in the trade's way that pays at least
 * `minR` times the stop; otherwise null and the caller uses a fixed multiple.
 */
export function targetBeforeLevel(levels: Level[], price: number, dir: 1 | -1, bufferPct: number, stopPct: number, minR: number, maxR: number): Placement | null {
  const ahead = levels
    .filter(l => (dir === 1 ? l.price > price : l.price < price) && l.touches >= 2)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  for (const l of ahead) {
    const target = l.price * (1 - dir * bufferPct / 100);
    const pct = (dir * (target - price) / price) * 100;
    if (pct > maxR * stopPct) break;
    if (pct >= minR * stopPct) return { pct, price: target, basis: `just ${dir === 1 ? 'below resistance' : 'above support'} ${describe('', l).trim()}` };
  }
  return null;
}
