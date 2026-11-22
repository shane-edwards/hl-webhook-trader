import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOpenPosition, checkRisk, DEFAULT_RISK, sizeNotional } from '../lib/autopilot/risk';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from '../lib/autopilot/strategies';
import { isLiveEligible, runAutopilot, type AutopilotConfig } from '../lib/autopilot/run';
import type { HyperliquidClient } from '../lib/hyperliquid/client';

const HOUR = 3_600_000;

test('risk: position size loses exactly the risk budget at the stop, capped by leverage', () => {
  // 0.5% of 10,000 = $50 at risk; a 2% stop means a $2,500 position.
  assert.equal(sizeNotional(10_000, 0.02, DEFAULT_RISK), 2_500);
  // A very tight stop would imply a huge position: capped at 2x equity.
  assert.equal(sizeNotional(10_000, 0.001, DEFAULT_RISK), 20_000);
  assert.equal(sizeNotional(0, 0.02, DEFAULT_RISK), 0);
  assert.equal(canOpenPosition(3, 500, DEFAULT_RISK).ok, false);
  assert.equal(canOpenPosition(0, 5, DEFAULT_RISK).ok, false);
  assert.equal(canOpenPosition(2, 500, DEFAULT_RISK).ok, true);
});

test('risk: daily loss limit blocks entries for the day; drawdown breaker stays tripped', () => {
  const t0 = Date.UTC(2026, 0, 10, 1);
  const a = checkRisk(null, 10_000, t0, DEFAULT_RISK);
  assert.equal(a.canOpen, true);
  const b = checkRisk(a.state, 9_650, t0 + HOUR, DEFAULT_RISK); // -3.5% today
  assert.equal(b.canOpen, false);
  assert.match(b.reason!, /Daily loss/);
  const c = checkRisk(b.state, 9_650, t0 + 24 * HOUR, DEFAULT_RISK); // next day: day figure resets
  assert.equal(c.canOpen, true);
  const d = checkRisk(c.state, 8_400, t0 + 48 * HOUR, DEFAULT_RISK); // 16% below the 10,000 peak
  assert.equal(d.canOpen, false);
  assert.ok(d.state.haltedReason);
  const e = checkRisk(d.state, 9_900, t0 + 72 * HOUR, DEFAULT_RISK); // recovery does not un-pause it
  assert.equal(e.canOpen, false);
});

test('only strategies that passed the backtest gate may trade live', () => {
  assert.equal(isLiveEligible('trend_breakout', false), true);
  assert.equal(isLiveEligible('momentum_burst', false), false);
  assert.equal(isLiveEligible('momentum_burst', true), false);
  assert.equal(isLiveEligible('nonexistent', false), false);
});

// ---- a tiny in-memory stand-in for the database ----
type Row = Record<string, unknown>;
function fakeDb() {
  const tables: Record<string, Row[]> = { autopilot_state: [], autopilot_positions: [], autopilot_events: [], trades: [] };
  let seq = 0;
  const from = (name: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: 'select' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    let inserted: Row[] | null = null;
    const match = () => tables[name].filter(r => filters.every(([k, v]) => r[k] === v));
    const exec = () => {
      if (inserted) return { data: inserted, error: null };
      const rows = match();
      if (op === 'update') rows.forEach(r => Object.assign(r, patch));
      if (op === 'delete') tables[name] = tables[name].filter(r => !rows.includes(r));
      return { data: rows, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
      update: (p: Row) => { op = 'update'; patch = p; return q; },
      delete: () => { op = 'delete'; return q; },
      insert: (rows: Row | Row[]) => {
        const list: Row[] = (Array.isArray(rows) ? rows : [rows]).map(r => ({ id: `id${++seq}`, ...r }));
        if (name === 'autopilot_positions') {
          for (const r of list) {
            if (tables[name].some(x => x.symbol === r.symbol && x.strategy_id === r.strategy_id && x.entry_bar_t === r.entry_bar_t && x.mode === r.mode)) {
              inserted = []; return { ...q, select: () => q, single: async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }), then: (f: (v: unknown) => unknown) => f({ data: null, error: { code: '23505' } }) };
            }
          }
        }
        tables[name].push(...list); inserted = list; return q;
      },
      upsert: (r: Row) => {
        const i = tables[name].findIndex(x => x.user_id === r.user_id && x.mode === r.mode);
        if (i >= 0) Object.assign(tables[name][i], r); else tables[name].push(r);
        return Promise.resolve({ data: null, error: null });
      },
      single: async () => { const r = exec(); return { data: r.data[0] ?? null, error: null }; },
      maybeSingle: async () => { const r = exec(); return { data: r.data[0] ?? null, error: null }; },
      then: (f: (v: unknown) => unknown) => f(exec()),
    };
    return q;
  };
  return { db: { from } as never, tables };
}

