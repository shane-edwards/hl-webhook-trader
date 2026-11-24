import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAJORS, HOUR, DAY, DATA_END, loadPerps, perpFunding, perpetualHourly, spotHourly, type Funding } from './price-action-data';
import { getStrategy, type Bar } from '../lib/autopilot/strategies';
import { simulate } from '../lib/autopilot/simulate';
import { pickBasket } from '../lib/autopilot/momentum';
import { marketDataClient } from '../lib/hyperliquid/from-settings';

// Fixed before viewing this experiment's results. The 2026 window never ranks variants.
const WINDOWS = [
  { name: 'train', from: Date.UTC(2024, 1, 1), to: Date.UTC(2025, 0, 1) },
  { name: 'validation', from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) },
  { name: 'holdout', from: Date.UTC(2026, 0, 1), to: DATA_END },
] as const;
const FEES = [{ fill: .00085, stop: .0003 }, { fill: .0015, stop: .0007 }] as const;
type Fees = typeof FEES[number];
type Side = 1 | -1;
type Pattern = 'failed-break' | 'accepted-break' | 'crowded-failure';
type Confirm = 'none' | 'volume' | 'trend';
type Config = { hours: number; hold: number; reward: number; side: Side; pattern: Pattern; confirm: Confirm };
type CandleInput = { bars: Bar[]; atr: number[]; trend: number[]; normalVolume: number[]; rate: number[]; funding: Map<number, number>; frame: number };
type Trade = { time: number; pnl: number };

function mean(values: number[], period: number) {
  let sum = 0;
  return values.map((value, i) => {
    sum += value - (i >= period ? values[i - period] : 0);
    return sum / Math.min(i + 1, period);
  });
}

function features(bars: Bar[], funding: Funding[], frame: number): CandleInput {
  const atr = mean(bars.map((bar, i) => i === 0 ? bar.h - bar.l : Math.max(bar.h - bar.l, Math.abs(bar.h - bars[i - 1].c), Math.abs(bar.l - bars[i - 1].c))), 24);
  const normalVolume = mean(bars.map(row => row.v ?? 0), 32);
  const trend = mean(bars.map(row => row.c), 120);
  let index = 0;
  const rate = bars.map(bar => {
    while (index + 1 < funding.length && funding[index + 1].time <= bar.t) index++;
    return funding[index].time <= bar.t ? funding[index].rate * 8 / funding[index].hours : 0;
  });
  const bucket = new Map<number, number>();
  for (const row of funding) {
    const t = Math.floor(row.time / frame) * frame;
    bucket.set(t, (bucket.get(t) ?? 0) + row.rate);
  }
  return { bars, frame, atr, trend, normalVolume, rate, funding: bucket };
}

function extrema(bars: Bar[], span: number) {
  const lower = new Float64Array(bars.length), upper = new Float64Array(bars.length);
  const lows: number[] = [], highs: number[] = [];
  let lo = 0, hi = 0;
  for (let i = 0; i < bars.length; i++) {
    while (lo < lows.length && lows[lo] < i - span) lo++;
    while (hi < highs.length && highs[hi] < i - span) hi++;
    lower[i] = lo < lows.length ? bars[lows[lo]].l : NaN;
    upper[i] = hi < highs.length ? bars[highs[hi]].h : NaN;
    while (lo < lows.length && bars[lows.at(-1)!].l >= bars[i].l) lows.pop();
    while (hi < highs.length && bars[highs.at(-1)!].h <= bars[i].h) highs.pop();
    lows.push(i); highs.push(i);
  }
  return { lower, upper };
}

