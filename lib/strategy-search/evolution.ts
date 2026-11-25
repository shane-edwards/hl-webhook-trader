import { SETUPS, TRIGGERS, type ContextFactor, type Recipe, type Rule, type SearchBar, type SearchSide } from './model';

const setups = Object.keys(SETUPS) as (keyof typeof SETUPS)[];
const triggers = Object.keys(TRIGGERS) as (keyof typeof TRIGGERS)[];
export type Sequence = Extract<Rule, { family: 'sequence' }>;

export function sequenceKey({ setup, trigger, within, context }: Recipe) {
  return [setup, trigger, within, ...(context ? [context] : [])].join('/');
}

// The orientation transform in searchInputs lets exactly the same grammar express short trades.
export function sequenceFeatures(bars: SearchBar[], atr: number[], side: SearchSide = 'long') {
  const contexts = Object.fromEntries(setups.map(k => [k, []])) as unknown as Record<Recipe['setup'], number[]>;
  const confirmations = Object.fromEntries(triggers.map(k => [k, []])) as unknown as Record<Recipe['trigger'], number[]>;
  let pivot = Infinity;
  let sum = 0, previousMean = 0;
  for (let i = 0; i < bars.length - 1; i++) {
    const b = bars[i];
    sum += b.c - (i >= 10 ? bars[i - 10].c : 0);
    const mean = sum / Math.min(10, i + 1);
    if (i >= 12) {
      const p = bars[i - 1], q = bars[i - 2];
      if (q.h > bars[i - 3].h && q.h >= p.h) pivot = q.h;
      let low = Infinity, high = -Infinity, narrow = Infinity;
      for (let j = 1; j <= 10; j++) {
        const old = bars[i - j];
        low = Math.min(low, old.l);
        if (j <= 5) high = Math.max(high, old.h);
        if (j <= 6) narrow = Math.min(narrow, old.h - old.l);
      }
      const width = b.h - b.l;
      if (width <= narrow) contexts.coil.push(i);
      if (b.c < bars[i - 3].c - 2 * atr[i - 1]) contexts.washout.push(i);
      if (b.l > p.l && p.l > q.l) contexts.shelf.push(i);
      if (mean > previousMean && b.c < p.c && b.l <= mean) contexts.pullback.push(i);
      if (b.l < low && b.c > low) contexts.sweep.push(i);
      if (b.c - b.o > atr[i - 1]) contexts.impulse.push(i);
      if (b.h < p.h && b.l > p.l) contexts.balance.push(i);
      if (b.c < p.c && p.c < q.c && q.c < bars[i - 3].c) contexts.fade.push(i);
      if (b.c > (p.h + p.l) / 2 && p.c <= (p.h + p.l) / 2) confirmations.midpoint.push(i);
      if (p.c < p.o && b.o <= p.c && b.c > p.o) confirmations.engulf.push(i);
      if (b.c > high) confirmations.channel.push(i);
      if (width > 0 && b.c > b.o && b.c >= b.h - .15 * width && b.c > p.c) confirmations.thrust.push(i);
      if (b.c > pivot && p.c <= pivot) confirmations.pivot.push(i);
      if (b.c > mean && p.c <= previousMean) confirmations.reclaim.push(i);
      if (b.c - p.c > p.c - q.c && p.c > q.c && b.c - q.c > atr[i - 1]) confirmations.acceleration.push(i);
      if (b.h > p.h && b.l < p.l && b.c > p.h) confirmations.outside.push(i);
    }
    previousMean = mean;
  }
  const cache = new Map<string, number[]>();
  return (recipe: Recipe) => {
    const key = sequenceKey(recipe);
    const cached = cache.get(key);
    if (cached) return cached;
    const context = contexts[recipe.setup];
    let index = -1;
    const entries = confirmations[recipe.trigger].filter(i => {
      while (index + 1 < context.length && context[index + 1] < i) index++;
      if (recipe.context) {
        const value = bars[i][recipe.context];
        const interest = recipe.context === 'openInterest' || recipe.context === 'binanceInterest';
        const funding = recipe.context === 'fundingChange' || recipe.context === 'venueFunding';
        const sign = interest ? 1 : (side === 'long' ? 1 : -1) * (funding ? -1 : 1);
        if (value === undefined || !(sign * value > 0)) return false;
      }
      return i >= 110 && index >= 0 && i - context[index] <= recipe.within;
    });
    cache.set(key, entries);
    return entries;
  };
}