/** Hourly bars: a long steady uptrend ending in either a breakout bar or a down bar, one hour before `now`. */
function uptrend(now: number, n: number, breakout: boolean): Bar[] {
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const o = px;
    // Mostly flat drift with small wiggles so the 48h high sits just above price.
    const c = last ? o * (breakout ? 1.03 : 0.99) : o * (1 + 0.0003 + (i % 2 ? 0.001 : -0.001));
    bars.push({ t: now - (n - i) * HOUR, o, h: Math.max(o, c) * 1.0005, l: Math.min(o, c) * 0.9995, c });
    px = c;
  }
  return bars;
}

const cfg: AutopilotConfig = {
  mode: 'paper', symbols: ['BTC'], strategies: ['trend_breakout'], allowShort: false,
  risk: DEFAULT_RISK, slippagePercent: 1, reservedSymbol: null,
};
const client = (bars: Bar[]) => ({ getHourlyCandles: async () => bars } as unknown as HyperliquidClient);

test('strategy: breakout fires on a new 48h high in an uptrend and not otherwise', () => {
  const now = Date.UTC(2026, 5, 1);
  const s = getStrategy('trend_breakout')!;
  const quiet = uptrend(now, WARMUP_BARS + 20, false);
  assert.equal(s.evaluate(computeIndicators(quiet), quiet, quiet.length - 1, 0, false).target, 0);
  const hot = uptrend(now, WARMUP_BARS + 20, true);
  const sig = s.evaluate(computeIndicators(hot), hot, hot.length - 1, 0, false);
  assert.equal(sig.target, 1);
  assert.ok(sig.stopPct >= 0.004 && sig.stopPct <= 0.15);
});

test('autopilot (paper): opens once per signal, sizes by risk, then stops out and books the loss', async () => {
  const now = Date.UTC(2026, 5, 1);
  const { db, tables } = fakeDb();
  const bars = uptrend(now, WARMUP_BARS + 20, true);

  const first = await runAutopilot(client(bars), db, 'u1', cfg, now);
  assert.equal(tables.autopilot_positions.length, 1);
  const p = tables.autopilot_positions[0];
  assert.equal(p.status, 'open');
  assert.equal(p.side, 'long');
  const stopPct = 1 - Number(p.stop_price) / Number(p.entry_price);
  // Loss at the stop is the 0.5% risk budget (unless the leverage cap bound it lower).
  assert.ok(Number(p.notional_usd) * stopPct <= 10_000 * 0.005 + 1e-6);
  assert.ok(first.events.some(e => e.level === 'trade'));

  // Scanning the same bar again must not open a second position.
  await runAutopilot(client(bars), db, 'u1', cfg, now + 60_000);
  assert.equal(tables.autopilot_positions.length, 1);

  // Next hour: price collapses through the stop.
  const lastC = bars[bars.length - 1].c;
  const crash: Bar = { t: bars[bars.length - 1].t + HOUR, o: lastC, h: lastC, l: lastC * 0.8, c: lastC * 0.82 };
  await runAutopilot(client([...bars.slice(1), crash]), db, 'u1', cfg, now + HOUR);
  assert.equal(p.status, 'closed');
  assert.equal(p.exit_reason, 'stop hit');
  assert.ok(Number(p.pnl) < 0);
  const state = tables.autopilot_state[0];
  assert.ok(Number(state.paper_equity) < 10_000 && Number(state.paper_equity) > 9_900, `paper equity ${state.paper_equity}`);
});

test('autopilot: a paused account opens nothing; a paper-only strategy is refused in live mode', async () => {
  const now = Date.UTC(2026, 5, 1);
  const bars = uptrend(now, WARMUP_BARS + 20, true);

  const paused = fakeDb();
  paused.tables.autopilot_state.push({ user_id: 'u1', mode: 'paper', day_key: '2026-06-01', day_start_equity: 10_000, peak_equity: 10_000, halted_reason: 'test pause', paper_equity: 10_000 });
  const r = await runAutopilot(client(bars), paused.db, 'u1', cfg, now);
  assert.equal(r.canOpen, false);
  assert.equal(paused.tables.autopilot_positions.length, 0);

  const live = fakeDb();
  const hl = { getHourlyCandles: async () => bars, getAccountSummary: async () => ({ totalValue: 10_000 }), getPositions: async () => [] } as unknown as HyperliquidClient;
  await runAutopilot(hl, live.db, 'u1', { ...cfg, mode: 'live', strategies: ['momentum_burst'] }, now);
  assert.equal(live.tables.autopilot_positions.length, 0);
});

// ---- cross-coin momentum basket (paper only) ----
import { MOMENTUM_ID, MOMENTUM_UNIVERSE, pickBasket, runMomentumPaper } from '../lib/autopilot/momentum';

test('momentum: ranks coins, takes the strongest and weakest quarter, and is never live-eligible', () => {
  const ranked = Array.from({ length: 12 }, (_, i) => ({ symbol: `C${i}`, ret: i / 10, price: 100 }));
  const { longs, shorts } = pickBasket(ranked);
  assert.deepEqual(longs.map(x => x.symbol), ['C11', 'C10', 'C9']);
  assert.deepEqual(shorts.map(x => x.symbol), ['C2', 'C1', 'C0']);
  assert.equal(pickBasket(ranked.slice(0, 5)).longs.length, 0); // too few coins to rank
  assert.equal(isLiveEligible(MOMENTUM_ID, false), false);
  assert.equal(isLiveEligible(MOMENTUM_ID, true), false);
});