function signals(input: CandleInput, level: ReturnType<typeof extrema>, cfg: Config) {
  const { bars, rate, atr, trend, normalVolume, frame } = input;
  const out: { i: number; stop: number }[] = [];
  for (let i = Math.max(150, Math.ceil(cfg.hours * HOUR / frame)); i < bars.length - 1; i++) {
    const bar = bars[i], prior = bars[i - 1], vol = atr[i - 1], side = cfg.side;
    if (!(vol > 0) || bar.t - prior.t !== frame || bars[i + 1].t - bar.t !== frame) continue;
    if (cfg.confirm === 'volume' && (bar.v ?? 0) < normalVolume[i - 1] * 1.3) continue;
    if (cfg.confirm === 'trend' && side * (bar.c - trend[i - 1]) <= 0) continue;
    const behind = side === 1 ? level.lower[i] : level.upper[i];
    const beyond = side === 1 ? level.upper[i - 1] : level.lower[i - 1];
    const wick = side === 1 ? bar.l : bar.h;
    const failed = side * (wick - behind) < -.04 * vol && side * (bar.c - behind) > .10 * vol &&
      side * (bar.c - (bar.h + bar.l) / 2) > 0;
    const accepted = side * (prior.c - beyond) > .10 * vol && Math.abs(wick - beyond) < .60 * vol &&
      side * (bar.c - beyond) > .20 * vol;
    if (cfg.pattern === 'accepted-break' && !accepted) continue;
    if (cfg.pattern !== 'accepted-break' && !failed) continue;
    if (cfg.pattern === 'crowded-failure' && side * rate[i] > -.00015) continue;
    out.push({ i, stop: wick - side * .20 * vol });
  }
  return out;
}

function tradeReplay(input: CandleInput, orders: ReturnType<typeof signals>, cfg: Config, window: typeof WINDOWS[number], cost: Fees) {
  const { bars, atr, frame, funding } = input;
  const trades: Trade[] = [];
  let next = 0;
  for (const signal of orders) {
    const i = signal.i, open = bars[i + 1], side = cfg.side;
    if (bars[i].t < window.from || i < next) continue;
    // Only consider entries whose full planned life is inside the evaluation window.
    const exitAt = i + Math.round(cfg.hold * HOUR / frame) + 1;
    if (!bars[exitAt] || bars[exitAt].t >= window.to) break;
    const entry = open.o * (1 + side * cost.fill);
    const risk = side * (entry - signal.stop);
    if (!(risk >= .25 * atr[i] && risk <= 5 * atr[i])) continue;
    const target = entry + side * cfg.reward * risk;
    let pnlFunding = 0;
    for (let j = i + 1; j <= exitAt; j++) {
      const b = bars[j];
      const gap = b.t - bars[j - 1].t !== frame;
      const scheduledExit = gap || j === exitAt;
      const stopped = !scheduledExit && (side === 1 ? b.l <= signal.stop : b.h >= signal.stop);
      const reached = !scheduledExit && (side === 1 ? b.h >= target : b.l <= target);
      if (j > i + 1) pnlFunding -= side * (funding.get(b.t) ?? 0) * b.o / entry;
      if (stopped || reached || scheduledExit) {
        const raw = scheduledExit ? b.o : stopped ?
          side === 1 ? Math.min(signal.stop, b.o) : Math.max(signal.stop, b.o) : target;
        const exit = raw * (1 - side * (cost.fill + (stopped || gap ? cost.stop : 0)));
        trades.push({ time: b.t, pnl: side * (exit / entry - 1) + pnlFunding });
        next = j;
        break;
      }
    }
  }
  return trades;
}

function stats(views: Trade[][], window: { from: number; to: number }) {
  const daily = new Float64Array(Math.ceil((window.to - window.from) / DAY));
  for (const view of views) for (const trade of view) {
    const day = Math.floor((trade.time - window.from) / DAY);
    if (day >= 0 && day < daily.length) daily[day] += trade.pnl / views.length;
  }
  let equity = 1, peak = 1, drawdown = 0;
  const weeks: number[] = [];
  let week = 0;
  for (let i = 0; i < daily.length; i++) {
    equity *= 1 + daily[i];
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    week += daily[i];
    if (i % 7 === 6 || i === daily.length - 1) { weeks.push(week); week = 0; }
  }
  const average = weeks.reduce((sum, value) => sum + value, 0) / weeks.length;
  const variance = weeks.reduce((sum, value) => sum + (value - average) ** 2, 0) / (weeks.length - 1);
  const trades = views.flat();
  return { net: equity - 1, drawdown, score: variance > 0 ? average / Math.sqrt(variance / weeks.length) : 0,
    trades: trades.length, avgNetBps: trades.reduce((sum, trade) => sum + trade.pnl, 0) / Math.max(trades.length, 1) * 10_000,
    positiveMarkets: views.filter(rows => rows.reduce((sum, row) => sum + row.pnl, 0) > 0).length,
    byMarket: views.map(rows => ({ trades: rows.length, total: rows.reduce((sum, row) => sum + row.pnl, 0) })) };
}

