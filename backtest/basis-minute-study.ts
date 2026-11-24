import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { archiveRows, candle, perpFunding } from './price-action-data';

const MINUTE = 60_000;
const folder = join(process.cwd(), 'backtest', 'data', 'intraday', 'basis-minute');
const months = ['05', '06', '07', '08', '09', '10'].map(month => `2026-${month}`);
const windows = [{ from: Date.UTC(2026, 4, 1), to: Date.UTC(2026, 6, 1) }, { from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 8, 1) },
  { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 10, 1) }];
const variants = [.0025, .004, .006].flatMap(threshold => [5, 15, 60].map(hold => ({ threshold, hold })));
type Tick = { time: number; spot: number; swap: number; basis: number; funding: number };

async function monthly(coin: string, month: string, venue: 'spot' | 'futures/um') {
  const symbol = `${coin}USDT`, name = `${symbol}-1m-${month}`;
  const url = `https://data.binance.vision/data/${venue}/monthly/klines/${symbol}/1m/${name}.zip`;
  return (await archiveRows(join(folder, venue), name, url)).flatMap(row => candle(row) ?? []);
}

async function feed(coin: string) {
  const funding = new Map((await perpFunding(coin)).map(event => [event.time, event.rate]));
  const output: Tick[] = [];
  for (const month of months) {
    const [spot, perp] = await Promise.all([monthly(coin, month, 'spot'), monthly(coin, month, 'futures/um')]);
    const match = new Map(perp.map(bar => [bar.t, bar]));
    for (const base of spot) {
      const swap = match.get(base.t);
      if (!swap) continue;
      output.push({ time: base.t, spot: base.o, swap: swap.o, basis: swap.c / base.c - 1, funding: funding.get(base.t) ?? 0 });
    }
  }
  const expected = (windows[2].to - windows[0].from) / MINUTE;
  if (output.length < .995 * expected || output.some((row, index) => index > 0 && row.time <= output[index - 1].time)) throw new Error(`Incomplete minute data for ${coin}`);
  return output;
}

function replay(rows: Tick[], threshold: number, hold: number, window: { from: number; to: number }, cost: number) {
  let setups = 0, missed = 0, trades = 0, wins = 0, capital = 1;
  const fills = [];
  for (let i = 0; i < rows.length - hold - 2; i++) {
    const before = rows[i], entry = rows[i + 1];
    if (before.time < window.from || before.basis < threshold) continue;
    if (entry.time + MINUTE * hold >= window.to) break;
    setups++;
    if (entry.time - before.time !== MINUTE || entry.swap / entry.spot - 1 < threshold * .80) { missed++; continue; }
    let earned = 0;
    for (let j = i + 2; j <= i + hold + 1; j++) {
      const last = rows[j - 1], end = rows[j];
      earned += end.funding * end.swap;
      if (j === i + hold + 1 || last.basis <= .0005 || last.basis >= before.basis + .006 || end.time - last.time !== MINUTE) {
        const net = (end.spot - entry.spot + entry.swap - end.swap + earned - cost * (entry.swap + entry.spot + end.swap + end.spot)) /
          (2.5 * Math.max(entry.spot, entry.swap));
        capital *= 1 + net;
        trades++;
        wins += Number(net > 0);
        fills.push({ entry: new Date(entry.time).toISOString(), exit: new Date(end.time).toISOString(),
          entryBasis: entry.swap / entry.spot - 1, exitBasis: end.swap / end.spot - 1, net });
        i = j;
        break;
      }
    }
  }
  return { setups, missed, trades, wins, net: capital - 1, fills };
}

async function main() {
  const coins = ['BTC', 'ETH'];
  const inputs = await Promise.all(coins.map(feed));
  const run = (rule: typeof variants[number], period: number, fee: number) => inputs.map((market, i) => ({
    coin: coins[i], ...replay(market, rule.threshold, rule.hold, windows[period], fee),
  }));
  const early = variants.map(rule => ({ rule, discovery: run(rule, 0, .0009), validation: run(rule, 1, .0018) }));
  const enough = (results: ReturnType<typeof run>) => results.every(row => row.trades >= 6 && row.net > 0);
  const rank = (row: typeof early[number]) => Math.min(...[...row.discovery, ...row.validation].map(x => x.net));
  const selected = early.filter(row => enough(row.discovery) && enough(row.validation)).sort((a, b) => rank(b) - rank(a))[0];
  const final = selected ? run(selected.rule, 2, .0018) : null;
  const activity = early[0];
  const report = { venue: 'Binance matched spot and perpetuals', timeframe: '1m', bars: inputs.map(rows => rows.length),
    windows: windows.map(({ from, to }) => [new Date(from).toISOString(), new Date(to).toISOString()]), tested: variants.length,
    selected: selected ?? null, final, lowestThresholdDiagnostic: activity };
  writeFileSync(join(process.cwd(), 'backtest', 'basis-minute-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