test('momentum (paper): opens a balanced basket, holds it for a week, then settles and re-opens', async () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 5, 1, 0, 30);
  const { db, tables } = fakeDb();
  // Coin k rises k% per 90 days; after the first week every price is 10% higher.
  let bump = 1, clock = now; // candles always end the day before the current scan
  const hl = { getDailyCandles: async (symbol: string) => {
    const k = MOMENTUM_UNIVERSE.indexOf(symbol);
    return Array.from({ length: 95 }, (_, i) => ({ time: clock - (95 - i) * DAY, close: 100 * (1 + (k / 100) * (i / 94)) * bump }));
  } } as unknown as HyperliquidClient;

  const first = await runMomentumPaper(hl, db, 'u1', 10_000, now);
  const legs = tables.autopilot_positions;
  const longs = legs.filter(l => l.side === 'long'), shorts = legs.filter(l => l.side === 'short');
  assert.equal(longs.length, shorts.length);
  assert.ok(longs.length >= 2);
  const sum = (xs: typeof legs) => xs.reduce((a, l) => a + Number(l.notional_usd), 0);
  assert.ok(Math.abs(sum(longs) - 5_000) < 1e-6 && Math.abs(sum(shorts) - 5_000) < 1e-6); // half the balance each side
  assert.equal(first.pnl, 0);
  assert.ok(longs.every(l => MOMENTUM_UNIVERSE.indexOf(String(l.symbol)) > MOMENTUM_UNIVERSE.indexOf(String(shorts[0].symbol))));

  // Three days later: nothing happens.
  clock = now + 3 * DAY;
  const mid = await runMomentumPaper(hl, db, 'u1', 10_000, clock);
  assert.equal(mid.events.length, 0);
  assert.equal(tables.autopilot_positions.length, legs.length);

  // A week later, with every coin up 10%: longs gain what shorts lose, so the book only pays costs.
  bump = 1.1; clock = now + 7 * DAY + 60_000;
  const week = await runMomentumPaper(hl, db, 'u1', 10_000, clock);
  assert.ok(week.pnl < 0 && week.pnl > -30, `market-neutral book should only lose costs, got ${week.pnl}`);
  assert.equal(tables.autopilot_positions.filter(l => l.status === 'closed').length, longs.length * 2);
  assert.equal(tables.autopilot_positions.filter(l => l.status === 'open').length, longs.length * 2);
});

test('MACD trend: acts only when a 4-hour bar completes, and stays on paper despite passing the gate', () => {
  const now = Date.UTC(2026, 5, 1); // midnight UTC: the last hourly bar completes a 4h bar
  const bars = uptrend(now, WARMUP_BARS + 20, true);
  const ind = computeIndicators(bars);
  const s = getStrategy('macd_trend')!;
  const last = bars.length - 1;
  assert.equal(ind.h4.fresh[last], true);
  assert.equal(ind.h4.fresh[last - 1], false);
  // Mid-bar it never opens anything, and it never drops a position it holds.
  assert.equal(s.evaluate(ind, bars, last - 1, 0, true).target, 0);
  assert.equal(s.evaluate(ind, bars, last - 1, 1, true).target, 1);
  assert.equal(s.paperOnly, true);
  assert.equal(isLiveEligible('macd_trend', false), false);
  assert.equal(isLiveEligible('macd_trend', true), false);
});

// ---- trade suggestions ----
import { buildSuggestion, TARGET_R } from '../lib/suggestions';

test('suggestions: a breakout in an uptrend reads long, with stops on the correct side and a 2R target', () => {
  const now = Date.UTC(2026, 5, 1);
  const bars = uptrend(now, WARMUP_BARS + 20, true);
  const price = bars[bars.length - 1].c;
  const s = buildSuggestion('BTC', bars, price);
  assert.equal(s.bias, 'long');
  assert.ok(s.score >= 2);
  assert.ok(s.factors.some(f => f.counted && f.vote === 2), 'a tested rule should be signalling an entry');
  for (const side of [s.long, s.short]) {
    assert.ok(side.stopLossPct >= 0.5 && side.stopLossPct <= 12);
    assert.ok(Math.abs(side.takeProfitPct - side.stopLossPct * TARGET_R) < 0.11);
  }
  assert.ok(s.long.stopPrice < price && s.long.targetPrice > price);
  assert.ok(s.short.stopPrice > price && s.short.targetPrice < price);
  // Rules that failed testing may be shown but never move the score.
  assert.ok(s.factors.filter(f => !f.counted).every(f => f.vote === 0));
});

test('suggestions: with little history it stays neutral but still sizes a stop from volatility', () => {
  const now = Date.UTC(2026, 5, 1);
  const bars = uptrend(now, 200, false);
  const s = buildSuggestion('NEWCOIN', bars, bars[bars.length - 1].c);
  assert.equal(s.limitedHistory, true);
  assert.equal(s.bias, 'neutral');
  assert.ok(s.long.stopLossPct >= 0.5);
});