async function directions(funding: Funding[][]) {
  const reports = [];
  const perAsset = [];
  let tested = 0;
  for (const frame of [HOUR / 4, HOUR, HOUR * 4]) {
    const inputs = MAJORS.map((coin, i) => features(loadPerps(coin, frame), funding[i], frame));
    const levels = new Map([12, 24, 72].map(hours => [hours, inputs.map(input => extrema(input.bars, Math.round(hours * HOUR / frame)))]));
    const local = new Map<string, { asset: number; cfg: Config; rank: number }>();
    for (const pattern of ['failed-break', 'accepted-break', 'crowded-failure'] as const) {
      for (const side of [1, -1] as const) {
        let selected: { cfg: Config; rank: number; early: ReturnType<typeof stats>; validation: ReturnType<typeof stats> } | null = null;
        for (const hours of [12, 24, 72]) for (const confirm of ['none', 'volume', 'trend'] as const) {
          for (const hold of [8, 24, 72]) for (const reward of [1.5, 2.5]) {
            tested++;
            const cfg = { hours, hold, reward, side, pattern, confirm };
            const orders = inputs.map((input, i) => signals(input, levels.get(hours)![i], cfg));
            const earlyTrades = inputs.map((input, i) => tradeReplay(input, orders[i], cfg, WINDOWS[0], FEES[0]));
            const validationTrades = inputs.map((input, i) => tradeReplay(input, orders[i], cfg, WINDOWS[1], FEES[1]));
            for (let asset = 0; asset < MAJORS.length; asset++) {
              if (earlyTrades[asset].length < 20 || validationTrades[asset].length < 20) continue;
              const first = stats([earlyTrades[asset]], WINDOWS[0]);
              const second = stats([validationTrades[asset]], WINDOWS[1]);
              const rank = Math.min(first.score, second.score);
              const key = `${asset}:${side}`;
              if (rank >= 1.2 && first.net > 0 && second.net > 0 && first.drawdown <= .22 && second.drawdown <= .22 &&
                  rank > (local.get(key)?.rank ?? -Infinity)) local.set(key, { asset, cfg, rank });
            }
            const early = stats(earlyTrades, WINDOWS[0]);
            const validation = stats(validationTrades, WINDOWS[1]);
            const rank = Math.min(early.score, validation.score);
            if (rank < 1 || [early, validation].some(row => row.trades < 45 || row.net <= 0 || row.positiveMarkets < 2 || row.drawdown > .22)) continue;
            if (!selected || rank > selected.rank) selected = { cfg, rank, early, validation };
          }
        }
        if (!selected) continue;
        const { cfg } = selected;
        const orders = inputs.map((input, i) => signals(input, levels.get(cfg.hours)![i], cfg));
        const held = FEES.map(cost => stats(inputs.map((input, i) => tradeReplay(input, orders[i], cfg, WINDOWS[2], cost)), WINDOWS[2]));
        const pass = held.every(row => row.net > 0 && row.trades >= 45 && row.positiveMarkets >= 2 && row.drawdown <= .22) && held[1].score >= 2.3;
        reports.push({ frameHours: frame / HOUR, ...selected, holdout: held[0], stressed: held[1], paper: pass });
      }
    }
    for (const { asset, cfg, rank } of local.values()) {
      const input = inputs[asset], orders = signals(input, levels.get(cfg.hours)![asset], cfg);
      const regular = tradeReplay(input, orders, cfg, WINDOWS[2], FEES[0]);
      const costStress = tradeReplay(input, orders, cfg, WINDOWS[2], FEES[1]);
      const holdout = stats([regular], WINDOWS[2]), stressed = stats([costStress], WINDOWS[2]);
      const midway = Date.UTC(2026, 5, 1);
      const positiveInBoth = [[WINDOWS[2].from, midway], [midway, WINDOWS[2].to]].every(([from, to]) =>
        stats([costStress], { from, to }).net > 0);
      perAsset.push({ coin: MAJORS[asset], frameHours: frame / HOUR, cfg, rank, holdout, stressed,
        paper: stressed.score >= 3.1 && stressed.trades >= 25 && stressed.drawdown <= .22 && positiveInBoth });
    }
  }
  return { tested, reports, perAsset };
}

