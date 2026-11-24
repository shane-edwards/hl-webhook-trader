import { ruleKey, type Experiment, type Rule } from './model';

// Sample complete entry/exit pairs, so genuinely different holding periods remain distinguishable.
const size = 48;
export function fingerprint(rule: Rule, trades: Map<number, number>, fitness: number): Experiment {
  const hashes = new Set<number>();
  for (const [entry, exit] of trades) {
    let h = Math.floor(entry / 60_000) ^ Math.imul(Math.floor((exit-entry)/60_000), 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    hashes.add((h ^ (h >>> 16)) >>> 0);
  }
  return { key: ruleKey(rule), entries: trades.size, sketch: [...hashes].sort((a,b) => a-b).slice(0, size),
    fitness: Number.isFinite(fitness) ? fitness : null };
}

function similar(a: Experiment, b: Experiment) {
  if (Math.min(a.entries, b.entries) < 8 || Math.min(a.entries, b.entries) < .8 * Math.max(a.entries, b.entries)) return false;
  let i = 0, j = 0, common = 0, total = 0;
  while (total < size && (i < a.sketch.length || j < b.sketch.length)) {
    const left = a.sketch[i] ?? Infinity, right = b.sketch[j] ?? Infinity;
    if (left === right) common++;
    if (left <= right) i++;
    if (right <= left) j++;
    total++;
  }
  return total > 0 && common / total >= .8;
}

export function compareExperiments(current: Experiment, previous: Experiment[]) {
  if (previous.some(p => p.key === current.key)) return 'repeat';
  const direction = current.key.split(':', 1)[0] + ':';
  return previous.some(p => p.key.startsWith(direction) && similar(current, p)) ? 'similar' : 'new';
}
