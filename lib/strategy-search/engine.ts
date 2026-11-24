import { BAR_MS, FAMILIES, RULE_INTERPRETER_VERSION, ruleKey, searchOutcomes, searchRevision, type Family, type Performance, type Rule, type SearchBar, type SearchOutcome,
  type SearchPair, type SearchReport, type SearchSide, type ForwardBook, type ForwardFill } from './model';
import { evolve, sequenceFeatures } from './evolution';
import { compareExperiments, fingerprint } from './experiments';
import type { ContextFactor, Experiment } from './model';

const DAY = 86_400_000;
const WARMUP = 110;
const date = (time: number) => new Date(time).toISOString().slice(0, 10);
const signalSettings = [8, 14, 24, 40];
const trendSettings = [0, 35, 80];

function rolling(values: number[], period: number) {
  let sum = 0;
  return values.map((value, i) => {
    sum += value - (i >= period ? values[i - period] : 0);
    return sum / Math.min(i + 1, period);
  });
}

function ema(values: number[], period: number) {
  let value = values[0];
  const weight = 2 / (1 + period);
  return values.map(next => (value += (next - value) * weight));
}

function supertrendEntries(bars: SearchBar[], ranges: number[], period: number, side: SearchSide) {
  let upper = Infinity, lower = side === 'short' ? -Infinity : 0, rising = false;
  let atr = ranges.slice(0, period).reduce((sum, n) => sum + n, 0) / period;
  const indices = [];
  for (let i = period; i < bars.length - 1; i++) {
    atr += (ranges[i] - atr) / period;
    const bar = bars[i], priorClose = bars[i - 1].c, mid = (bar.h + bar.l) / 2;
    const top = mid + 2.5 * atr, bottom = mid - 2.5 * atr;
    upper = top < upper || priorClose > upper ? top : upper;
    lower = bottom > lower || priorClose < lower ? bottom : lower;
    const nextRising: boolean = rising ? bar.c >= lower : bar.c > upper;
    if (i >= WARMUP && nextRising && !rising) indices.push(i);
    rising = nextRising;
  }
  return indices;
}