export function seedRecipes(side: SearchSide, epoch: number, count = 20): Sequence[] {
  // Multiplication by an odd number permutes all 64 ordered pairs without repetition.
  return Array.from({ length: count }, (_, n) => {
    const code = ((epoch % 64) * 13 + n * 19) % 64;
    // Rotate timing and exits too, so the 65th seed batch can explore different rules.
    const mix = Math.imul(epoch ^ Math.imul(code + 1, 2654435761), 2246822519) >>> 0;
    return { family: 'sequence', side, setting: 10, recipe: { setup: setups[code % 8], trigger: triggers[Math.floor(code / 8)], within: [2, 4, 7][mix % 3] },
      trend: 0, volume: 0, stop: [1.25, 1.75, 2.5][(mix >>> 8) % 3], reward: [1.2, 1.8, 2.5][(mix >>> 16) % 3],
      maxBars: [6, 12, 18][(mix >>> 24) % 3] };
  });
}

type Ranked = { rule: Sequence; fitness: number; signature: Set<number>; familiar?: boolean };
function diverse(pool: Ranked[], count: number) {
  const picked: Ranked[] = [];
  for (const next of [...pool].sort((a,b) => Number(!!a.familiar) - Number(!!b.familiar) || b.fitness - a.fitness)) {
    if (picked.every(p => {
      let common = 0;
      for (const i of p.signature) if (next.signature.has(i)) common++;
      const union = p.signature.size + next.signature.size - common;
      return union > 0 && common / union < .8;
    })) picked.push(next);
    if (picked.length === count) break;
  }
  return picked;
}

export function evolve(side: SearchSide, epoch: number, score: (rule: Sequence) => Omit<Ranked, 'rule'>, factors: ContextFactor[] = []) {
  let generation = seedRecipes(side, epoch);
  const contextual = factors.flatMap((context, i) => generation.slice(i * 4, i * 4 + 4).map(rule =>
    ({ ...rule, recipe: { ...rule.recipe, context } })));
  generation.push(...contextual);
  const visited = new Set<string>(), pairs = new Set<string>(), pool: Ranked[] = [];
  for (let round = 0; round < 3; round++) {
    for (const rule of generation) {
      const id = [sequenceKey(rule.recipe),rule.trend,rule.stop,rule.reward,rule.maxBars].join(':');
      if (visited.has(id)) continue;
      visited.add(id);
      pairs.add(rule.recipe.setup + '/' + rule.recipe.trigger);
      const result = score(rule);
      if (Number.isFinite(result.fitness)) pool.push({ rule, ...result });
    }
    const parents = diverse(pool, 6);
    const immigrants = seedRecipes(side,epoch + 1 + round,4);
    generation = parents.flatMap(({ rule: left }, i) => {
      const right = parents[(i + 1 + round) % parents.length].rule;
      const cross = { ...left.recipe, trigger: right.recipe.trigger };
      return [
        { ...left, recipe: { ...cross, within: round === 0 ? 2 : 7 }, reward: right.reward },
        { ...left, recipe: cross, trend: round === 0 ? 35 : 80, maxBars: round === 0 ? 6 : 18 },
        { ...right, recipe: { ...right.recipe, setup: left.recipe.setup }, stop: round === 0 ? 1.25 : 2.5, reward: 2.5 },
      ];
    });
    generation.push(...immigrants);
  }
  return { tried: visited.size, pairs, finalists: diverse(pool, 6).map(p => p.rule) };
}
