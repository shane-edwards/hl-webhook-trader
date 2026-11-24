import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ETF_NAMES, ETF_DIR, ETF_TO } from './intraday-etf-data';
import type { StockBar } from '../lib/stocks/research';
import type { StockSession } from '../lib/stocks/intraday';
import type { IntradayBar } from '../lib/stocks/etoro';

const calendarUrl = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const periods = [['2023-02-01', '2025-01-01'], ['2025-01-01', '2026-01-01'], ['2026-01-01', ETF_TO]] as const;
const day = 86_400_000;
type Window = typeof periods[number];
type Side = 1 | -1;
type Trade = { date: string; pnl: number };
type Sample = { symbol: string; daily: StockBar[]; sessions: StockSession[] };
type IntradayRule = { family: 'noise-band' | 'opening-displacement' | 'fed-reaction'; side: Side; trigger: number; window: number };
const mid = (bar: IntradayBar) => (bar.bidOpen + bar.askOpen) * .5;

function evaluate(series: { trades: Trade[]; marks?: Trade[] }[], window: Window) {
  const [from, to] = window;
  const returns = new Map<string, number>();
  for (const item of series) for (const mark of item.marks ?? item.trades) returns.set(mark.date, (returns.get(mark.date) ?? 0) + mark.pnl / series.length);
  const start = Date.parse(from);
  const weeks = new Float64Array(Math.ceil((Date.parse(to) - start) / (7 * day)));
  let equity = 1, peak = 1, drawdown = 0;
  for (const [date, net] of [...returns].sort(([a], [b]) => a.localeCompare(b))) {
    equity += net;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
    weeks[Math.floor((Date.parse(date) - start) / (7 * day))] += net;
  }
  const average = weeks.reduce((sum, part) => sum + part, 0) / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, part) => sum + (part - average) ** 2, 0) / (weeks.length - 1) / weeks.length);
  const trades = series.flatMap(row => row.trades);
  return { net: equity - 1, drawdown, trades: trades.length, activeDays: new Set(trades.map(trade => trade.date)).size,
    score: error > 0 ? average / error : 0, averageBps: trades.length ? trades.reduce((n, t) => n + t.pnl, 0) / trades.length * 1e4 : null,
    positiveMarkets: series.filter(item => item.trades.reduce((sum, fill) => sum + fill.pnl, 0) > 0).length };
}

function intradayReplay(s: Sample, rule: IntradayRule, [from, to]: Window, fed: Set<string>, stress: boolean) {
  let equity = 1;
  const trades: Trade[] = [], marks: Trade[] = [];
  const b = rule.side;
  const bookCost = b === 1 ? stress ? .00055 : .0002 : stress ? .0024 : .0017;
  for (let i = 16; i < s.sessions.length; i++) {
    const { day: date, bars } = s.sessions[i];
    if (date < from || date >= to) continue;
    const prior = s.sessions[i - 1].bars.at(-1)!;
    const history = s.sessions.slice(i - 14, i);
    const exposure = equity;
    let entry: { price: number; at: number } | null = null;
    let cash = 0, dollars = 0, volume = 0;
    const exit = (next: number) => {
      if (!entry) return;
      const quote = bars[next];
      const price = b === 1 ? quote.bidOpen : quote.askOpen;
      const pnl = b * (price * (1 - b * bookCost) / entry.price - 1);
      trades.push({ date, pnl: pnl * exposure });
      cash += pnl;
      entry = null;
    };
    for (let j = 0; j < 12; j++) {
      const bar = bars[j], next = bars[j + 1];
      if (j === 11) { exit(12); break; }
      if (rule.family === 'noise-band') {
        if (!(bar.volume > 0)) { exit(j + 1); break; }
        dollars += bar.volume * (bar.bidHigh + bar.bidLow + bar.bidClose) / 3;
        volume += bar.volume;
        const move = history.reduce((sum, session) => sum + Math.abs(session.bars[j].bidClose / session.bars[0].bidOpen - 1), 0) / 14;
        const anchor = b === 1 ? Math.max(mid(bars[0]), prior.bidClose) : Math.min(mid(bars[0]), prior.bidClose);
        const band = anchor * (1 + b * move * rule.trigger);
        const beyond = b * bar.bidClose > Math.max(b * band, b * dollars / volume);
        if (entry && !beyond) exit(j + 1);
        if (!entry && beyond) {
          entry = { price: (b === 1 ? next.askOpen : next.bidOpen) * (1 + b * bookCost), at: j + 1 };
        }
        continue;
      }
      if (entry && j + 1 - entry.at >= rule.window) { exit(j + 1); break; }
      const decide = rule.family === 'fed-reaction' ? 9 : 1;
      if (j !== decide || (rule.family === 'fed-reaction' && !fed.has(date))) continue;
      const baseline = rule.family === 'fed-reaction' ? mid(bar) : mid(bars[0]);
      const measure = b * Math.log(bar.bidClose / baseline);
      const openGap = mid(bars[0]) / prior.bidClose - 1;
      if (measure >= rule.trigger && (rule.family !== 'opening-displacement' || b * openGap >= 0)) {
        entry = { price: (b === 1 ? next.askOpen : next.bidOpen) * (1 + b * bookCost), at: j + 1 };
      }
    }
    const value = cash * exposure;
    equity += value;
    if (value !== 0) marks.push({ date, pnl: value });
  }
  return { trades, marks };
}

