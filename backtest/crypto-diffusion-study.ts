import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cryptoFlow, END, FLOW_MARKETS, FRAME } from './crypto-flow-data';
import { bybitData } from './crypto-bybit-data';
import { replay, summarize, type Side, type Trigger, type Window } from './crypto-research-replay';
import { DAY, HOUR, perpFunding } from './price-action-data';

const DRIVERS = ['XRP', 'DOGE', 'TRX'] as const;
const WINDOWS: Window[] = [[Date.UTC(2024, 1, 1), Date.UTC(2025, 0, 1)], [Date.UTC(2025, 0, 1), Date.UTC(2026, 0, 1)],
  [Date.UTC(2026, 0, 1), END]];
const COSTS = [{ fill: .00085, stop: .0003 }, { fill: .0015, stop: .0007 }];
const LAGS = [2, 8];
type Row = Awaited<ReturnType<typeof cryptoFlow>>[number];
type Setup = { drivers: 'basket' | 'single'; direction: 'follow' | 'fade'; side: 'both' | 'long' | 'short';
  lag: number; threshold: number; hours: number };

function standardMoves(rows: Row[], bars: number) {
  const length = 14 * DAY / FRAME;
  const changes = rows.map((row, i) => i >= bars && row.t - rows[i - bars].t === bars * FRAME
    ? Math.log(row.spot.c / rows[i - bars].spot.c) : 0);
  let sum = 0;
  return new Map(rows.map(({ t }, i) => {
    const value = i >= length && sum > 0 ? changes[i] / Math.sqrt(sum / length) : 0;
    sum += changes[i] ** 2 - (i >= length ? changes[i - length] ** 2 : 0);
    return [t, value];
  }));
}

function prepare(rows: Row[], rates: Awaited<ReturnType<typeof perpFunding>>) {
  let total = 0;
  const ranges = rows.map(({ perp }, i) => {
    const prior = rows[i - 1]?.perp.c ?? perp.o;
    return Math.max(perp.h - perp.l, Math.abs(perp.h - prior), Math.abs(perp.l - prior)) / prior;
  });
  const priorRange = ranges.map((value, i) => {
    const range = total / Math.max(1, Math.min(i, 96));
    total += value - (i >= 96 ? ranges[i - 96] : 0);
    return range;
  });
  return { rows, rowIndex: new Map(rows.map((row, index) => [row.t, index])), priorRange,
    funding: new Map(rates.map(row => [row.time, row.rate])), moves: new Map(LAGS.map(bars => [bars, standardMoves(rows, bars)])) };
}
type Market = ReturnType<typeof prepare>;

function signals(input: Market, peers: Map<number, number>[], rule: Setup) {
  const events: Trigger[] = [];
  const own = input.moves.get(rule.lag)!;
  for (const [index, { t }] of input.rows.entries()) {
    // Wait one full bar after the final signal bar closes.
    const last = t - 2 * FRAME;
    const observed = own.get(last);
    if (observed === undefined || input.rows[index - 1]?.t !== t - FRAME) continue;
    const values = peers.map(peer => peer.get(last) ?? 0);
    const impulse = rule.drivers === 'basket' ? values.reduce((a, b) => a + b, 0) / values.length :
      values.reduce((a, b) => Math.abs(a) >= Math.abs(b) ? a : b);
    const direction: Side = impulse < 0 ? -1 : 1;
    if (Math.abs(impulse) < rule.threshold || direction * observed > Math.abs(impulse) * .6) continue;
    const side: Side = rule.direction === 'follow' ? direction : direction === 1 ? -1 : 1;
    if (rule.side === 'long' && side < 0 || rule.side === 'short' && side > 0) continue;
    events.push({ index, side });
  }
  return events;
}

async function replicate(binance: Market[], drivers: Map<number, Map<number, number>[]>) {
  // Freeze the two earlier-period leaders before loading the replication venues and assets.
  const rules: Setup[] = [
    { drivers: 'basket', direction: 'follow', side: 'long', lag: 2, threshold: 2.5, hours: 24 },
    { drivers: 'basket', direction: 'fade', side: 'both', lag: 2, threshold: 1.5, hours: 72 },
  ];
  const external = ['BNB', 'LINK', 'ADA'];
  const [replication, other] = await Promise.all([
    Promise.all(FLOW_MARKETS.map(bybitData)),
    Promise.all(external.map(async coin => prepare(await cryptoFlow(coin), await perpFunding(coin)))),
  ]);
  const bybit = binance.map((book, i) => prepare(book.rows.flatMap(row => {
    const candle = replication[i].candles.get(row.t);
    return candle ? [{ ...row, perp: { ...row.perp, ...candle } }] : [];
  }), replication[i].funding));
  const calculate = (rule: Setup, books: Market[], symbols: readonly string[], forecasters = books) => {
    const triggers = books.map((book, i) => signals(forecasters[i], drivers.get(rule.lag)!, rule).flatMap(({ index, side }) => {
      const trade = book.rowIndex.get(forecasters[i].rows[index].t);
      return trade === undefined ? [] : [{ index: trade, side }];
    }));
    return WINDOWS.map(window => summarize(books.map((book, i) =>
      replay(book, triggers[i], rule.hours * HOUR / FRAME, window, COSTS[1], true)), window, symbols));
  };
  return rules.map(rule => ({ rule, bybitExecution: calculate(rule, bybit, FLOW_MARKETS, binance),
    otherMarkets: calculate(rule, other, external), binance: calculate(rule, binance, FLOW_MARKETS) }));
}

