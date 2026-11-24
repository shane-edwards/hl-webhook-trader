import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { marketDataClient } from '../lib/hyperliquid/from-settings';
import { DAY, DATA_END, HOUR, loadPerps, MAJORS, perpFunding } from './price-action-data';

const FROM = Date.UTC(2026, 5, 1);
const TO = DATA_END;
const LOOKBACK = 14 * DAY;
const COLLATERAL = 3;
const client = marketDataClient();

async function read(symbol: string) {
  const start = FROM - LOOKBACK;
  const [hl, hlFunding, bnFunding] = await Promise.all([
    client.getCandles(symbol, '1h', start, TO), client.getFundingRates(symbol, start, TO), perpFunding(symbol),
  ]);
  const expected = (TO - start) / HOUR;
  const binance = new Map(loadPerps(symbol, HOUR).map(row => [row.t, row.o]));
  const swaps = new Map(hl.map(row => [row.t, row.o]));
  const timeKey = (time: number) => Math.round(time / HOUR) * HOUR;
  const rateA = new Map(hlFunding.map(({ time, rate }) => [timeKey(time), rate]));
  const rateB = new Map(bnFunding.map(({ time, rate }) => [timeKey(time), rate]));
  const records = [];
  for (let t = start; t < TO; t += HOUR) {
    const a = swaps.get(t), b = binance.get(t), fundingA = rateA.get(t);
    if (a && b && fundingA != null) records.push({ t, a, b, exists: true, fundingA, fundingB: rateB.get(t) ?? 0 });
    else records.push({ t, a: 0, b: 0, exists: false, fundingA: 0, fundingB: 0 });
  }
  if (records.filter(row => row.exists).length < .995 * expected) throw new Error(`Incomplete cross-venue prices and funding for ${symbol}`);
  return records;
}

function simulate(rows: Awaited<ReturnType<typeof read>>, fee: number, window: { from: number; to: number }) {
  let spread = 0, invalid = 0, entries = 0, peak = 1, equity = 1, drawdown = 0;
  let trade: { dir: number; a: number; b: number; units: number; funding: number } | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const drop = rows[i - 14 * 24];
    if (row.t >= window.to) break;
    if (row.t >= window.from && row.exists) {
      if (trade) {
        trade.funding += trade.units * trade.dir * (row.fundingA * row.a - row.fundingB * row.b);
        const price = trade.units * trade.dir * (trade.a - row.a + row.b - trade.b);
        const liquidationValue = equity + price + trade.funding - trade.units * (row.a + row.b) * fee;
        peak = Math.max(peak, liquidationValue);
        drawdown = Math.max(drawdown, 1 - liquidationValue / peak);
        const reset = [row.a / trade.a, row.b / trade.b].some(value => value > 1.60 || value < .60);
        if (reset || row.t + HOUR >= window.to || row.t % DAY === 0 && trade.dir * spread <= .0003) {
          equity = liquidationValue;
          trade = null;
        }
      } else if (row.t % DAY === 0 && row.t + DAY < window.to && invalid === 0 && Math.abs(spread) >= .0027 &&
        Math.abs(row.a / row.b - 1) <= .003) {
        const units = equity / (COLLATERAL * Math.max(row.a, row.b));
        equity -= units * (row.a + row.b) * fee;
        trade = { dir: Math.sign(spread), a: row.a, b: row.b, units, funding: 0 };
        entries++;
      }
    }
    spread += row.fundingA - row.fundingB - ((drop?.fundingA ?? 0) - (drop?.fundingB ?? 0));
    invalid += Number(!row.exists) - Number(!!drop && !drop.exists);
    if (!row.exists && trade) throw new Error('An open hedge crossed missing market data');
  }
  if (trade) throw new Error('A cross-venue hedge could not be marked at its deadline');
  return { net: equity - 1, drawdown, entries };
}

async function main() {
  const windows = [{ from: FROM, to: Date.UTC(2026, 7, 1) }, { from: Date.UTC(2026, 7, 1), to: TO }];
  const markets = [];
  for (const coin of MAJORS) {
    try {
      const rows = await read(coin);
      markets.push({ coin, studies: windows.map(window => ({
        ...Object.fromEntries(Object.entries(window).map(([key, date]) => [key, new Date(date).toISOString().slice(0, 10)])),
        base: simulate(rows, .0009, window), stress: simulate(rows, .0018, window),
      })) });
    } catch (error) { markets.push({ coin, issue: error instanceof Error ? error.message : 'Market history is unavailable' }); }
  }
  const report = { venues: ['Hyperliquid USD perpetuals', 'Binance USDT perpetuals'], collateralPerLeg: COLLATERAL / 2, markets };
  writeFileSync(join(process.cwd(), 'backtest', 'funding-spread-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