const CARRY = [{ name: 'Permanent hedge', on: -Infinity, off: -Infinity }, { name: 'Funding-regime hedge', on: .0027, off: .0003 }] as const;
type Carry = typeof CARRY[number];
function carryReplay(spot: Bar[], perps: Bar[], funding: Funding[], cfg: Carry, window: { from: number; to: number }, edge: number) {
  const fund = new Map(funding.map(row => [row.time, row.rate]));
  const perp = new Map(perps.map(bar => [bar.t, bar]));
  const rows = spot.flatMap(bar => {
    const derivative = perp.get(bar.t);
    return derivative ? [{ t: bar.t, spot: bar, derivative }] : [];
  });
  if (rows.length < .99 * spot.length) throw new Error('Spot and derivatives do not align');
  const collateral = 2.5;
  let capital = 1, peak = 1, maxDrawdown = 0, openHours = 0, entries = 0, resets = 0;
  let holding: { spot: number; derivative: number; units: number; funding: number } | null = null;
  let trailing = 0;
  for (const [i, row] of rows.entries()) {
    const { t, spot, derivative } = row;
    const s = spot.o, p = derivative.o;
    const drop = i >= 336 ? fund.get(rows[i - 336].t) ?? 0 : 0;
    if (t >= window.from && t <= window.to) {
      // A collateral check uses adverse prices if a fast move inside this bar would exhaust margin.
      if (holding) {
        holding.funding += (fund.get(t) ?? 0) * holding.units * p;
        const mark = (x: number, y: number) => holding!.units * (x - holding!.spot - y + holding!.derivative) + holding!.funding;
        const exitCost = (x: number, y: number) => holding!.units * (x + y) * edge;
        const forced = derivative.h >= holding.derivative * 2.38;
        const reset = p > holding.derivative * 1.75 || p < holding.derivative * .65;
        const exit = forced || reset || t + HOUR >= window.to || t % DAY === 0 && trailing < cfg.off;
        if (exit) {
          const x = forced ? spot.l : s, y = forced ? derivative.h : p;
          capital += mark(x, y) - exitCost(x, y);
          holding = null;
          if (reset || forced) resets++;
        } else {
          const equity = capital + mark(s, p) - exitCost(s, p);
          peak = Math.max(peak, equity);
          maxDrawdown = Math.max(maxDrawdown, 1 - equity / peak);
          openHours++;
        }
      } else if (t % DAY === 0 && t + DAY < window.to && trailing >= cfg.on) {
        const units = capital / (collateral * Math.max(s, p));
        capital -= units * (s + p) * edge;
        holding = { spot: s, derivative: p, units, funding: 0 };
        entries++;
      }
      if (!holding) { peak = Math.max(peak, capital); maxDrawdown = Math.max(maxDrawdown, 1 - capital / peak); }
    }
    trailing += (fund.get(t) ?? 0) - drop;
  }
  return { net: capital - 1, drawdown: maxDrawdown, entries, resets, openHours };
}

async function carryVenue() {
  const client = marketDataClient();
  const end = Date.UTC(2026, 10, 23);
  const since = end - 195 * DAY;
  const window = { from: since + 15 * DAY, to: end };
  const spotNames = ['@142', '@151', '@156'];
  const markets = [];
  for (let i = 0; i < MAJORS.length; i++) {
    const coin = MAJORS[i];
    try {
      const [spot, perpetual, funding] = await Promise.all([
        client.getCandles(spotNames[i], '1h', since, end),
        client.getCandles(coin, '1h', since, end),
        client.getFundingRates(coin, since, end),
      ]);
      const costs = funding.map(row => ({ time: Math.round(row.time / HOUR) * HOUR, hours: 1, rate: row.rate }));
      const expected = (end - since) / HOUR;
      const valid = [spot.length, perpetual.length, new Set(costs.map(row => row.time)).size].every(n => n >= .98 * expected);
      if (!valid) {
        markets.push({ coin, issue: 'Incomplete venue prices or funding', candles: [spot.length, perpetual.length], payments: costs.length });
        continue;
      }
      const aggregate = (edge: number) => CARRY.map(cfg => ({ name: cfg.name, ...carryReplay(spot, perpetual, costs, cfg, window, edge) }));
      const segments = [0, 1, 2].map(segment => {
        const from = window.from + 60 * DAY * segment;
        const to = from + 60 * DAY;
        return { from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10),
          ...carryReplay(spot, perpetual, costs, CARRY[1], { from, to }, .0018) };
      });
      markets.push({ coin, regular: aggregate(.0009), stressed: aggregate(.0018), segments });
    } catch (problem) {
      markets.push({ coin, issue: problem instanceof Error ? problem.message : 'Venue data unavailable' });
    }
  }
  return { window: { from: new Date(window.from).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) }, markets };
}