export function searchInputs(bars: SearchBar[], volumeThrough = bars.length, side: SearchSide = 'long') {
  // Reflect prices for the entry indicators. Orders, stops, costs and funding use real prices below.
  const oriented = side === 'short' ? bars.map(bar => ({ ...bar, o: -bar.o, h: -bar.l, l: -bar.h, c: -bar.c })) : bars;
  const closes = oriented.map(bar => bar.c);
  const volume = bars.map(bar => Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0);
  const hasVolume = volume.slice(0, volumeThrough).filter(value => value > 0).length >= .95 * volumeThrough;
  const volumeAverage = rolling(volume, 30);
  const trend = new Map(trendSettings.filter(Boolean).map(period => [period, ema(closes, period)]));
  const ranges = oriented.map((bar, i) => i === 0 ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - closes[i - 1]), Math.abs(bar.l - closes[i - 1])));
  const atr = rolling(ranges, 14);
  const delta = closes.map((close, i) => i ? close - closes[i - 1] : 0);
  const signals = new Map<string, number[]>();
  for (const period of signalSettings) {
    const up = rolling(delta.map(n => Math.max(n, 0)), period);
    const down = rolling(delta.map(n => Math.max(-n, 0)), period);
    const rsi = up.map((gain, i) => gain + down[i] > 0 ? 100 * gain / (gain + down[i]) : 50);
    const mid = rolling(closes, period);
    const square = rolling(closes.map(n => n ** 2), period);
    const widths = mid.map((average, i) => 2 * Math.sqrt(Math.max(0, square[i] - average ** 2)));
    const lower = mid.map((average, i) => average - widths[i]);
    const keltner = rolling(ranges, period);
    // Volatility-compression hypothesis inspired by LazyBear's public Squeeze Momentum write-up.
    const compressed = widths.map((width, i) => width < 1.5 * keltner[i]);
    const weighted = rolling(oriented.map((bar, i) => (bar.h + bar.l + bar.c) / 3 * volume[i]), period);
    const averageVolume = rolling(volume, period);
    const volumeCoverage = rolling(volume.map(v => Number(v > 0)), period);
    const vwap = weighted.map((n, i) => n / averageVolume[i]);
    const fast = ema(closes, Math.max(4, Math.round(period / 2)));
    const slow = ema(closes, period);
    const macd = fast.map((n, i) => n - slow[i]);
    const macdAverage = ema(macd, Math.max(3, Math.round(period / 3)));
    const family: Record<Family, number[]> = { range: [], rsi: [], vwap: [], band: [], macd: [], squeeze: [], supertrend: supertrendEntries(oriented, ranges, period, side) };
    for (let i = WARMUP; i < bars.length - 1; i++) {
      const close = closes[i], previous = closes[i - 1];
      if (close > oriented[i - 1].h) {
        let top = oriented[i - 1].h;
        for (let j = i - period; j < i - 1; j++) top = Math.max(top, oriented[j].h);
        if (close > top) family.range.push(i);
      }
      if (rsi[i - 1] <= 35 && rsi[i] > 35) family.rsi.push(i);
      if (hasVolume && volumeCoverage[i] >= .95 && volumeCoverage[i - 1] >= .95 && previous <= vwap[i - 1] && close > vwap[i]) family.vwap.push(i);
      if (previous <= lower[i - 1] && close > lower[i]) family.band.push(i);
      if (macd[i - 1] <= macdAverage[i - 1] && macd[i] > macdAverage[i]) family.macd.push(i);
      if (compressed[i - 1] && !compressed[i] && close > mid[i] && close > previous) family.squeeze.push(i);
    }
    for (const [name, events] of Object.entries(family)) signals.set(`${name}:${period}`, events);
  }
  let sequences: ReturnType<typeof sequenceFeatures> | undefined;
  const entries = (rule: Rule) => rule.family === 'sequence'
    ? (sequences ??= sequenceFeatures(oriented, atr, side))(rule.recipe) : signals.get(`${rule.family}:${rule.setting}`) ?? [];
  return { bars, trend, atr, signals, hasVolume, volume, volumeAverage, entries };
}

type Inputs = ReturnType<typeof searchInputs>;
type Replay = Performance & { exposure: number };

