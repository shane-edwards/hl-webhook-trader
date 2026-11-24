import { BAR_MS, FAMILIES, SEARCH_REVISION, type Family, type Performance, type Rule, type SearchBar, type SearchPair, type SearchReport } from './model';

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

function supertrendEntries(bars: SearchBar[], ranges: number[], period: number) {
  let upper = Infinity, lower = 0, rising = false;
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

export function searchInputs(bars: SearchBar[], volumeThrough = bars.length) {
  const closes = bars.map(bar => bar.c);
  const volume = bars.map(bar => Number.isFinite(bar.v) && bar.v > 0 ? bar.v : 0);
  const hasVolume = volume.slice(0, volumeThrough).filter(value => value > 0).length >= .95 * volumeThrough;
  const volumeAverage = rolling(volume, 30);
  const trend = new Map(trendSettings.filter(Boolean).map(period => [period, ema(closes, period)]));
  const ranges = bars.map((bar, i) => i === 0 ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - closes[i - 1]), Math.abs(bar.l - closes[i - 1])));
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
    const weighted = rolling(bars.map((bar, i) => (bar.h + bar.l + bar.c) / 3 * volume[i]), period);
    const averageVolume = rolling(volume, period);
    const volumeCoverage = rolling(volume.map(v => Number(v > 0)), period);
    const vwap = weighted.map((n, i) => n / averageVolume[i]);
    const fast = ema(closes, Math.max(4, Math.round(period / 2)));
    const slow = ema(closes, period);
    const macd = fast.map((n, i) => n - slow[i]);
    const macdAverage = ema(macd, Math.max(3, Math.round(period / 3)));
    const family: Record<Family, number[]> = { range: [], rsi: [], vwap: [], band: [], macd: [], squeeze: [], supertrend: supertrendEntries(bars, ranges, period) };
    for (let i = WARMUP; i < bars.length - 1; i++) {
      const close = closes[i], previous = closes[i - 1];
      if (close > bars[i - 1].h) {
        let top = bars[i - 1].h;
        for (let j = i - period; j < i - 1; j++) top = Math.max(top, bars[j].h);
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
  return { bars, trend, atr, signals, hasVolume, volume, volumeAverage };
}

type Inputs = ReturnType<typeof searchInputs>;
type Replay = Performance & { exposure: number };

function replay(input: Inputs, rule: Rule, from: number, end: number, edge: number, cluster: number): Replay {
  const { bars, atr, trend, volume, volumeAverage, signals } = input;
  const average = trend.get(rule.trend);
  const groups = new Map<number, number>();
  let equity = 1, peak = 1, drawdown = 0, trades = 0, blockUntil = from, netSum = 0, exposed = 0;
  for (const i of signals.get(`${rule.family}:${rule.setting}`) ?? []) {
    const entryIndex = i + 1;
    if (entryIndex < blockUntil || i < from) continue;
    if (entryIndex >= end) break;
    if (average && !(bars[i].c > average[i])) continue;
    if (rule.volume && !(volume[i] >= rule.volume * volumeAverage[i - 1])) continue;
    const opening = bars[entryIndex];
    if (opening.session && opening.session !== bars[i].session) continue;
    const entry = (opening.ask ?? opening.o) * (1 + edge);
    const distance = atr[i] * rule.stop;
    if (!(distance > 0 && distance < entry * .2) || opening.o <= entry - distance) continue;
    const stop = entry - distance, target = entry + rule.reward * distance;
    let exitPrice = 0, exitIndex = entryIndex, funding = 0;
    for (let j = entryIndex; j < Math.min(end, entryIndex + rule.maxBars); j++) {
      const bar = bars[j];
      exitIndex = j;
      funding += (bar.funding ?? 0) * bar.o / entry;
      if (bar.l <= stop) { exitPrice = Math.min(stop, bar.o); break; }
      if (bar.h >= target) { exitPrice = target; break; }
      exitPrice = bar.c;
      if (bar.session && bars[j + 1]?.session !== bar.session) break;
    }
    const ret = exitPrice * (1 - edge) / entry - 1 - funding;
    const group = Math.floor(bars[exitIndex].t / cluster);
    groups.set(group, (groups.get(group) ?? 0) + ret);
    trades++;
    exposed += exitIndex - entryIndex + 1;
    netSum += ret;
    equity *= 1 + ret;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    blockUntil = exitIndex + 1;
  }
  const groupCount = Math.floor(bars[end - 1].t / cluster) - Math.floor(bars[from].t / cluster) + 1;
  const mean = netSum / groupCount;
  const ss = [...groups.values()].reduce((sum, value) => sum + (value - mean) ** 2, 0) + (groupCount - groups.size) * mean ** 2;
  const error = groupCount > 1 ? Math.sqrt(ss / (groupCount - 1) / groupCount) : 0;
  return { trades, groups: groups.size, net: equity - 1, average: trades ? netSum / trades : 0, drawdown, score: error > 0 ? mean / error : null, exposure: exposed / (end - from) };
}

function* grid(hasVolume: boolean) {
  for (const family of Object.keys(FAMILIES) as Family[]) {
    if (family === 'vwap' && !hasVolume) continue;
    for (const setting of signalSettings) {
      for (const trend of trendSettings) {
        for (const volume of hasVolume ? [0, 1.35] : [0]) {
          for (const stop of [1.25, 1.75, 2.5]) {
            for (const reward of [1.2, 1.8, 2.5]) {
              for (const maxBars of [6, 18]) yield { family, setting, trend, volume, stop, reward, maxBars };
            }
          }
        }
      }
    }
  }
}

const isIntradayStock = (pair: SearchPair) => pair.market === 'stocks' && pair.frame !== '1d';
const clusterDays = (pair: SearchPair) => isIntradayStock(pair) ? 3 * DAY : 7 * DAY;
const edge = (pair: SearchPair) => pair.market === 'crypto' ? .0008 : .0004;

export function searchHistory(pair: SearchPair, bars: SearchBar[], source: string): SearchReport {
  const report: SearchReport = { revision: SEARCH_REVISION, pair, source, bars: bars.length, from: '', through: '', tried: 0, validationPassed: 0,
    testedOnLaterData: 0, holdoutFrom: '', verdict: 'insufficient-history', rule: null, holdout: null, stress: null, venue: null, benchmark: null };
  if (!bars.length) return report;
  report.from = date(bars[0].t);
  report.through = date(bars.at(-1)!.t);
  const span = bars.at(-1)!.t - bars[0].t;
  const minimumSpan = isIntradayStock(pair) ? 95 * DAY : 2.8 * 365 * DAY;
  const coverage = pair.market === 'crypto' ? bars.length / (1 + span / BAR_MS[pair.frame]) : 1;
  if (bars.length < 650 || span < minimumSpan || coverage < .995) return report;
  // The final window never contributes to ranking. When the one frozen winner fails there, the search stops.
  const cut = Math.floor(bars.length * .44), final = Math.floor(bars.length * .70);
  const input = searchInputs(bars, cut);
  report.holdoutFrom = date(bars[final].t);
  const cluster = clusterDays(pair);
  const cost = edge(pair);
  let best = -Infinity;
  let winner: Rule | null = null;
  for (const rule of grid(input.hasVolume)) {
    report.tried++;
    const train = replay(input, rule, WARMUP, cut, cost, cluster);
    const validation = replay(input, rule, cut, final, cost * 2, cluster);
    const valid = [train, validation].every(period => period.trades >= 20 && period.groups >= 7 && period.net > 0 &&
      period.drawdown <= .20 && (period.score ?? 0) >= 1.25);
    if (!valid) continue;
    report.validationPassed++;
    const rank = Math.min(train.score!, validation.score!);
    if (rank > best) { best = rank; winner = rule; }
  }
  if (!winner) return { ...report, verdict: 'no-candidate' };
  const holdout = replay(input, winner, final, bars.length, cost, cluster);
  const stress = replay(input, winner, final, bars.length, cost * 2, cluster);
  const benchmark = Math.exp(Math.log(bars.at(-1)!.c / bars[final].o) * stress.exposure) - 1;
  const passed = holdout.net > 0 && stress.net > Math.max(0, benchmark) && stress.trades >= 25 && stress.groups >= 9 &&
    stress.drawdown <= .16 && (stress.score ?? 0) >= 3.3;
  return { ...report, verdict: passed ? 'paper-candidate' : 'holdout-failed', rule: winner, holdout, stress, testedOnLaterData: 1, benchmark };
}

export function checkPerpVenue(report: SearchReport, bars: SearchBar[]): SearchReport {
  if (report.verdict !== 'paper-candidate' || !report.rule || report.pair.market !== 'crypto') return report;
  if (bars.length < 650 || (bars.at(-1)!.t - bars[0].t) / BAR_MS[report.pair.frame] + 1 > bars.length / .995) {
    return { ...report, verdict: 'venue-failed', note: 'Incomplete Hyperliquid history' };
  }
  const venue = replay(searchInputs(bars), report.rule, WARMUP, bars.length, edge(report.pair) * 2, clusterDays(report.pair));
  const passed = venue.trades >= 12 && venue.groups >= 3 && venue.net > 0 && venue.drawdown <= .16;
  return { ...report, verdict: passed ? 'paper-candidate' : 'venue-failed', venue };
}
