// Does the timeframe the stop is sized from matter?  npm run backtest:timeframes
//
// Takes the same ideas as backtest/suggestions.ts (a market's read turning long
// or short, from the hourly rules) and, for each one, places the stop and
// target four ways: from 15-minute, 1-hour, 4-hour and daily candles, using
// lib/timeframes.ts exactly as the trade ticket does. Each is then scored on
// what the price did next.
//
// A slower timeframe means a wider stop and a longer wait, so each is given a
// window to match: 2 days for 15-minute stops, 7 for hourly, 21 for 4-hour and
// 60 for daily. An idea that reaches neither stop nor target is closed at the
// end of its window.
//
// Writes lib/timeframes-evidence.json (shown in the ticket) and backtest/TIMEFRAMES.md.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate, loadBars, type Bars } from './candles';
import { WARMUP_BARS, type Bar } from '../lib/autopilot/strategies';
import { buildSuggestion } from '../lib/suggestions';
import { BARS_FOR_LEVELS, buildTimeframeLevels, TIMEFRAMES, type Timeframe } from '../lib/timeframes';
import { resolveOutcome } from '../lib/scorecard';

const COINS = ['BTC', 'ETH', 'SOL'];
const HOUR = 3_600_000, DAY = 24 * HOUR;
const WINDOW = WARMUP_BARS + 30;
const COST_PCT = 0.13;
const WINDOW_DAYS: Record<Timeframe, number> = { '15m': 2, '1h': 7, '4h': 21, '1d': 60 };
const TFS = Object.keys(TIMEFRAMES) as Timeframe[];
const PERIODS: Array<[string, string, string]> = [['2021-2022', '2021-01-01', '2023-01-01'], ['2023-2024', '2023-01-01', '2025-01-01'], ['2025 onward', '2025-01-01', '2100-01-01']];

const toBars = (b: Bars): Bar[] => b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] }));
/** Index of the last bar that has fully closed by `time`, or -1. */
function lastClosed(bars: Bar[], ms: number, time: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid].t + ms <= time) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

interface Result { tf: Timeframe; date: string; outcome: 'target' | 'stop' | 'neither'; stopPct: number; targetPct: number; pct: number; heldDays: number }

