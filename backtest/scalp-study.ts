import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadScalpCandles } from '@/lib/hyperliquid/scalp-candles';
import { replayScalp, scalpCoverage, SCALP_INTERVALS, SCALP_MARKETS, SCALP_RULES, summarizeScalps, type ScalpBar, type ScalpInterval, type ScalpMarket } from '@/lib/scalp-study';
import { aggregate } from './candles';

const DIR = join(process.cwd(), 'backtest', 'data', 'intraday', 'scalp-perps');
const periods = [
  { label: '2024 screen', from: '2024-01-01', to: '2025-01-01' },
  { label: '2025 validation', from: '2025-01-01', to: '2026-01-01' },
  { label: '2026 holdout', from: '2026-01-01', to: '2026-11-01' },
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const intervals = Object.keys(SCALP_INTERVALS) as ScalpInterval[];

function historical(coin: ScalpMarket): ScalpBar[] {
  const files = readdirSync(DIR).filter(name => name.startsWith(`${coin}USDT-5m-`) && name.endsWith('.csv')).sort();
  return files.flatMap(file => readFileSync(join(DIR, file), 'utf8').trim().split('\n').map(line => {
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    return { t, o, h, l, c, v };
  }));
}

function resample(bars: ScalpBar[]): ScalpBar[] {
  const output = aggregate({
    t: bars.map(b => b.t), o: bars.map(b => b.o), h: bars.map(b => b.h), l: bars.map(b => b.l),
    c: bars.map(b => b.c), v: bars.map(b => b.v), ms: SCALP_INTERVALS['5m'],
  }, 3);
  return output.t.map((t, i) => ({ t, o: output.o[i], h: output.h[i], l: output.l[i], c: output.c[i], v: output.v[i] }));
}

async function main() {
  const dataset = SCALP_MARKETS.map(historical);
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  const results = [];
  for (const interval of intervals) {
    const ms = SCALP_INTERVALS[interval];
    const history = interval === '5m' ? dataset : dataset.map(resample);
    const native = await Promise.all(SCALP_MARKETS.map(coin => loadScalpCandles(coin, interval, now)));
    if (native.some(bars => bars.length < 1000)) throw new Error(`Insufficient Hyperliquid ${interval} candle history`);
    // The common interval avoids comparing different market days for each coin.
    const nativeFrom = Math.max(Date.parse(periods.at(-1)!.to), ...native.map(bars => bars[0].t + 4 * HOUR));
    const nativeTo = Math.min(now, ...native.map(bars => bars.at(-1)!.t + ms));
    if (nativeTo < now - ms) throw new Error(`Stale Hyperliquid ${interval} candle history`);
    if (nativeTo - nativeFrom < 7 * DAY) throw new Error(`Less than a week of Hyperliquid ${interval} after the historical holdout`);
    const nativeQuality = Math.min(...native.map(bars => scalpCoverage(bars, interval, nativeFrom, nativeTo)));
    for (const rule of SCALP_RULES) {
      const slices = periods.map(period => {
        const from = Date.parse(period.from), to = Date.parse(period.to);
        const quality = Math.min(...history.map(bars => scalpCoverage(bars, interval, from, to)));
        if (quality < 0.995) throw new Error(`Incomplete ${interval} data for ${period.label}: ${quality}`);
        const byMarket = history.map(bars => replayScalp(bars, interval, rule.id, from, to));
        return { ...period, coverage: quality, ...summarizeScalps(byMarket) };
      });
      const nativeTrades = native.map(bars => replayScalp(bars, interval, rule.id, nativeFrom, nativeTo));
      const recent = {
        from: new Date(nativeFrom).toISOString(), to: new Date(nativeTo).toISOString(), coverage: nativeQuality,
        ...summarizeScalps(nativeTrades), markets: SCALP_MARKETS.map((coin, i) => ({ coin, ...summarizeScalps([nativeTrades[i]]) })),
      };
      const passes = (s: ReturnType<typeof summarizeScalps>, minTrades: number) =>
        s.trades >= minTrades && (s.netBps ?? 0) >= 3 && (s.stressBps ?? 0) > 0 && s.positiveMarkets >= 2 && s.positiveDays > s.activeDays / 2;
      const paperCandidate = slices.every(s => passes(s, 100)) && recent.coverage >= 0.995 && passes(recent, 30);
      results.push({ id: rule.id, interval, slices, recent, paperCandidate });
    }
  }
  const report = { generatedAt: new Date(now).toISOString(), results };
  writeFileSync(join(process.cwd(), 'lib', 'scalp-study-evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.table(results.map(row => ({ rule: row.id, bars: row.interval, screen: row.slices[0].netBps?.toFixed(2), validation: row.slices[1].netBps?.toFixed(2), holdout: row.slices[2].netBps?.toFixed(2), hyperliquid: row.recent.netBps?.toFixed(2), stress: row.recent.stressBps?.toFixed(2), paperCandidate: row.paperCandidate })));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
