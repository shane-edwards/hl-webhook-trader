import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_MARKETS, END, FRAME, cryptoFlow, type FlowBar } from './crypto-flow-data';
import { bybitData } from './crypto-bybit-data';
import { openInterest } from './crypto-positioning-data';
import { DAY, HOUR, perpFunding, type Funding } from './price-action-data';
import { replay, summarize, type Side, type Trigger, type Window } from './crypto-research-replay';

const periods = [[Date.UTC(2024, 1, 1), Date.UTC(2025, 0, 1)], [Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)],
  [Date.UTC(2026, 0, 1), END]] as const;
const costs = [{ fill: .00085, stop: .0003 }, { fill: .0015, stop: .0007 }] as const;
const interestLag = FRAME;
const sides = [1, -1] as const;
type Row = { t: number; spot: FlowBar; perp: Pick<FlowBar, 'o' | 'h' | 'l' | 'c'> };
type Session = { day: string; bars: { t: number; bidOpen: number; bidClose: number }[] };
type Event = { t: number; equityMove: number };
type PositionRule = { family: 'compression-reversal' | 'build-up-trend' | 'compression-trend'; side: Side;
  lookback: number; positionMove: number; hold: number; filter: 'price' | 'confirm'; swing: boolean };
type SessionRule = { family: 'cash-open' | 'equity-confirm' | 'equity-divergence' | 'fed' | 'etf-fixing';
  action: 'follow' | 'fade'; threshold: number; hold: number };
type FlowRule = { family: 'follow-flow' | 'fade-flow'; sessions: number; threshold: number;
  filter: 'all' | 'price-conflict'; hold: number };
type EtfFlow = { date: string; netFlowUsd: number };

function prepare(rows: Row[], rates: Funding[], interest: Map<number, number>) {
  const rowIndex = new Map(rows.map((bar, i) => [bar.t, i]));
  // At an entry's opening timestamp, allow a full bar for the snapshot to become observable.
  const positioned = rows.map(bar => interest.get(bar.t - interestLag) ?? NaN);
  const previousFunding: number[] = [];
  let rateIndex = 0;
  let typicalSum = 0;
  const trueRanges = rows.map((bar, i) => {
    while (rates[rateIndex + 1]?.time < bar.t) rateIndex++;
    previousFunding.push(rates[rateIndex].time < bar.t ? rates[rateIndex].rate * 8 / rates[rateIndex].hours : 0);
    const previous = rows[i - 1]?.perp.c ?? bar.perp.o;
    return Math.max(bar.perp.h - bar.perp.l, Math.abs(bar.perp.h - previous), Math.abs(bar.perp.l - previous)) / previous;
  });
  const priorRange = trueRanges.map((range, index) => {
    const value = typicalSum / Math.max(1, Math.min(index, 96));
    typicalSum += range - (index >= 96 ? trueRanges[index - 96] : 0);
    return value;
  });
  const spotFlow = [0];
  const spotVolume = [0];
  for (const row of rows) {
    spotFlow.push(spotFlow.at(-1)! + 2 * row.spot.aggressive - row.spot.volume);
    spotVolume.push(spotVolume.at(-1)! + row.spot.volume);
  }
  return { rows, rowIndex, positioned, previousFunding, priorRange, spotFlow, spotVolume,
    funding: new Map(rates.map(rate => [rate.time, rate.rate])) };
}
type Market = ReturnType<typeof prepare>;

