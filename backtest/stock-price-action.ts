import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { regularStockSessions } from '../lib/stocks/intraday';
import type { IntradayBar } from '../lib/stocks/etoro';

const basket = ['AAPL', 'AMD', 'AMZN', 'AVGO', 'BA', 'CAT', 'GOOGL', 'JPM', 'LLY', 'META', 'MSFT', 'MU', 'NVDA', 'PLTR', 'TSLA', 'WMT', 'XOM'];
const dir = join(process.cwd(), 'backtest', 'data', 'intraday', 'stock-opening');
const files = readdirSync(dir);
const windows = [['2025-06-01', '2026-01-01'], ['2026-01-01', '2026-07-01'], ['2026-07-01', '2026-11-21']] as const;
type Session = ReturnType<typeof regularStockSessions>['sessions'][number];
type Rule = { id: 'prior-extreme' | 'opening-range' | 'relative-gap'; direction: 1 | -1; hold: number; confirm: 'none' | 'SPY' | 'relative-volume'; strength: number };
type Fill = { date: string; symbol: string; base: number; stress: number };

function history(symbol: string) {
  const bars: IntradayBar[] = files.filter(name => name.startsWith(`${symbol}-`)).flatMap(file => JSON.parse(readFileSync(join(dir, file), 'utf8')));
  const sessions = regularStockSessions(bars, 30).sessions;
  if (sessions.length < 300) throw new Error(`Insufficient paired quotes for ${symbol}`);
  return sessions;
}

const spy = history('SPY');
const spyByDay = new Map(spy.map((session, i) => [session.day, { session, previous: spy[i - 1] }]));
const markets = basket.map(symbol => ({ symbol, sessions: history(symbol) }));

function trades(cfg: Rule): Fill[] {
  const live = [];
  for (const { symbol, sessions } of markets) for (let i = 21; i < sessions.length; i++) {
    const item = sessions[i], prev = sessions[i - 1], broad = spyByDay.get(item.day);
    if (!broad?.previous || broad.previous.day !== prev.day) continue;
    const side = cfg.direction;
    const opening = item.bars[0], priorClose = prev.bars.at(-1)!.bidClose;
    const relGap = (opening.bidOpen / priorClose - 1) - (broad.session.bars[0].bidOpen / broad.previous.bars.at(-1)!.bidClose - 1);
    const bound = (s: Session) => side === 1 ? Math.min(...s.bars.map(b => b.bidLow)) : Math.max(...s.bars.map(b => b.bidHigh));
    const priorExtreme = bound(prev);
    const openExtreme = side === 1 ? opening.bidLow : opening.bidHigh;
    const avgOpen = sessions.slice(i - 20, i).reduce((sum, date) => sum + date.bars[0].volume, 0) / 20;
    if (cfg.confirm === 'relative-volume' && !(opening.volume > 1.30 * avgOpen && avgOpen > 0)) continue;
    for (let j = cfg.id === 'relative-gap' ? 0 : 1; j <= 7; j++) {
      const bar = item.bars[j], source = broad.session.bars[j];
      const entry = item.bars[j + 1], exit = item.bars[j + 1 + cfg.hold];
      if (!entry || !exit) break;
      if (cfg.confirm === 'SPY' && side * (source.bidClose / broad.session.bars[0].bidOpen - 1) <= 0) continue;
      const extreme = side === 1 ? bar.bidLow : bar.bidHigh;
      const level = cfg.id === 'opening-range' ? openExtreme : priorExtreme;
      const swept = side * (extreme - level) < -cfg.strength * level && side * (bar.bidClose - level) > cfg.strength * level / 2 &&
        side * (bar.bidClose - (bar.bidHigh + bar.bidLow) / 2) > 0;
      const gap = side * relGap <= -cfg.strength * 6 && side * (bar.bidClose - opening.bidOpen) > 0;
      if (!(cfg.id === 'relative-gap' ? gap : swept)) continue;
      const from = side === 1 ? entry.askOpen : entry.bidOpen;
      const to = side === 1 ? exit.bidOpen : exit.askOpen;
      // Remaining flat overnight avoids short-CFD financing. Historical short availability isn't known.
      function net(fee: number) { return side * (to / from - 1) - fee * (1 + to / from); }
      live.push({ date: item.day, symbol, base: net(side === 1 ? .0004 : .0017), stress: net(side === 1 ? .0009 : .0025) });
      break;
    }
  }
  return live;
}

function summarize(trades: Fill[], [from, to]: typeof windows[number], key: 'base' | 'stress') {
  const rows = trades.filter(row => row.date >= from && row.date < to);
  const day = new Map<string, number>();
  const bySymbol = new Map<string, number>();
  for (const row of rows) {
    day.set(row.date, (day.get(row.date) ?? 0) + row[key] / basket.length);
    bySymbol.set(row.symbol, (bySymbol.get(row.symbol) ?? 0) + row[key]);
  }
  const weeks = new Float64Array(Math.ceil((Date.parse(to) - Date.parse(from)) / 604_800_000));
  let equity = 1, peak = 1, dd = 0, total = 0;
  for (const [date, value] of [...day].sort(([a], [b]) => a.localeCompare(b))) {
    weeks[Math.floor((Date.parse(date) - Date.parse(from)) / 604_800_000)] += value;
    equity *= 1 + value; peak = Math.max(peak, equity); dd = Math.max(dd, 1 - equity / peak);
    total += value;
  }
  const avg = total / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (weeks.length - 1) / weeks.length);
  return { trades: rows.length, days: day.size, net: equity - 1, drawdown: dd, averageBps: total * basket.length / Math.max(1, rows.length) * 10_000,
    score: error > 0 ? avg / error : 0, positiveSymbols: [...bySymbol.values()].filter(value => value > 0).length };
}

let tested = 0;
const finalists = [];
for (const id of ['prior-extreme', 'opening-range', 'relative-gap'] as const) for (const direction of [1, -1] as const) {
  let selected: { cfg: Rule; rank: number; fills: Fill[] } | null = null;
  for (const hold of [2, 4, 6]) for (const confirm of ['none', 'SPY', 'relative-volume'] as const) for (const strength of [.0008, .0016]) {
    tested++;
    const cfg = { id, direction, hold, confirm, strength };
    const fills = trades(cfg);
    const early = summarize(fills, windows[0], 'base'), validation = summarize(fills, windows[1], 'stress');
    if ([early, validation].some(row => row.trades < 40 || row.days < 20 || row.net <= 0 || row.positiveSymbols < 5)) continue;
    const rank = Math.min(early.score, validation.score);
    if (rank >= 1 && (!selected || rank > selected.rank)) selected = { cfg, rank, fills };
  }
  if (selected) {
    const holdout = summarize(selected.fills, windows[2], 'base');
    const stress = summarize(selected.fills, windows[2], 'stress');
    finalists.push({ ...selected.cfg, earlierRank: selected.rank, holdout, stress,
      paper: holdout.net > 0 && stress.net > 0 && stress.trades >= 40 && stress.days >= 20 && stress.positiveSymbols >= 5 && stress.score >= 2.3 });
  }
}
const report = { venue: 'eToro paired 30-minute quotes', basket, windows, tested, finalists };
writeFileSync(join(process.cwd(), 'backtest', 'stock-price-action-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