async function macdReplication(majors: Bar[][], majorFunding: Funding[][]) {
  const reserved = ['XRP', 'LINK', 'LTC'] as const;
  const [other, rates] = await Promise.all([Promise.all(reserved.map(perpetualHourly)), Promise.all(reserved.map(perpFunding))]);
  const from = Date.UTC(2026, 0, 1), to = DATA_END;
  const rule = getStrategy('macd_trend')!;
  function report(series: Bar[][], costs: Funding[][], names: readonly string[], fee: Fees) {
    const runs = series.map((bars, index) => {
      const start = bars.findIndex(bar => bar.t >= from);
      const slice = bars.filter(bar => bar.t < to);
      const payments = new Map(costs[index].map(row => [row.time, row.rate]));
      const result = simulate(slice, rule, true, new Map(), start, { cost: fee.fill, stopSlippage: fee.stop, hourlyFunding: payments });
      const hourly = new Map(result.hourly.map((row, i) => [slice[start + i].t, row.r]));
      return { hourly, trades: result.trades };
    });
    const grid = new Set(runs.flatMap(run => [...run.hourly.keys()]));
    let equity = 1, peak = 1, drawdown = 0;
    for (const hour of [...grid].sort((a, b) => a - b)) {
      equity *= 1 + runs.reduce((sum, run) => sum + (run.hourly.get(hour) ?? 0), 0) / runs.length;
      peak = Math.max(peak, equity);
      drawdown = Math.max(drawdown, 1 - equity / peak);
    }
    return { net: equity - 1, drawdown, trades: runs.reduce((sum, run) => sum + run.trades.length, 0),
      markets: runs.map((run, i) => ({ coin: names[i],
        net: [...run.hourly.values()].reduce((value, ret) => value * (1 + ret), 1) - 1, trades: run.trades.length })) };
  }
  return { period: '2026-01-01 to 2026-10-31', reusedRule: rule.name, legs: 'long and short',
    original: FEES.map(fee => report(majors, majorFunding, MAJORS, fee)), outsideOriginalMarketSet: FEES.map(fee => report(other, rates, reserved, fee)) };
}

const BASKET = [...MAJORS, 'XRP', 'LINK', 'LTC', 'ADA', 'DOGE', 'AVAX', 'BCH'];
type Position = { symbol: string; side: Side; entry: number; units: number; closed?: number };

