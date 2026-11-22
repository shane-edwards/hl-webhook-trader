// Scorecard for the trade ideas, run over history:  npm run backtest:suggestions
//
// Replays lib/suggestions.ts (the same code the dashboard uses) hour by hour
// over cached hourly candles. An idea is logged the way the live scorecard
// logs it: when a market's read turns long or short. Each idea is then scored:
// did price reach the suggested target or the stop first, and what was the
// return after 1, 3 and 7 days.
//
// It also answers one specific question: do stops placed beyond a support or
// resistance level do better than stops sized from volatility alone? For every
// idea whose stop came from a level, the volatility-only stop that would
// otherwise have been used is scored on the same entry.
//
// Writes lib/suggestions-evidence.json (shown in the app) and backtest/SUGGESTIONS.md.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadBars } from './candles';
import { WARMUP_BARS, type Bar } from '../lib/autopilot/strategies';
import { buildSuggestion, TARGET_R } from '../lib/suggestions';
import { buildScorecard, resolveOutcome, type ScoredIdea, type ScoreRow } from '../lib/scorecard';

const COINS = ['BTC', 'ETH', 'SOL'];
const HOUR = 3_600_000;
const WINDOW = WARMUP_BARS + 30; // what the live scan loads
const WEEK_BARS = 7 * 24;
/** Round-trip cost charged to every idea, percent: two taker fills (0.045% each) plus slippage (0.02% each). */
const COST_PCT = 0.13;
const PERIODS: Array<[string, string, string]> = [['2021-2022', '2021-01-01', '2023-01-01'], ['2023-2024', '2023-01-01', '2025-01-01'], ['2025 onward', '2025-01-01', '2100-01-01']];

interface Idea extends ScoredIdea {
  symbol: string; date: string;
  /** Result in percent after costs: +target, -stop, or the 7-day return when neither was reached. */
  pct: number;
  /** The same entry scored with the volatility-only stop and a TARGET_R target. */
  alt: { outcome: 'target' | 'stop' | 'neither'; pct: number; stopPct: number; targetPct: number };
}

function score(entry: number, dir: 1 | -1, stopPct: number, targetPct: number, t: number, after: Bar[]) {
  const o = resolveOutcome(entry, dir, stopPct, targetPct, t, after);
  const outcome = o.outcome ?? 'neither';
  const pct = (outcome === 'target' ? targetPct : outcome === 'stop' ? -stopPct : o.ret7d ?? 0) - COST_PCT;
  return { o, outcome, pct } as const;
}

async function replay(coin: string): Promise<Idea[]> {
  const b = await loadBars(coin, '1h');
  if (!b) throw new Error(`No hourly data for ${coin}`);
  const bars: Bar[] = b.t.map((t, i) => ({ t, o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i], v: b.v[i] }));
  const ideas: Idea[] = [];
  let prev = 'neutral';
  for (let i = WINDOW; i < bars.length - WEEK_BARS; i++) {
    const s = buildSuggestion(coin, bars.slice(i - WINDOW + 1, i + 1), bars[i].c);
    if (s.bias !== 'neutral' && s.bias !== prev) {
      const lv = s[s.bias], dir = s.bias === 'long' ? 1 : -1;
      const shownAt = bars[i].t + HOUR, after = bars.slice(i + 1, i + 1 + WEEK_BARS);
      const main = score(bars[i].c, dir, lv.stopLossPct, lv.takeProfitPct, shownAt, after);
      const altStop = lv.volStopPct, altTarget = Math.round(altStop * TARGET_R * 10) / 10;
      const alt = score(bars[i].c, dir, altStop, altTarget, shownAt, after);
      ideas.push({
        symbol: coin, date: new Date(shownAt).toISOString().slice(0, 10),
        bias: s.bias, strength: s.strength, stopKind: lv.stopKind, stopPct: lv.stopLossPct, targetPct: lv.takeProfitPct,
        outcome: main.outcome, ret1d: main.o.ret1d, ret3d: main.o.ret3d, ret7d: main.o.ret7d, pct: main.pct,
        alt: { outcome: alt.outcome, pct: alt.pct, stopPct: altStop, targetPct: altTarget },
      });
    }
    prev = s.bias;
  }
  return ideas;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : 0);
const hit = (xs: Array<{ outcome: string | null }>) => { const d = xs.filter(x => x.outcome === 'target' || x.outcome === 'stop'); return d.length ? (d.filter(x => x.outcome === 'target').length / d.length) * 100 : 0; };

function paired(ideas: Idea[]) {
  const withLevel = ideas.filter(i => i.stopKind === 'level');
  return {
    ideas: withLevel.length,
    level: { hitRate: hit(withLevel), avgPct: mean(withLevel.map(i => i.pct)), avgStopPct: mean(withLevel.map(i => i.stopPct)) },
    volatility: { hitRate: hit(withLevel.map(i => i.alt)), avgPct: mean(withLevel.map(i => i.alt.pct)), avgStopPct: mean(withLevel.map(i => i.alt.stopPct)) },
  };
}