async function replay(coin: string): Promise<Result[]> {
  const h1 = await loadBars(coin, '1h'), m15 = await loadBars(coin, '15m');
  if (!h1 || !m15) throw new Error(`Missing candles for ${coin}`);
  const series: Record<Timeframe, Bar[]> = { '15m': toBars(m15), '1h': toBars(h1), '4h': toBars(aggregate(h1, 4)), '1d': toBars(aggregate(h1, 24)) };
  const hourly = series['1h'];
  const out: Result[] = [];
  let prev = 'neutral';
  // Stop early enough that even the daily window fits.
  const lastStart = hourly.length - WINDOW_DAYS['1d'] * 24 - 1;
  for (let i = WINDOW; i < lastStart; i++) {
    const s = buildSuggestion(coin, hourly.slice(i - WINDOW + 1, i + 1), hourly[i].c);
    if (s.bias !== 'neutral' && s.bias !== prev) {
      const dir = s.bias === 'long' ? 1 : -1, entry = hourly[i].c, shownAt = hourly[i].t + HOUR;
      for (const tf of TFS) {
        const bars = series[tf], ms = TIMEFRAMES[tf].ms;
        const k = lastClosed(bars, ms, shownAt);
        if (k < 100) continue;
        const lv = buildTimeframeLevels(tf, bars.slice(Math.max(0, k - BARS_FOR_LEVELS + 1), k + 1), entry)[s.bias];
        // Score on the finest candles that make sense: 15-minute for the 15-minute stops, hourly otherwise.
        const fine = tf === '15m' ? series['15m'] : hourly, fineMs = tf === '15m' ? TIMEFRAMES['15m'].ms : HOUR;
        const from = lastClosed(fine, fineMs, shownAt) + 1;
        const until = shownAt + WINDOW_DAYS[tf] * DAY;
        const after: Bar[] = [];
        for (let j = from; j < fine.length && fine[j].t + fineMs <= until; j++) after.push(fine[j]);
        if (!after.length) continue;
        const o = resolveOutcome(entry, dir, lv.stopLossPct, lv.takeProfitPct, shownAt, after);
        const outcome = o.outcome ?? 'neither';
        const exitMove = dir * (after[after.length - 1].c / entry - 1) * 100;
        out.push({
          tf, date: new Date(shownAt).toISOString().slice(0, 10), outcome, stopPct: lv.stopLossPct, targetPct: lv.takeProfitPct,
          pct: (outcome === 'target' ? lv.takeProfitPct : outcome === 'stop' ? -lv.stopLossPct : exitMove) - COST_PCT,
          heldDays: ((o.outcomeT ?? after[after.length - 1].t) + fineMs - shownAt) / DAY,
        });
      }
    }
    prev = s.bias;
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
function summarise(rows: Result[]) {
  const decided = rows.filter(r => r.outcome !== 'neither');
  return {
    ideas: rows.length,
    avgStopPct: mean(rows.map(r => r.stopPct)), avgTargetPct: mean(rows.map(r => r.targetPct)),
    hitRate: decided.length ? (decided.filter(r => r.outcome === 'target').length / decided.length) * 100 : 0,
    undecidedPct: rows.length ? ((rows.length - decided.length) / rows.length) * 100 : 0,
    /** Result per idea after costs, percent of position size. */
    avgPct: mean(rows.map(r => r.pct)),
    /** The same in multiples of the amount risked, so tight and wide stops can be compared. */
    avgR: mean(rows.map(r => r.pct / r.stopPct)),
    avgHeldDays: mean(rows.map(r => r.heldDays)),
  };
}

(async () => {
  const all = (await Promise.all(COINS.map(replay))).flat();
  const through = all.map(r => r.date).sort().at(-1)!;
  const timeframes = TFS.map(tf => {
    const rows = all.filter(r => r.tf === tf);
    const periods = PERIODS.map(([name, from, to]) => ({ name, ...summarise(rows.filter(r => r.date >= from && r.date < to)) }));
    const overall = summarise(rows);
    // "Held up" means better than break-even after costs in every period, which is a low bar.
    const positive = periods.filter(p => p.ideas >= 30 && p.avgR > 0).length, judged = periods.filter(p => p.ideas >= 30).length;
    const verdict = judged === 0 ? 'Too few ideas to judge.'
      : positive === judged ? `Positive after costs in all ${judged} periods (${overall.avgR >= 0 ? '+' : ''}${overall.avgR.toFixed(2)}R per idea overall). One configuration on three coins that move together: treat it as a lead, not proof.`
      : positive === 0 ? `Lost money after costs in all ${judged} periods (${overall.avgR.toFixed(2)}R per idea overall).`
      : `No consistent result: positive after costs in ${positive} of ${judged} periods (${overall.avgR >= 0 ? '+' : ''}${overall.avgR.toFixed(2)}R per idea overall). That is not an edge.`;
    return { timeframe: tf, label: TIMEFRAMES[tf].label, windowDays: WINDOW_DAYS[tf], overall, periods, verdict };
  });
  const out = { generatedThrough: through, coins: COINS, costPct: COST_PCT, timeframes };
  writeFileSync(join(process.cwd(), 'lib', 'timeframes-evidence.json'), JSON.stringify(out, null, 2) + '\n');

  const sign = (x: number, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
  writeFileSync(join(process.cwd(), 'backtest', 'TIMEFRAMES.md'), `# Stop and target by timeframe (historical replay)

Generated by \`npm run backtest:timeframes\` from ${COINS.join(', ')} candles, ideas through ${through}. Do not edit by hand.

The entries are the same for every row: each time the hourly rules' read on a market turned long or short. What differs
is which candles the stop and target were sized from, using the code the trade ticket uses. Results are after ${COST_PCT}%
round-trip costs. "R" is the result as a multiple of the amount risked, which is the fair way to compare a tight stop
with a wide one. When one candle touches both stop and target it counts as the stop.

| Stop sized from | Window | Ideas | Avg stop | Avg target | Reached target first | Reached neither | Avg held | Avg result | Avg result (R) |
|---|---|---|---|---|---|---|---|---|---|
${timeframes.map(t => `| ${t.label} candles | ${t.windowDays} days | ${t.overall.ideas} | ${t.overall.avgStopPct.toFixed(1)}% | ${t.overall.avgTargetPct.toFixed(1)}% | ${t.overall.hitRate.toFixed(0)}% | ${t.overall.undecidedPct.toFixed(0)}% | ${t.overall.avgHeldDays.toFixed(1)} days | ${sign(t.overall.avgPct)}% | ${sign(t.overall.avgR)}R |`).join('\n')}

## By period

${timeframes.map(t => `### ${t.label} candles\n\n**${t.verdict}**\n\n| Period | Ideas | Reached target first | Avg result | Avg result (R) |\n|---|---|---|---|---|\n${t.periods.map(p => `| ${p.name} | ${p.ideas} | ${p.hitRate.toFixed(0)}% | ${sign(p.avgPct)}% | ${sign(p.avgR)}R |`).join('\n')}\n`).join('\n')}
## What this does and does not show

- Four variants were tested, one per timeframe, exactly as they ship. Nothing was tuned on these results.
- The entries come from the hourly rules, whose choice of which rules count has already seen this data, so the direction
  is not an independent test. The comparison between timeframes is fair: all four use identical entries.
- With four variants and three coins that move together, one of them coming out ahead by chance would not be surprising.
- The 15-minute row is scored on 15-minute candles; the others on hourly candles.
- This is a record of the past, not a forecast.
`);
  for (const t of timeframes) console.log(t.label, t.overall.ideas, 'stop', t.overall.avgStopPct.toFixed(1), 'hit', t.overall.hitRate.toFixed(0), 'avg%', t.overall.avgPct.toFixed(2), 'R', t.overall.avgR.toFixed(3), '|', t.periods.map(p => p.avgR.toFixed(3)).join(' '), '|', t.verdict);
})().catch(e => { console.error(e); process.exit(1); });
