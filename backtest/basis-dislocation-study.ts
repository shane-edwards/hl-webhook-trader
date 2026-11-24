import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAJORS, HOUR, DAY, DATA_END, loadPerps, perpFunding, spotHourly } from './price-action-data';
import type { Bar } from '../lib/autopilot/strategies';

type Window = { from: number; to: number };
const windows = [{ from: Date.UTC(2024, 2, 1), to: Date.UTC(2025, 0, 1) },
  { from: Date.UTC(2025, 0, 1), to: Date.UTC(2026, 0, 1) }, { from: Date.UTC(2026, 0, 1), to: DATA_END }];
const candidates = [24, 72, 168].flatMap(lookback => [.0025, .004, .006].flatMap(premium =>
  [12, 48, 120].map(hold => ({ lookback, premium, hold }))));
type Candidate = typeof candidates[number];
type BarPair = { t: number; spot: Bar; perp: Bar; premium: number; rate: number };

function pairs(spot: Bar[], perp: Bar[], funding: Map<number, number>) {
  const swap = new Map(perp.map(row => [row.t, row]));
  const aligned = spot.flatMap(bar => {
    const other = swap.get(bar.t);
    return other ? [{ t: bar.t, spot: bar, perp: other, premium: other.c / bar.c - 1, rate: funding.get(bar.t) ?? 0 }] : [];
  });
  if (aligned.length < .995 * spot.length) throw new Error('Missing paired spot/perpetual prices');
  return aligned;
}

function replay(rows: BarPair[], rule: Candidate, window: Window, fee: number) {
  let equity = 1, trade = 0, wins = 0, blockedUntil = 0, worst = 0;
  const weekly = new Map<number, number>();
  for (let i = rule.lookback; i < rows.length - rule.hold - 2; i++) {
    const signal = rows[i];
    if (signal.t < window.from || signal.t < blockedUntil) continue;
    const next = rows[i + 1];
    if (next.t + HOUR * rule.hold >= window.to) break;
    if (next.t - signal.t !== HOUR || signal.premium < rule.premium) continue;
    const baseline = rows.slice(i - rule.lookback, i).reduce((sum, row) => sum + row.premium, 0) / rule.lookback;
    if (signal.premium - baseline < rule.premium || next.perp.o / next.spot.o - 1 < rule.premium / 2) continue;
    let earned = 0;
    const entry = next.spot.o + next.perp.o;
    const budget = 2.5 * Math.max(next.spot.o, next.perp.o);
    for (let j = i + 2; j <= i + rule.hold + 1; j++) {
      const previous = rows[j - 1], row = rows[j];
      earned += row.rate * row.perp.o;
      const widened = previous.premium >= signal.premium + .015;
      const mark = row.spot.o - next.spot.o - (row.perp.o - next.perp.o) + earned;
      const exitCharges = (entry + row.spot.o + row.perp.o) * fee;
      const net = (mark - exitCharges) / budget;
      worst = Math.min(worst, net);
      if (j === i + rule.hold + 1 || previous.premium <= baseline + .0005 || widened || row.t - previous.t !== HOUR) {
        const bucket = Math.floor((row.t - window.from) / (7 * DAY));
        weekly.set(bucket, (weekly.get(bucket) ?? 0) + net);
        equity *= 1 + net;
        trade++;
        if (net > 0) wins++;
        blockedUntil = row.t;
        break;
      }
    }
  }
  return { trades: trade, wins, net: equity - 1, worstTradeMark: worst, positiveWeeks: [...weekly.values()].filter(value => value > 0).length };
}

async function main() {
  const input = await Promise.all(MAJORS.map(async coin => pairs(await spotHourly(coin), loadPerps(coin, HOUR),
    new Map((await perpFunding(coin)).map(row => [row.time, row.rate])))));
  const score = (rule: Candidate, window: Window, fee: number) => {
    const byMarket = input.map((rows, i) => ({ coin: MAJORS[i], ...replay(rows, rule, window, fee) }));
    return { byMarket, trades: byMarket.reduce((sum, row) => sum + row.trades, 0),
      net: byMarket.reduce((sum, row) => sum + row.net, 0) / byMarket.length };
  };
  const pre = candidates.map(rule => ({ rule, discovery: score(rule, windows[0], .0009), validation: score(rule, windows[1], .0018) }));
  const min = (row: typeof pre[number]) => Math.min(row.discovery.net, row.validation.net);
  const selected = pre.filter(row => min(row) > 0 && [row.discovery, row.validation].every(w =>
    w.trades >= 18 && w.byMarket.filter(asset => asset.trades >= 4 && asset.net > 0).length >= 2)).sort((a, b) => min(b) - min(a))[0];
  const final = selected ? { base: score(selected.rule, windows[2], .0009), stress: score(selected.rule, windows[2], .0018) } : null;
  const activity = pre.sort((a, b) => Math.min(b.discovery.trades, b.validation.trades) - Math.min(a.discovery.trades, a.validation.trades))[0];
  const report = { source: 'Matched Binance spot/perpetual hourly candles and actual funding', tested: candidates.length,
    windows: windows.map(({ from, to }) => ({ from: new Date(from).toISOString(), to: new Date(to).toISOString() })),
    mostActive: activity, selected: selected ?? null, final };
  writeFileSync(join(process.cwd(), 'backtest', 'basis-dislocation-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ tested: report.tested, selected: selected?.rule ?? null, final, mostActive: [activity.discovery.trades, activity.discovery.net,
    activity.validation.trades, activity.validation.net] }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