function intraday(universe: Sample[], fed: Set<string>) {
  const simple = [1, -1].flatMap(side => ([.75, 1, 1.25].map(trigger => ({ family: 'noise-band', side, trigger, window: 0 }))));
  const fixed = [1, -1].flatMap(side => (['opening-displacement', 'fed-reaction'] as const).flatMap(family =>
    [.0015, .003, .005].flatMap(trigger => (family === 'fed-reaction' ? [1, 2] : [2, 6, 10]).map(window => ({ family, side, trigger, window })))));
  const rules = [...simple, ...fixed] as IntradayRule[];
  type Summary = ReturnType<typeof evaluate>;
  const finalists = [];
  const earlier = rules.map(rule => {
    const score = (window: Window, stressed: boolean) => evaluate(universe.map(asset => intradayReplay(asset, rule, window, fed, stressed)), window);
    const discovery = score(periods[0], false), validation = score(periods[1], true);
    return { rule, discovery, validation, rank: Math.min(discovery.score, validation.score), score };
  });
  for (const family of new Set(rules.map(rule => rule.family))) for (const side of [1, -1]) {
    const minDays = family === 'fed-reaction' ? 6 : 28;
    const best = earlier.filter(row => row.rule.family === family && row.rule.side === side &&
      [row.discovery, row.validation].every(r => r.activeDays >= minDays && r.trades >= minDays * 2 && r.net > 0 &&
        r.score >= 1.25 && r.positiveMarkets >= 3)).sort((a, b) => b.rank - a.rank)[0];
    if (!best) continue;
    const { rule, discovery, validation, rank } = best;
    const holdout: Summary = best.score(periods[2], false), stressed = best.score(periods[2], true);
    finalists.push({ rule, discovery, validation, rank, holdout, stressed,
      paper: stressed.net > 0 && holdout.net > 0 && stressed.score >= 2.3 && stressed.activeDays >= minDays &&
        stressed.positiveMarkets >= 3 && stressed.drawdown < .18 });
  }
  const diagnostic = earlier.sort((a, b) => b.rank - a.rank).slice(0, 5).map(({ rule, discovery, validation, rank }) => ({ rule, discovery, validation, rank }));
  return { tried: rules.length, testedSymbols: universe.map(item => item.symbol), fedDays: [...fed].sort(), finalists, diagnostic };
}

type Rotation = { lookback: number; hold: number; count: number; regime: boolean };
const isDefensive = (symbol: string) => ['GLD', 'TLT'].includes(symbol);

function swingReplay(assets: Sample[], spine: StockBar[], rule: Rotation, [from, to]: Window, fee: number) {
  const series = assets.map(asset => ({ symbol: asset.symbol, byDay: new Map(asset.daily.map(row => [row.day, row])) }));
  const marks: Trade[] = [], trades: Trade[] = [];
  let capital = 1;
  for (let i = 150; i < spine.length - rule.hold; i++) {
    const start = spine[i], end = spine[i + rule.hold];
    if (start.day < from) continue;
    if (end.day >= to) break;
    const trend = spine.slice(i - 150, i).reduce((sum, row) => sum + row.bidClose, 0) / 150;
    const riskOn = spine[i - 1].bidClose > trend;
    const picked = series.flatMap(feed => {
      const current = feed.byDay.get(spine[i - 1].day), old = feed.byDay.get(spine[i - 1 - rule.lookback].day);
      if (!current || !old || (rule.regime && !riskOn && !isDefensive(feed.symbol))) return [];
      const strength = current.bidClose / old.bidClose - 1;
      return strength > 0 ? [{ ...feed, strength }] : [];
    }).sort((a, b) => b.strength - a.strength).slice(0, rule.count);
    const book = picked.flatMap(asset => {
      const open = asset.byDay.get(start.day);
      const exit = asset.byDay.get(end.day);
      if (!open || !exit) return [];
      return [{ ...asset, quantity: capital / rule.count / (open.askOpen * (1 + fee)), principal: capital / rule.count, lastValue: 0, exit }];
    });
    for (let j = i; j <= i + rule.hold; j++) {
      let change = 0;
      for (const holding of book) {
        const current = holding.byDay.get(spine[j].day);
        if (!current) throw new Error(`Missing daily quote while holding ${holding.symbol}`);
        const px = j === i + rule.hold ? current.bidOpen : current.bidClose;
        const value = px * (1 - fee) * holding.quantity - holding.principal;
        change += value - holding.lastValue;
        holding.lastValue = value;
      }
      if (change) marks.push({ date: spine[j].day, pnl: change });
      capital += change;
    }
    for (const holding of book) trades.push({ date: end.day, pnl: holding.lastValue });
    i += rule.hold - 1;
  }
  return { trades, marks };
}