async function main() {
  const [books, drivers] = await Promise.all([
    Promise.all(FLOW_MARKETS.map(async coin => prepare(await cryptoFlow(coin), await perpFunding(coin)))),
    Promise.all(DRIVERS.map(cryptoFlow)),
  ]);
  const features = new Map(LAGS.map(bars => [bars, drivers.map(rows => standardMoves(rows, bars))]));
  const configs: Setup[] = [];
  for (const drivers of ['basket', 'single'] as const) for (const direction of ['follow', 'fade'] as const) {
    for (const side of ['both', 'long', 'short'] as const) for (const lag of LAGS) {
      for (const threshold of [1.5, 2.5]) for (const hours of [1, 4, 12, 24, 72]) configs.push({ drivers, direction, side, lag, threshold, hours });
    }
  }
  const evaluate = (rule: Setup, triggers: Trigger[][], window: Window, higherCosts: boolean) =>
    summarize(books.map((input, i) => replay(input, triggers[i], rule.hours * HOUR / FRAME, window, COSTS[higherCosts ? 1 : 0],
      rule.hours >= 24)), window);
  const leaders = new Map<string, { rule: Setup; discovery: ReturnType<typeof summarize>; validation: ReturnType<typeof summarize>; ready: boolean; rank: number }>();
  const qualifies = (result: ReturnType<typeof summarize>, days: number) => result.net > 0 && result.days >= days &&
    result.markets.filter(market => market.net > 0).length >= 2 && result.drawdown <= .22;
  let earlyPasses = 0;
  let previousKey = '';
  let cached: Trigger[][] = [];
  for (const rule of configs) {
    const key = JSON.stringify({ ...rule, hours: 0 });
    if (previousKey !== key) {
      cached = books.map(input => signals(input, features.get(rule.lag)!, rule));
      previousKey = key;
    }
    const discovery = evaluate(rule, cached, WINDOWS[0], false);
    const validation = evaluate(rule, cached, WINDOWS[1], true);
    const rank = Math.min(discovery.score, validation.score);
    const ready = rank >= 1.25 && qualifies(discovery, 30) && qualifies(validation, 30);
    if (ready) earlyPasses++;
    const group = `${rule.direction}:${rule.side}:${rule.hours >= 24 ? 'swing' : 'intraday'}`;
    const prior = leaders.get(group);
    if (!prior || (ready && !prior.ready) || ready === prior.ready && rank > prior.rank) leaders.set(group, { rule, discovery, validation, ready, rank });
  }
  const ranked = [...leaders.values()].sort((a, b) => b.rank - a.rank);
  const later = ranked.filter(item => item.ready || item.rank > 0).map(item => {
    const { rule } = item;
    const selected = books.map(input => signals(input, features.get(rule.lag)!, rule));
    const baseline = evaluate(rule, selected, WINDOWS[2], false);
    const stress = evaluate(rule, selected, WINDOWS[2], true);
    const peerControl = evaluate(rule, books.map(input => signals(input, books.filter(peer => peer !== input)
      .map(peer => peer.moves.get(rule.lag)!), rule)), WINDOWS[2], true);
    const passes = item.ready && qualifies(stress, 30) && stress.score >= 2.2 && stress.score > peerControl.score &&
      (stress.averageBps ?? 0) > (peerControl.averageBps ?? 0);
    return { ...item, baseline, stress, peerControl, passes };
  });
  const report = { leaders: DRIVERS, markets: FLOW_MARKETS, coverage: books.map(input => input.rows.length), costs: COSTS,
    windows: WINDOWS.map(window => window.map(t => new Date(t).toISOString().slice(0, 10))),
    variants: configs.length, earlyPasses, ranked, later };
  writeFileSync(join('backtest', 'crypto-diffusion-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Cross-market crypto', configs.length, earlyPasses, later.map(row =>
    ({ rule: row.rule, stress: row.stress.net, days: row.stress.days, passes: row.passes })));
  if (process.argv.includes('--replicate')) {
    const results = await replicate(books, features);
    writeFileSync(join('backtest', 'crypto-diffusion-replication.json'), JSON.stringify(results, null, 2) + '\n');
    console.log('Replication', results.map(({ rule, bybitExecution, otherMarkets }) =>
      ({ rule, bybit: bybitExecution.map(s => s.net), additionalMarkets: otherMarkets.map(s => s.net) })));
  }
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