function replay(input: Inputs, rule: Rule, from: number, end: number, edge: number, cluster: number, stockShort = false,
  book?: ForwardBook, delay = 0, sample?: number[], tradeTimes?: Map<number, number>): Replay {
  const { bars, atr, trend, volume, volumeAverage } = input;
  const direction = rule.side === 'short' ? -1 : 1;
  const average = trend.get(rule.trend);
  const groups = new Map<number, number>();
  let equity = 1, peak = 1, drawdown = 0, trades = 0, blockUntil = from, netSum = 0, exposed = 0;
  for (const i of input.entries(rule)) {
    const entryIndex = i + 1 + delay;
    if (entryIndex < blockUntil || i < from) continue;
    if (entryIndex >= end) break;
    if (average && !(direction * bars[i].c > average[i])) continue;
    if (rule.volume && !(volume[i] >= rule.volume * volumeAverage[i - 1])) continue;
    const opening = bars[entryIndex];
    if (book && opening.t <= book.lastExit) continue;
    if (opening.session && opening.session !== bars[i].session) continue;
    const entry = (direction === 1 ? opening.ask ?? opening.o : opening.o) * (1 + direction * edge);
    const distance = atr[i] * rule.stop;
    const marketOpen = direction === 1 ? opening.o : opening.ask ?? opening.o;
    if (!(distance > 0 && distance < entry * .2) || direction * (marketOpen - entry) <= -distance) continue;
    const stop = entry - direction * distance, target = entry + direction * rule.reward * distance;
    let exitPrice = 0, exitIndex = entryIndex, funding = 0, closed = false;
    for (let j = entryIndex; j < Math.min(end, entryIndex + rule.maxBars); j++) {
      const bar = bars[j];
      exitIndex = j;
      funding += ((direction === 1 ? bar.funding : bar.shortFunding) ?? 0) * bar.o / entry;
      if (stockShort && !opening.session && j > entryIndex) {
        // Charge calendar days, including weekends, at conservative annualized borrow assumptions.
        funding += (bar.t - bars[j - 1].t) / DAY * (edge >= .003 ? .30 : .15) / 365;
      }
      const stopped = direction === 1 ? bar.l <= stop : (bar.askHigh ?? bar.h) >= stop;
      if (stopped) { exitPrice = direction === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.ask ?? bar.o); closed = true; break; }
      if (direction === 1 ? bar.h >= target : (bar.askLow ?? bar.l) <= target) { exitPrice = target; closed = true; break; }
      exitPrice = direction === 1 ? bar.c : bar.askClose ?? bar.c;
      closed = j + 1 === entryIndex + rule.maxBars || !!(bar.session && bars[j + 1] && bars[j + 1].session !== bar.session);
      if (closed) break;
    }
    const ret = direction * (exitPrice * (1 - direction * edge) / entry - 1) - funding;
    if (book) {
      if (!closed) {
        book.cursor = bars[i].t - 1;
        book.pending = { signal: bars[i].t, entry: opening.t, price: entry, stop, target };
        break;
      }
      const fill: ForwardFill = { entry: opening.t, exit: bars[exitIndex].t, price: entry, exitPrice: exitPrice * (1-direction*edge), net: ret };
      book.recent = [...book.recent, fill].slice(-12);
      book.count++;
      book.lastExit = fill.exit;
      book.equity *= 1 + ret;
      book.peak = Math.max(book.peak, book.equity);
      book.drawdown = Math.max(book.drawdown, 1 - book.equity / book.peak);
      if (book.drawdown > .16 || book.count >= 30) {
        book.state = book.drawdown > .16 ? 'stopped' : 'completed';
        book.cursor = fill.exit;
        break;
      }
    }
    const group = Math.floor(bars[exitIndex].t / cluster);
    groups.set(group, (groups.get(group) ?? 0) + ret);
    trades++;
    tradeTimes?.set(opening.t, bars[exitIndex].t);
    exposed += exitIndex - entryIndex + 1;
    netSum += ret;
    equity *= 1 + ret;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    blockUntil = exitIndex + 1;
  }
  const groupCount = Math.floor(bars[end - 1].t / cluster) - Math.floor(bars[from].t / cluster) + 1;
  if (sample) {
    const first = Math.floor(bars[from].t / cluster);
    for (let i = 0; i < groupCount; i++) sample.push(groups.get(first + i) ?? 0);
  }
  const mean = netSum / groupCount;
  const ss = [...groups.values()].reduce((sum, value) => sum + (value - mean) ** 2, 0) + (groupCount - groups.size) * mean ** 2;
  const error = groupCount > 1 ? Math.sqrt(ss / (groupCount - 1) / groupCount) : 0;
  return { trades, groups: groups.size, net: equity - 1, average: trades ? netSum / trades : 0, drawdown, score: error > 0 ? mean / error : null, exposure: exposed / (end - from) };
}

function* grid(hasVolume: boolean, side: SearchSide) {
  for (const family of Object.keys(FAMILIES) as Family[]) {
    if (family === 'vwap' && !hasVolume) continue;
    for (const setting of signalSettings) {
      for (const trend of trendSettings) {
        for (const volume of hasVolume ? [0, 1.35] : [0]) {
          for (const stop of [1.25, 1.75, 2.5]) {
            for (const reward of [1.2, 1.8, 2.5]) {
              for (const maxBars of [6, 18]) yield { family, setting, trend, volume, stop, reward, maxBars, side };
            }
          }
        }
      }
    }
  }
}

const isIntradayStock = (pair: SearchPair) => pair.market === 'stocks' && pair.frame !== '1d';
const clusterDays = (pair: SearchPair) => isIntradayStock(pair) ? 3 * DAY : 7 * DAY;
const edge = (pair: SearchPair, side?: SearchSide) => pair.market === 'crypto' ? .0008 : side === 'short' ? .0019 : .0004;