async function stoppedMomentum(majors: Bar[][], majorFunding: Funding[][]) {
  const extra = BASKET.slice(MAJORS.length);
  const [prices, funding] = await Promise.all([Promise.all(extra.map(perpetualHourly)), Promise.all(extra.map(perpFunding))]);
  const feeds = new Map(BASKET.map((symbol, index) => [symbol, { bars: new Map([...majors, ...prices][index].map(bar => [bar.t, bar])),
    funding: new Map([...majorFunding, ...funding][index].map(row => [row.time, row.rate])) }]));
  const week = 7 * DAY;
  const monday = Date.UTC(2024, 3, 1);
  function replay(start: number, end: number, cost: Fees) {
    let equity = 1, peak = 1, drawdown = 0, won = 0, baskets = 0, stopped = 0;
    const returns = [];
    for (let t = monday; t + week <= end; t += week) {
      if (t < start) continue;
      const ranking = BASKET.flatMap(symbol => {
        const feed = feeds.get(symbol)!.bars;
        const last = feed.get(t - HOUR), old = feed.get(t - HOUR - 90 * DAY), entry = feed.get(t);
        return last && old && entry ? [{ symbol, ret: last.c / old.c - 1, price: entry.o }] : [];
      });
      if (ranking.length !== BASKET.length) throw new Error('Momentum ranking has missing markets');
      const { longs, shorts } = pickBasket(ranking);
      const legs: Position[] = [
        ...longs.map(row => ({ ...row, side: 1 as const })), ...shorts.map(row => ({ ...row, side: -1 as const })),
      ].map(row => ({ symbol: row.symbol, side: row.side, entry: row.price, units: equity / (4 * row.price) }));
      const before = equity;
      equity -= before * cost.fill;
      baskets++;
      let flatten = false;
      for (let h = t; h <= t + week; h += HOUR) {
        let paper = 0;
        const exit = flatten || h === t + week;
        for (const leg of legs) {
          if (leg.closed != null) continue;
          const feed = feeds.get(leg.symbol)!;
          const bar = feed.bars.get(h);
          if (!bar) throw new Error(`Missing momentum prices for ${leg.symbol}`);
          if (h > t) equity -= leg.units * leg.side * bar.o * (feed.funding.get(h) ?? 0);
          const stop = leg.entry * (1 - .15 * leg.side);
          const tripped = !exit && (leg.side === 1 ? bar.l <= stop : bar.h >= stop);
          if (tripped || exit) {
            const fill = tripped ? leg.side === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o) : bar.o;
            equity += leg.units * (leg.side * (fill - leg.entry) - fill * (cost.fill + (tripped ? cost.stop : 0)));
            leg.closed = fill;
            if (tripped) flatten = true;
          } else paper += leg.units * leg.side * (bar.c - leg.entry);
        }
        const mark = equity + paper;
        peak = Math.max(peak, mark);
        drawdown = Math.max(drawdown, 1 - mark / peak);
        if (exit) { if (flatten) stopped++; break; }
      }
      if (equity > before) won++;
      returns.push(equity / before - 1);
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const error = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1) / returns.length);
    return { net: equity - 1, drawdown, baskets, won, stopped, score: error > 0 ? mean / error : 0 };
  }
  return { universe: BASKET, lookbackDays: 90, protectionPct: 15, windows: WINDOWS.map(w => ({ name: w.name,
    regular: replay(w.from, w.to, FEES[0]), stressed: replay(w.from, w.to, FEES[1]) })) };
}

async function main() {
  const funding = await Promise.all(MAJORS.map(perpFunding));
  const spot = await Promise.all(MAJORS.map(spotHourly));
  const perps = MAJORS.map(coin => loadPerps(coin, HOUR));
  const carry = CARRY.map(cfg => ({ name: cfg.name, markets: MAJORS.map((coin, i) => ({ coin, windows: WINDOWS.map(window => ({ window: window.name,
    regular: carryReplay(spot[i], perps[i], funding[i], cfg, window, .0009),
    stressed: carryReplay(spot[i], perps[i], funding[i], cfg, window, .0018),
  })) })) }));
  const [directional, venue, macd, momentum] = await Promise.all([
    directions(funding), carryVenue(), macdReplication(perps, funding), stoppedMomentum(perps, funding),
  ]);
  const result = { testedThrough: '2026-10-31', venues: ['Binance USD-M perpetuals and spot', 'Hyperliquid spot and perpetuals'], coins: MAJORS,
    windows: WINDOWS.map(w => ({ name: w.name, from: new Date(w.from).toISOString().slice(0, 10), until: new Date(w.to).toISOString().slice(0, 10) })),
    directional, carry, venue, macd, momentum };
  writeFileSync(join(process.cwd(), 'backtest', 'price-action-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ tested: directional.tested, selected: directional.reports.map(row => ({ ...row.cfg, frameHours: row.frameHours,
    later: row.holdout.net, stress: row.stressed.net, trades: row.stressed.trades, score: row.stressed.score, paper: row.paper })),
    byAsset: directional.perAsset.map(row => ({ coin: row.coin, frameHours: row.frameHours, ...row.cfg, net: row.holdout.net,
      stressed: row.stressed.net, trades: row.stressed.trades, paper: row.paper })),
    carry: carry.map(row => ({ name: row.name, markets: row.markets.map(m => ({ coin: m.coin, ...m.windows[2] })) })), venue, macd, momentum }, null, 2));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