function positionSignals(input: Market, rule: PositionRule, useInterest = true): Trigger[] {
  const { rows, rowIndex, positioned, previousFunding, priorRange, spotFlow, spotVolume } = input;
  const triggers: Trigger[] = [];
  const direction = rule.family === 'compression-reversal' ? -rule.side : rule.side;
  for (let i = 192; i < rows.length - 1; i++) {
    const time = rows[i].t;
    if (time - rows[i - 1].t !== FRAME || (rule.swing && time % (4 * HOUR) !== 0)) continue;
    const before = rowIndex.get(time - rule.lookback * FRAME);
    if (before === undefined) continue;
    const move = direction * Math.log(rows[i - 1].perp.c / rows[before].perp.o);
    const moveFloor = rule.swing ? .035 : .009;
    if (move < Math.max(moveFloor, (rule.swing ? 1.8 : 1.25) * priorRange[before] * Math.sqrt(rule.lookback))) continue;
    const change = Math.log(positioned[i] / positioned[before]);
    const interestDirection = rule.family === 'build-up-trend' ? 1 : -1;
    if (useInterest && (!Number.isFinite(change) || interestDirection * change < rule.positionMove)) continue;
    if (!useInterest && !Number.isFinite(change)) continue;
    if (rule.filter === 'confirm') {
      if (rule.family === 'compression-reversal') {
        if (rule.side * (rows[i - 1].spot.c / rows[i - 1].spot.o - 1) <= 0 ||
          rule.side * previousFunding[before] > 0) continue;
      } else {
        const pressure = (spotFlow[i] - spotFlow[before]) / (spotVolume[i] - spotVolume[before]);
        if (rule.side * pressure < .02 || rule.side * previousFunding[before] > .0003) continue;
      }
    }
    triggers.push({ index: i, side: rule.side });
  }
  return triggers;
}

function sessionSignals(input: Market, rule: SessionRule, events: Event[]): Trigger[] {
  const { rows, rowIndex, priorRange } = input;
  const triggers: Trigger[] = [];
  const bars = rule.family === 'fed' ? 1 : 2;
  for (const { t, equityMove } of events) {
    const start = rowIndex.get(t), index = rowIndex.get(t + bars * FRAME);
    if (start === undefined || index === undefined || index - start !== bars || start < 96) continue;
    const move = Math.log(rows[index - 1].spot.c / rows[start].spot.o);
    if (Math.abs(move) < rule.threshold * priorRange[start] * Math.sqrt(bars)) continue;
    if (rule.family === 'equity-confirm' && (move * equityMove <= 0 || Math.abs(equityMove) < .0015)) continue;
    if (rule.family === 'equity-divergence' && (move * equityMove >= 0 || Math.abs(equityMove) < .0015)) continue;
    const side = (move > 0) === (rule.action === 'follow') ? 1 : -1;
    triggers.push({ index, side });
  }
  return triggers;
}

function research<Rule extends { hold: number; family: string }>(
  input: Market[], rules: Rule[], trigger: (market: Market, rule: Rule) => Trigger[], swing: boolean,
  controlTrigger?: (market: Market, rule: Rule) => Trigger[],
) {
  type Stats = ReturnType<typeof summarize>;
  const replayWindow = (rule: Rule, triggers: Trigger[][], i: number, expense: typeof costs[number]) =>
    summarize(input.map((market, j) => replay(market, triggers[j], rule.hold, periods[i], expense, swing)), periods[i]);
  const consider = (rule: Rule, stats: Stats) => {
    const minimum = rule.family === 'fed' ? 5 : swing ? 16 : 25;
    return stats.net > 0 && stats.days >= minimum && stats.weeks >= minimum * .6 && stats.drawdown <= .25 &&
      stats.markets.filter(market => market.net > 0).length >= Math.min(2, input.length);
  };
  const groups = new Map<string, { rule: Rule; rank: number; discovery: Stats; validation: Stats; qualified: boolean }>();
  let earlyPasses = 0;
  for (const rule of rules) {
    const triggers = input.map(market => trigger(market, rule));
    const discovery = replayWindow(rule, triggers, 0, costs[0]);
    const validation = replayWindow(rule, triggers, 1, costs[1]);
    const rank = Math.min(discovery.score, validation.score);
    const qualified = rank >= 1 && consider(rule, discovery) && consider(rule, validation);
    if (qualified) earlyPasses++;
    const key = rule.family + ('side' in rule ? `:${rule.side}` : '');
    const current = groups.get(key);
    if (!current || (qualified && !current.qualified) || (qualified === current.qualified && rank > current.rank)) {
      groups.set(key, { rule, rank, discovery, validation, qualified });
    }
  }
  const entries = [...groups.values()].sort((a, b) => b.rank - a.rank);
  const final = entries.filter(entry => entry.qualified || (entry.discovery.net > 0 && entry.validation.net > 0)).map(entry => {
    const triggers = input.map(market => trigger(market, entry.rule));
    const baseline = replayWindow(entry.rule, triggers, 2, costs[0]);
    const stressed = replayWindow(entry.rule, triggers, 2, costs[1]);
    const control = controlTrigger
      ? replayWindow(entry.rule, input.map(market => controlTrigger(market, entry.rule)), 2, costs[1])
      : undefined;
    // A positive pooled year is insufficient without repeatable periods and an improvement over the price-only control.
    const passed = entry.qualified && entry.rule.family !== 'fed' && consider(entry.rule, stressed) && stressed.score >= 2 &&
      (!control || (stressed.score > control.score && (stressed.averageBps ?? 0) > (control.averageBps ?? 0)));
    return { ...entry, baseline, stressed, control, passed };
  });
  return { rules: rules.length, earlyPasses, earlierLeaders: entries, candidates: final.filter(entry => entry.qualified),
    smallSampleDiagnostics: final.filter(entry => !entry.qualified) };
}