function withOutcomes(report: SearchReport, outcomes: SearchOutcome[]) {
  const first = outcomes.find(item => item.verdict === 'paper-candidate') ?? outcomes[0];
  return first ? { ...report, ...first, alternatives: outcomes.filter(item => item !== first) } : report;
}

// Lower 1% percentile of the stressed mean. Adjacent three-group blocks retain clustered losses.
export function blockLowerBound(groups: number[]) {
  if (!groups.length) return 0;
  let state = 191285;
  const means = Array.from({ length: 1000 }, () => {
    let sum = 0;
    for (let i = 0; i < groups.length; i += 3) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const start = Math.floor(state / 2 ** 32 * groups.length);
      for (let j = 0; j < Math.min(3, groups.length - i); j++) sum += groups[(start + j) % groups.length];
    }
    return sum / groups.length;
  });
  return means.sort((a,b) => a-b)[9];
}

export function searchHistory(pair: SearchPair, bars: SearchBar[], source: string,
  memory?: { previous: Experiment[]; record: Experiment[] }): SearchReport {
  const report: SearchReport = { revision: searchRevision(pair.market), pair, source, bars: bars.length, from: '', through: '', tried: 0, validationPassed: 0,
    testedOnLaterData: 0, holdoutFrom: '', verdict: 'insufficient-history', rule: null, holdout: null, stress: null, venue: null, benchmark: null };
  if (!bars.length) return report;
  report.from = date(bars[0].t);
  report.through = date(bars.at(-1)!.t);
  const span = bars.at(-1)!.t - bars[0].t;
  const minimumSpan = isIntradayStock(pair) ? 95 * DAY : 2.8 * 365 * DAY;
  const coverage = pair.market === 'crypto' ? bars.length / (1 + span / BAR_MS[pair.frame]) : 1;
  if (bars.length < 650 || span < minimumSpan || coverage < .995) return report;
  // Freeze at most one catalog and one evolved finalist per direction before using later data.
  const cut = Math.floor(bars.length * .44), final = Math.floor(bars.length * .70);
  report.holdoutFrom = date(bars[final].t);
  const cluster = clusterDays(pair);
  const stock = pair.market === 'stocks';
  const paired = !stock || bars.every(bar => !!bar.ask && !!bar.askHigh && !!bar.askLow && !!bar.askClose);
  const sides: SearchSide[] = paired ? ['long', 'short'] : ['long'];
  if (!paired) report.note = 'Complete historical ask ranges were unavailable for the short replay.';
  const finalists: { outcome: SearchOutcome; rank: number }[] = [];
  const pairs = new Set<string>();
  const contexts: Partial<Record<ContextFactor, number>> = {};
  const stats = { tried: 0, validated: 0, uniquePairs: 0, contexts, exactRepeats: 0, similar: 0 };
  report.generation = stats;
  const supported: ContextFactor[] = pair.market === 'stocks' ? ['sector','earnings'] : ['fundingChange','openInterest'];
  const early = bars.slice(WARMUP, cut);
  const covered = (rows: SearchBar[], f: ContextFactor) => rows.filter(b => Number.isFinite(b[f])).length >= .95 * rows.length;
  const factors = supported.filter(f => covered(early, f));
  const validFactors = factors.filter(f => covered(bars.slice(cut, final), f));
  for (const side of sides) {
    const cost = edge(pair, side);
    const stockShort = stock && side === 'short';
    const input = searchInputs(bars, cut, side);
    const winners = new Map<'catalog'|'generated', { winner: Rule; rank: number; familiar: boolean }>();
    const familiarKeys = new Set<string>();
    const epoch = Math.floor(bars.at(-1)!.t / (7 * DAY));
    const discoveryMid = Math.floor((WARMUP + cut) / 2);
    const evolved = evolve(side, epoch, rule => {
      const tradeTimes = new Map<number, number>();
      const scores = [[WARMUP, discoveryMid], [discoveryMid, cut]].map(([start, end]) =>
        replay(input, rule, start, end, cost * 2, cluster, stockShort, undefined, 0, undefined, tradeTimes));
      const fitness = scores.every(s => s.trades >= 4 && s.score !== null)
        ? Math.min(...scores.map(s => s.score! - s.drawdown)) : -Infinity;
      if (rule.recipe.context) contexts[rule.recipe.context] = (contexts[rule.recipe.context] ?? 0) + 1;
      if (memory) {
        const experiment = fingerprint(rule, tradeTimes, fitness);
        const novelty = compareExperiments(experiment, memory.previous);
        if (novelty === 'repeat') stats.exactRepeats++;
        if (novelty === 'similar') stats.similar++;
        if (novelty !== 'new') familiarKeys.add(experiment.key);
        memory.record.push(experiment);
      }
      return { fitness, signature: new Set(tradeTimes.keys()), familiar: familiarKeys.has(ruleKey(rule)) };
    }, factors);
    for (const key of evolved.pairs) pairs.add(key);
    report.generation.tried += evolved.tried;
    report.generation.uniquePairs = pairs.size;
    report.tried += evolved.tried;
    function* candidates(): Generator<Rule> { yield* grid(input.hasVolume, side); yield* evolved.finalists; }
    for (const rule of candidates()) {
      if (rule.recipe?.context && !validFactors.includes(rule.recipe.context)) continue;
      if (rule.family !== 'sequence') report.tried++;
      const train = replay(input, rule, WARMUP, cut, cost, cluster, stockShort);
      const validation = replay(input, rule, cut + (rule.family === 'sequence' ? rule.maxBars : 0), final, cost * 2, cluster, stockShort);
      const valid = [train, validation].every(period => period.trades >= 20 && period.groups >= 7 && period.net > 0 &&
        period.drawdown <= .20 && (period.score ?? 0) >= 1.25);
      if (!valid) continue;
      report.validationPassed++;
      if (rule.family === 'sequence') report.generation.validated++;
      const rank = Math.min(train.score!, validation.score!);
      const group = rule.family === 'sequence' ? 'generated' : 'catalog';
      const familiar = group === 'generated' && familiarKeys.has(ruleKey(rule));
      const best = winners.get(group);
      if (!best || (best.familiar && !familiar) || (best.familiar === familiar && rank > best.rank))
        winners.set(group, { winner: rule, rank, familiar });
    }
    for (const { winner, rank } of winners.values()) {
      const start = final + (winner.recipe ? winner.maxBars : 0);
      const holdout = replay(input, winner, start, bars.length, cost, cluster, stockShort);
      const groups: number[] = [];
      const stress = replay(input, winner, start, bars.length, cost * 2, cluster, stockShort, undefined, 0, winner.recipe ? groups : undefined);
      const robustness = winner.recipe ? { delayed: replay(input, winner, start, bars.length, cost * 2, cluster, stockShort, undefined, 1),
        lowerGroupReturn: blockLowerBound(groups) } : undefined;
      const benchmark = (side === 'short' ? -1 : 1) * (Math.exp(Math.log(bars.at(-1)!.c / bars[start].o) * stress.exposure) - 1);
      const passed = (!winner.recipe?.context || covered(bars.slice(start), winner.recipe.context)) &&
        holdout.net > 0 && stress.net > Math.max(0, benchmark) && stress.trades >= 25 && stress.groups >= 9 &&
        stress.drawdown <= .16 && (stress.score ?? 0) >= 3.3 &&
        (!robustness || (robustness.lowerGroupReturn > 0 && robustness.delayed.net > 0 && robustness.delayed.drawdown <= .16));
      finalists.push({ rank, outcome: { verdict: passed ? 'paper-candidate' : 'holdout-failed', rule: winner,
        holdout, stress, venue: null, benchmark, note: report.note, robustness } });
    }
  }
  const outcomes = finalists.sort((a, b) => b.rank - a.rank).map(item => item.outcome);
  return withOutcomes({ ...report, verdict: 'no-candidate', testedOnLaterData: finalists.length }, outcomes);
}