(async () => {
  const all = (await Promise.all(COINS.map(replay))).flat();
  const through = all.map(i => i.date).sort().at(-1)!;
  const periods = PERIODS.map(([name, from, to]) => {
    const ideas = all.filter(i => i.date >= from && i.date < to);
    return { name, ideas: ideas.length, avgPct: mean(ideas.map(i => i.pct)), rows: buildScorecard(ideas) as ScoreRow[], paired: paired(ideas) };
  });
  const pooled = paired(all);
  const better = periods.filter(p => p.paired.ideas >= 20 && p.paired.level.avgPct > p.paired.volatility.avgPct).length;
  const judged = periods.filter(p => p.paired.ideas >= 20).length;
  const diff = pooled.level.avgPct - pooled.volatility.avgPct;
  const verdict =
    judged === 0 ? 'There were too few ideas with a level-based stop to compare the two.'
    : better === judged && diff > 0 ? `Level-based stops did better than volatility-only stops in all ${judged} periods (${diff.toFixed(2)} percentage points per idea, after costs, on the same entries).`
    : better === 0 && diff < 0 ? `Level-based stops did not beat volatility-only stops. They were slightly worse in all ${judged} periods, by ${Math.abs(diff).toFixed(2)} percentage points per idea after costs on the same entries. The gap is small, but there is no evidence here that placing the stop beyond a level helps.`
    : `No consistent difference: level-based stops beat volatility-only stops in ${better} of ${judged} periods, and by ${diff.toFixed(2)} percentage points per idea overall. That is not evidence that either is better.`;
  const overall = mean(all.map(i => i.pct));
  const recent = periods[periods.length - 1];
  const signed = (x: number) => { const r = Math.round(x * 100) / 100; return `${r > 0 ? '+' : ''}${r === 0 ? '0.00' : r.toFixed(2)}%`; };
  const edge = `Across all ${all.length} ideas the average result was ${signed(overall)} per idea after costs, which is no edge; in ${recent.name} it was ${signed(recent.avgPct)} over ${recent.ideas} ideas.`;

  const out = { generatedThrough: through, coins: COINS, costPct: COST_PCT, ideas: all.length, verdict, edge, pooled, periods };
  writeFileSync(join(process.cwd(), 'lib', 'suggestions-evidence.json'), JSON.stringify(out, null, 2) + '\n');

  const f = (x: number | null, d = 1) => (x == null ? 'n/a' : x.toFixed(d));
  const sign = (x: number | null) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
  const table = (rows: ScoreRow[]) => ['| Group | Ideas | Target or stop reached | Reached target first | Avg result (R) | After 1 day | After 3 days | After 7 days |', '|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.group} | ${r.ideas} | ${r.decided} | ${f(r.hitRate, 0)}% | ${f(r.avgR, 2)} | ${sign(r.avgRet1d)} | ${sign(r.avgRet3d)} | ${sign(r.avgRet7d)} |`)].join('\n');
  writeFileSync(join(process.cwd(), 'backtest', 'SUGGESTIONS.md'), `# Trade idea scorecard (historical replay)

Generated by \`npm run backtest:suggestions\` from hourly ${COINS.join(', ')} candles, ideas through ${through}. Do not edit by hand.

An idea is counted each time a market's read turns long or short, as the live scorecard counts them. Entry is the
close of the hour that produced it. "R" is the result in multiples of the amount risked, before costs: reaching the
target pays target / stop, reaching the stop costs 1. The per-idea percentages after costs charge ${COST_PCT}% per round trip.
When one hourly bar touches both the stop and the target it is counted as the stop.

## Result

**${edge}**

**Stops: ${verdict}**

${periods.map(p => `### ${p.name}\n\n${p.ideas} ideas, average ${sign(p.avgPct)} per idea after costs.\n\n${table(p.rows)}\n\nSame entries, both kinds of stop (${p.paired.ideas} ideas where a level was available):\n\n| Stop | Avg stop distance | Reached target first | Avg result per idea after costs |\n|---|---|---|---|\n| Beyond the level | ${f(p.paired.level.avgStopPct)}% | ${f(p.paired.level.hitRate, 0)}% | ${sign(p.paired.level.avgPct)} |\n| Volatility only, ${TARGET_R}R target | ${f(p.paired.volatility.avgStopPct)}% | ${f(p.paired.volatility.hitRate, 0)}% | ${sign(p.paired.volatility.avgPct)} |\n`).join('\n')}
## What this does and does not show

- One configuration was tested: the suggestion rules exactly as they ship. Nothing was tuned on these results.
- It is not an independent test of the direction read. Which rules count toward the read was decided from backtests that
  already covered these years (lib/autopilot/evidence.json), so the read has seen this data. The stop comparison has no
  such problem: both stops are scored on identical entries.
- Three coins that move together are not three independent samples.
- A hit rate is not a profit. A 2R target needs to be reached more than a third of the time just to break even before costs.
- This is a record of the past, not a forecast.
`);
  console.log(edge); console.log(verdict);
  for (const p of periods) console.log(p.name, p.ideas, 'avg', p.avgPct.toFixed(2), 'paired', p.paired.ideas, p.paired.level.avgPct.toFixed(2), p.paired.volatility.avgPct.toFixed(2));
})().catch(e => { console.error(e); process.exit(1); });