function passive(spine: StockBar[], [from, to]: Window, fee: number) {
  const part = spine.filter(row => row.day >= from && row.day < to);
  const units = 1 / (part[0].askOpen * (1 + fee));
  let prior = 1;
  return { trades: [], marks: part.map(row => {
    const net = row.bidClose * (1 - fee) * units;
    const pnl = net - prior;
    prior = net;
    return { date: row.day, pnl };
  }) };
}

function swing(assets: Sample[], spy: Sample) {
  const dates = assets.map(asset => new Set(asset.daily.map(row => row.day)));
  const spine = spy.daily.filter(row => dates.every(calendar => calendar.has(row.day)));
  const removed = spy.daily.length - spine.length;
  if (removed / spy.daily.length > .03) throw new Error('ETF calendars do not align closely enough.');
  const benchmark = periods.map(period => evaluate([passive(spine, period, .00055)], period));
  const variants: Rotation[] = [20, 40, 63].flatMap(lookback => [5, 10, 20].flatMap(hold => [1, 2].flatMap(count =>
    [false, true].map(regime => ({ lookback, hold, count, regime })))));
  const test = (rule: Rotation, index: number, expense: number) => evaluate([swingReplay(assets, spine, rule, periods[index], expense)], periods[index]);
  const profiles = variants.map(rule => {
    const discovery = test(rule, 0, .0002), validation = test(rule, 1, .00055);
    const rank = Math.min(discovery.score, validation.score);
    return { rule, discovery, validation, rank };
  }).sort((a, b) => b.rank - a.rank);
  const chosen = profiles.find(row => [row.discovery, row.validation].every((x, i) => x.net > 0 && x.trades >= 15 && x.score > 1.2 &&
    x.drawdown <= .85 * benchmark[i].drawdown && (x.net >= benchmark[i].net || x.score >= 1.15 * benchmark[i].score)));
  const holdout = chosen ? test(chosen.rule, 2, .0002) : null;
  const stressed = chosen ? test(chosen.rule, 2, .00055) : null;
  const passes = !!stressed && !!holdout && stressed.trades >= 10 && stressed.net > 0 && stressed.score >= 2.0 &&
    stressed.drawdown < .85 * benchmark[2].drawdown && (stressed.net >= benchmark[2].net || stressed.score >= 1.15 * benchmark[2].score);
  return { tried: variants.length, assets: assets.map(asset => asset.symbol), missingSessionsExcluded: removed, benchmark, selected: chosen ?? null, holdout, stressed, passes,
    diagnostic: profiles.slice(0, 3) };
}

async function main() {
  const response = await fetch(calendarUrl, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error('Federal Reserve calendar unavailable.');
  const html = await response.text();
  const dates = [...html.matchAll(/<strong>Statement:<\/strong>[\s\S]{0,240}?\/newsevents\/pressreleases\/monetary(202[3-6])([01]\d)([0-3]\d)a\.htm/g)]
    .map(match => `${match[1]}-${match[2]}-${match[3]}`);
  const fed = new Set(dates.filter(date => date < ETF_TO));
  if (fed.size < 28) throw new Error('Could not verify the FOMC statement dates.');
  const all: Sample[] = ETF_NAMES.flatMap(symbol => {
    const file = join(ETF_DIR, `${symbol}.json`);
    return existsSync(file) ? [JSON.parse(readFileSync(file, 'utf8')) as Sample] : [];
  });
  const usable = all.filter(sample => sample.sessions.length > 850);
  const daily = all.filter(sample => sample.daily.length > 900);
  const spy = daily.find(asset => asset.symbol === 'SPY');
  if (!spy || daily.length < 6 || usable.length < 4) throw new Error('Waiting for complete eToro ETF quotes.');
  const result = { sources: ['eToro paired bid/ask ETF quotes', calendarUrl], periods, intraday: intraday(usable, fed), swing: swing(daily, spy) };
  writeFileSync(join(process.cwd(), 'backtest', 'etf-signal-results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ intraday: { tried: result.intraday.tried, finalists: result.intraday.finalists,
    bestEarlier: result.intraday.diagnostic.slice(0, 2) }, swing: { tried: result.swing.tried, chosen: result.swing.selected,
    later: result.swing.holdout, stress: result.swing.stressed, benchmark: result.swing.benchmark[2], passes: result.swing.passes } }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