export function checkPerpVenue(report: SearchReport, bars: SearchBar[]): SearchReport {
  if (report.verdict !== 'paper-candidate' || !report.rule || report.pair.market !== 'crypto') return report;
  const hasHistory = bars.length >= 650 && (bars.at(-1)!.t - bars[0].t) / BAR_MS[report.pair.frame] + 1 <= bars.length / .995;
  return withOutcomes(report, searchOutcomes(report).map(outcome => {
    if (outcome.verdict !== 'paper-candidate' || !outcome.rule) return outcome;
    if (!hasHistory) return { ...outcome, verdict: 'venue-failed', note: 'Incomplete Hyperliquid price or funding history' };
    const rule = outcome.rule;
    const factor = rule.recipe?.context;
    if (factor && bars.filter(b => Number.isFinite(b[factor])).length < .95 * bars.length)
      return { ...outcome, verdict: 'venue-failed', note: 'Incomplete historical signal data on the venue test' };
    const venue = replay(searchInputs(bars, bars.length, rule.side), rule, WARMUP, bars.length, edge(report.pair, rule.side) * 2, clusterDays(report.pair));
    const passed = venue.trades >= 12 && venue.groups >= 3 && venue.net > 0 && venue.drawdown <= .16;
    return { ...outcome, verdict: passed ? 'paper-candidate' : 'venue-failed', venue };
  }));
}