function positionRules(swing: boolean): PositionRule[] {
  const rules: PositionRule[] = [];
  for (const family of ['compression-reversal', 'build-up-trend', 'compression-trend'] as const) for (const side of sides) {
    for (const lookback of swing ? [96, 192] : [8, 16]) for (const positionMove of swing ? [.04, .08] : [.01, .02]) {
      for (const hold of swing ? [192, 480, 672] : [4, 16, 48]) for (const filter of ['price', 'confirm'] as const) {
        rules.push({ family, side, lookback, positionMove, hold, filter, swing });
      }
    }
  }
  return rules;
}

const fedCalendarUrl = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
async function fedCalendar() {
  const response = await fetch(fedCalendarUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Fed calendar unavailable, HTTP ${response.status}`);
  const html = await response.text();
  const dates = [...html.matchAll(/<strong>Statement:<\/strong>[\s\S]{0,240}?\/newsevents\/pressreleases\/monetary(202[4-6])([01]\d)([0-3]\d)a\.htm/g)];
  const days = [...new Set(dates.map(([, y, m, d]) => `${y}-${m}-${d}`))].sort();
  if (days.filter(day => day.startsWith('2024')).length !== 8 || days.filter(day => day.startsWith('2025')).length !== 8) {
    throw new Error('Missing scheduled FOMC statements');
  }
  return new Set(days);
}

function sessionEvents(sessions: Session[], dates: Set<string>, family: SessionRule['family']): Event[] {
  return sessions.flatMap(({ day, bars }) => {
    if (bars.length < 1 || (family === 'fed' && (!dates.has(day) || bars.length < 11))) return [];
    if (family === 'etf-fixing' && bars.length < 13) return [];
    const offset = family === 'fed' ? 9 : family === 'etf-fixing' ? 11 : 0;
    const opening = bars[0];
    return [{ t: opening.t + offset * 30 * 60_000, equityMove: Math.log(opening.bidClose / opening.bidOpen) }];
  });
}

const flowUrl = 'https://www.tftc.io/bitcoin-etf-flows/data.json';
async function etfFlows() {
  const path = join('backtest', 'data', 'intraday', 'crypto-flow', 'btc-etf-flows.json');
  let source: string;
  if (existsSync(path)) source = readFileSync(path, 'utf8');
  else {
    const response = await fetch(flowUrl, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Bitcoin ETF flow archive unavailable, HTTP ${response.status}`);
    source = await response.text();
  }
  const flows = (JSON.parse(source).days as EtfFlow[]).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    Number.isFinite(row.netFlowUsd) && Date.parse(row.date) < END);
  if (flows.length < 675 || flows.some((row, i) => i > 0 && row.date <= flows[i - 1].date)) {
    throw new Error('Incomplete Bitcoin ETF flow history');
  }
  if (!existsSync(path)) writeFileSync(path, source);
  return flows;
}

function etfSignals(input: Market, rule: FlowRule, flows: EtfFlow[], sessions: Map<string, number>, hourDelay: number): Trigger[] {
  const { rows, rowIndex } = input;
  const triggers: Trigger[] = [];
  for (let i = 60 + rule.sessions; i < flows.length; i++) {
    const flowSession = flows[i];
    const session = sessions.get(flowSession.date);
    if (session === undefined || Date.parse(flowSession.date) - Date.parse(flows[i - rule.sessions + 1].date) > (2 * rule.sessions + 2) * DAY) continue;
    const index = rowIndex.get(Date.parse(flowSession.date) + hourDelay * HOUR);
    if (index === undefined) continue;
    const aggregate = flows.slice(i - rule.sessions + 1, i + 1).reduce((sum, row) => sum + row.netFlowUsd, 0);
    const absolute = flows.slice(i - rule.sessions - 59, i - rule.sessions + 1)
      .reduce((sum, row) => sum + Math.abs(row.netFlowUsd), 0) / 60;
    if (Math.abs(aggregate) < rule.threshold * absolute * Math.sqrt(rule.sessions) || aggregate === 0) continue;
    const close = session + 6.5 * HOUR;
    const closeIndex = rowIndex.get(close - FRAME), prior = rowIndex.get(close - DAY);
    if (closeIndex === undefined || prior === undefined) continue;
    const move = Math.log(rows[closeIndex].spot.c / rows[prior].spot.o);
    if (rule.filter === 'price-conflict' && move * aggregate >= 0) continue;
    const side = (aggregate > 0) === (rule.family === 'follow-flow') ? 1 : -1;
    triggers.push({ index, side });
  }
  return triggers;
}

async function etfResearch(input: Market, sessions: Session[]) {
  const flows = await etfFlows();
  const times = new Map(sessions.filter(session => session.bars.length === 13).map(session => [session.day, session.bars[0].t]));
  const rules: FlowRule[] = [];
  for (const family of ['follow-flow', 'fade-flow'] as const) for (const sessions of [1, 3, 5]) {
    for (const threshold of [1, 2]) for (const filter of ['all', 'price-conflict'] as const) {
      for (const hold of [16, 96, 288]) rules.push({ family, sessions, threshold, filter, hold });
    }
  }
  // First entry is next calendar day 12:00 UTC. Replay again with an additional day of publication delay.
  const study = research([input], rules, (market, rule) => etfSignals(market, rule, flows, times, 36), true);
  const delayed = (rule: FlowRule, window: Window) =>
    summarize([replay(input, etfSignals(input, rule, flows, times, 60), rule.hold, window, costs[1], true)], window);
  const timingCheck = study.earlierLeaders.map(({ rule, discovery, validation }) => ({ rule,
    normalDiscovery: discovery, normalValidation: validation, nextDayDelayed: periods.map(window => delayed(rule, window)) }));
  // Revised historical flows have no first-publication archive and are eligible for diagnostics only.
  return { source: flowUrl, rows: flows.length, normalEntryHour: 36, delayedEntryHour: 60,
    ...study, candidates: study.candidates.map(entry => ({ ...entry, passed: false })), timingCheck };
}

async function replicateSwing(binance: Market[]) {
  // Freeze the Binance leader before loading Bybit. Do not rescan parameters on the replication venue.
  const rule: PositionRule = { family: 'build-up-trend', side: 1, lookback: 96, positionMove: .04,
    hold: 192, filter: 'confirm', swing: true };
  const bybit = await Promise.all(FLOW_MARKETS.map(bybitData));
  const native = binance.map((market, i) => {
    const { candles, interest, funding } = bybit[i];
    const rows = market.rows.flatMap(row => {
      const candle = candles.get(row.t);
      return candle ? [{ ...row, perp: candle }] : [];
    });
    return prepare(rows, funding, interest);
  });
  const evaluate = (execution: Market[], triggerMarket: Market[], useInterest = true) => {
    const triggers = execution.map((fills, i) => positionSignals(triggerMarket[i], rule, useInterest).flatMap(({ index, side }) => {
      const target = fills.rowIndex.get(triggerMarket[i].rows[index].t);
      return target === undefined ? [] : [{ index: target, side }];
    }));
    return periods.map(window => summarize(execution.map((fills, i) =>
      replay(fills, triggers[i], rule.hold, window, costs[1], true)), window));
  };
  return { rule, matchedCandles: native.map(market => market.rows.length),
    binance: evaluate(binance, binance), bybitExecutionBinanceSignal: evaluate(native, binance),
    bybitNative: evaluate(native, native), bybitPriceOnly: evaluate(native, native, false) };
}