export function replayFixed(input: Inputs, rule: Rule, from: number, end: number, perSideCost: number) {
  return replay(input, rule, from, end, perSideCost, 7 * DAY);
}

/** Checkpoint a frozen rule on bars after enrollment. Repeated worker attempts yield the same fills. */
export function advanceForward(report: SearchReport, previous: ForwardBook[], bars: SearchBar[], enrolledAt: number) {
  const pair = report.pair;
  const step = BAR_MS[pair.frame];
  const inputs = new Map<SearchSide, Inputs>();
  const books = previous.map((saved): ForwardBook => {
    if (saved.version !== RULE_INTERPRETER_VERSION) return { ...saved, state: 'archived' };
    if (saved.state === 'completed' || saved.state === 'stopped' || saved.state === 'archived') return saved;
    const book = { ...saved, recent: [...saved.recent] };
    if (!bars.length) return { ...book, state: 'data-gap' };
    const next = bars.findIndex(b => b.t > book.cursor);
    if (next < 0 || next >= bars.length - 1) return book;
    const missing = bars.slice(Math.max(1, next)).some((bar, offset) => {
      const prior = bars[Math.max(1, next) + offset - 1];
      if (pair.market === 'crypto' || (bar.session && prior.session === bar.session)) return bar.t - prior.t !== step;
      return bar.t - prior.t > 7 * DAY;
    });
    const factor = book.rule.recipe?.context;
    if (next < WARMUP || missing || (factor && bars.slice(next, -1).some(b => !Number.isFinite(b[factor]))) || pair.market === 'stocks' && book.rule.side === 'short' &&
      bars.slice(next).some(bar => !bar.askHigh || !bar.askLow || !bar.askClose || !bar.ask)) return { ...book, state: 'data-gap' };
    const side = book.rule.side ?? 'long';
    const input = inputs.get(side) ?? searchInputs(bars, next, side);
    inputs.set(side, input);
    book.state = 'tracking';
    book.cursor = bars[bars.length - 2].t;
    delete book.pending;
    replay(input, book.rule, next, bars.length, 2 * edge(pair, side), clusterDays(pair), pair.market === 'stocks' && side === 'short', book);
    return book;
  });
  for (const outcome of searchOutcomes(report)) {
    const rule = outcome.rule;
    if (!rule || outcome.verdict !== 'paper-candidate' || !outcome.stress || !(outcome.stress.net > 0) ||
        (pair.market === 'crypto' && !(outcome.venue && outcome.venue.net > 0)) ||
        books.some(b => b.version === RULE_INTERPRETER_VERSION && ruleKey(b.rule) === ruleKey(rule))) continue;
    books.push({ version: RULE_INTERPRETER_VERSION, rule, started: enrolledAt, cursor: enrolledAt, lastExit: 0, count: 0,
      equity: 1, peak: 1, drawdown: 0, recent: [], state: 'tracking' });
  }
  return books;
}