async function main() {
  const sessions: Session[] = JSON.parse(readFileSync(join('backtest', 'data', 'intraday', 'etf-strategies', 'SPY.json'), 'utf8')).sessions;
  const fed = await fedCalendar();
  const sessionRules: SessionRule[] = [];
  const events = new Map<SessionRule['family'], Event[]>();
  for (const family of ['cash-open', 'equity-confirm', 'equity-divergence', 'fed', 'etf-fixing'] as const) {
    events.set(family, sessionEvents(sessions, fed, family));
    for (const action of ['follow', 'fade'] as const) for (const threshold of [.75, 1.5]) {
      for (const hold of [4, 16, 32]) sessionRules.push({ family, action, threshold, hold });
    }
  }
  const runSession = (input: Market[]) => research(input, sessionRules,
    (market, rule) => sessionSignals(market, rule, events.get(rule.family)!), false);
  const priceData = await Promise.all(FLOW_MARKETS.map(async coin => ({ rows: await cryptoFlow(coin), rates: await perpFunding(coin) })));
  const session = runSession(priceData.map(({ rows, rates }) => prepare(rows, rates, new Map())));
  const output = (name: string) => join('backtest', `crypto-${name}-results.json`);
  const metadata = { costs, delayMinutes: interestLag / 60_000, periods: periods.map(period => period.map(t => new Date(t).toISOString().slice(0, 10))) };
  const sample = sessions.filter(({ day }) => Date.parse(day) >= periods[0][0] && Date.parse(day) < END);
  const eventsPerPeriod = periods.map(([from, to]) => sample.filter(({ day }) => Date.parse(day) >= from && Date.parse(day) < to && fed.has(day)).length);
  writeFileSync(output('sessions'), JSON.stringify({ ...metadata, sessions: sample.length, fedEvents: eventsPerPeriod, ...session }, null, 2) + '\n');
  console.log('Sessions', session.rules, session.earlyPasses, session.candidates.map(candidate => ({ rule: candidate.rule, net: candidate.stressed.net })));
  if (process.argv.includes('--sessions-only')) return;
  const bitcoin = priceData[0];
  const etf = await etfResearch(prepare(bitcoin.rows, bitcoin.rates, new Map()), sessions);
  writeFileSync(output('etf-flow'), JSON.stringify({ ...metadata, ...etf }, null, 2) + '\n');
  console.log('ETF flows', etf.rows, etf.rules, etf.earlyPasses, etf.candidates.map(candidate => ({ rule: candidate.rule, net: candidate.stressed.net })));
  const positioning = await Promise.all(FLOW_MARKETS.map(openInterest));
  const input = priceData.map(({ rows, rates }, i) => prepare(rows, rates, positioning[i].snapshots));
  const coverage = FLOW_MARKETS.map((coin, i) => ({ coin, snapshots: positioning[i].snapshots.size,
    missingDays: positioning[i].missingDays, period: periods.map(([from, to]) => {
      const bars = input[i].rows.filter(bar => bar.t >= from && bar.t < to);
      return bars.filter(bar => positioning[i].snapshots.has(bar.t - interestLag)).length / bars.length;
    }) }));
  if (coverage.some(market => market.period.some(fraction => fraction < .9))) throw new Error('Open interest coverage below 90%');
  const priceOnly = (market: Market, rule: PositionRule) => positionSignals(market, rule, false);
  const intraday = research(input, positionRules(false), positionSignals, false, priceOnly);
  const swing = research(input, positionRules(true), positionSignals, true, priceOnly);
  writeFileSync(output('positioning'), JSON.stringify({ ...metadata, coverage, intraday, swing }, null, 2) + '\n');
  for (const study of [intraday, swing]) console.log('Positioning', study.rules, study.earlyPasses,
    study.candidates.map(candidate => ({ rule: candidate.rule, net: candidate.stressed.net, passed: candidate.passed })));
  if (process.argv.includes('--replicate')) {
    const replication = await replicateSwing(input);
    writeFileSync(output('swing-replication'), JSON.stringify({ ...metadata, ...replication }, null, 2) + '\n');
    console.log('Bybit-native swing replication', replication.bybitNative.map(result => ({ net: result.net, days: result.days })));
  }
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
