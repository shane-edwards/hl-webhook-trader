import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { configFromSettings } from '@/lib/autopilot/run';
import { BARS_NEEDED, entrySignal } from '@/lib/autopilot/signals';
import { computeIndicators, getStrategy, WARMUP_BARS } from '@/lib/autopilot/strategies';
import { opportunityCandidates } from './policy';
import type { Evidence } from './model';
import { advanceMinute, comparisonSummary, HOUR, MINUTE, newComparison, scheduleSignals,
  type IdeaSignal, type MinuteMarket, type PaperComparison, type PaperEvent } from './crypto-paper-comparison';

type Db = ReturnType<typeof createServiceClient>;
type Feed = Pick<ReturnType<typeof marketDataClient>, 'getHourlyCandles' | 'getCandles' | 'getFundingRates'>;
type Profile = { user_id: string; enabled: boolean; entries_paused: boolean; updated_at: string };

export async function settlePaperMinutes(s: PaperComparison, feed: Feed, until: number, events: PaperEvent[]) {
  const symbols = [...new Set([...s.lots, ...(s.pending?.signals ?? [])].map(l => l.symbol))];
  if (!symbols.length && !s.pending) { s.through = until; return; }
  const start = s.through;
  const firstFunding = (Math.floor(start / HOUR) + 1) * HOUR;
  const markets = await Promise.all(symbols.map(async symbol => {
    const [bars, rates] = await Promise.all([feed.getCandles(symbol, '1m', start, until),
      firstFunding <= until ? feed.getFundingRates(symbol, firstFunding - MINUTE, until + MINUTE) : []]);
    const funding = new Map(rates.map(r => [Math.round(r.time / HOUR) * HOUR, r.rate]));
    const minutes = new Map<number, MinuteMarket>();
    for (const bar of bars) {
      const end = bar.t + MINUTE;
      minutes.set(bar.t, { bar, funding: end % HOUR ? 0 : funding.get(end) ?? NaN });
    }
    return { symbol, minutes };
  }));
  for (let t = start; t < until; t += MINUTE) {
    const tick = new Map<string, MinuteMarket>();
    for (const m of markets) { const b = m.minutes.get(t); if (b) tick.set(m.symbol, b); }
    advanceMinute(s, t, tick, events);
  }
}

export async function observePaperSignals(s: PaperComparison, candidates: Evidence[], feed: Feed, clock = Date.now) {
  const signals: IdeaSignal[] = [], exits = new Set<string>();
  const symbols = [...new Set([...candidates, ...s.lots].map(row => row.symbol))];
  const results = await Promise.allSettled(symbols.map(async symbol => {
    const bars = await feed.getHourlyCandles(symbol, BARS_NEEDED);
    return { symbol, bars, ind: computeIndicators(bars), last: bars.length - 1 };
  }));
  const now = clock();
  const signalBar = Math.floor(now / HOUR) * HOUR - HOUR;
  s.missing = [];
  const data = results.flatMap((r, i) => {
    if (r.status === 'rejected') { s.missing.push(symbols[i]); return []; }
    const market = r.value;
    if (market.bars.length < WARMUP_BARS + 2 || market.bars[market.last].t !== signalBar ||
        market.bars.some((b,i) => ![b.o,b.h,b.l,b.c].every(v => v > 0 && Number.isFinite(v)) ||
          (i > 0 && b.t !== market.bars[i-1].t + HOUR))) { s.missing.push(market.symbol); return []; }
    return [market];
  });
  for (const market of data) {
    for (const l of s.lots.filter(l => l.symbol === market.symbol)) {
      const rule = getStrategy(l.rule);
      if (!rule) throw new Error('Unknown frozen paper rule.');
      if (signalBar <= l.bar) continue;
      if (rule.evaluate(market.ind, market.bars, market.last, 1, false).target !== 1 ||
        (rule.maxHoldHours > 0 && signalBar - l.bar >= rule.maxHoldHours * HOUR)) exits.add(l.id);
    }
  }
  const bySymbol = new Map(data.map(m => [m.symbol,m]));
  // Same historically ranked order for both books, with a stable tie break for simultaneous entries.
  for (const e of candidates.sort((a,b) => b.stress - a.stress || a.version.localeCompare(b.version))) {
    const market = bySymbol.get(e.symbol);
    if (!market) continue;
    const signal = entrySignal(e.rule, market, now, false);
    if (signal?.side === 'long') signals.push({ id: `${e.version}@${signalBar}`, symbol:e.symbol,
      version:e.version, rule:e.rule, name:e.name, bar:signalBar, stopPct:signal.stopPct });
  }
  scheduleSignals(s, now, signals, [...exits]);
}

async function scanAccount(db: Db, profile: Profile, now: number, feed: Feed) {
  const user = profile.user_id, cutoff = Math.floor(now / MINUTE) * MINUTE;
  const saved = await db.from('crypto_paper_portfolios').select('through_ms,state').eq('user_id',user)
    .order('through_ms',{ascending:false}).limit(1).maybeSingle();
  if (saved.error) throw saved.error;
  const parent = Number(saved.data?.through_ms ?? 0);
  if (parent >= cutoff) return;
  const enabled = profile.enabled && !profile.entries_paused;
  let state = saved.data?.state as PaperComparison | undefined;
  if (!state) {
    if (!enabled) return;
    const settings = await db.from('settings').select('autopilot_risk_per_trade_pct,autopilot_daily_loss_limit_pct,autopilot_max_drawdown_pct')
      .eq('user_id',user).maybeSingle();
    if (settings.error) throw settings.error;
    state = newComparison(cutoff, configFromSettings(settings.data ?? {}).risk);
  }
  if (!enabled && state.pending && Date.parse(profile.updated_at) <= state.pending.at) state.pending.signals = [];
  const priorIssues = state.missing.join(',');
  const hasPositions = state.lots.length > 0 || !!state.pending;
  if (!enabled && !hasPositions) return;
  // Advance long gaps in bounded chunks. All fills must have complete observed prices and funding.
  const until = hasPositions ? Math.min(cutoff, state.through + 12 * HOUR) : cutoff;
  const events: PaperEvent[] = [];
  await settlePaperMinutes(state, feed, until, events);
  if (until === cutoff && !state.pending) {
    const candidates = enabled ? await opportunityCandidates(db, user, 'crypto') : [];
    await observePaperSignals(state, candidates, feed);
  }
  // Quiet scans still check every candidate. Keep one idle checkpoint per hour.
  if (parent && !hasPositions && !state.pending && !events.length && priorIssues === state.missing.join(',') &&
      Math.floor(parent / HOUR) === Math.floor(until / HOUR)) return;
  for (const event of events) {
    if (event.type === 'entry') state.recent.unshift(event);
    else {
      const entry = state.recent.find(e => e.id === event.id);
      if (entry) entry.net = event.net;
    }
  }
  state.recent = state.recent.slice(0, 12);
  const write = await db.from('crypto_paper_portfolios').insert({ user_id:user, through_ms:state.through, prior_ms:parent,
    state, events, summary:comparisonSummary(state) });
  if (write.error && write.error.code !== '23505') throw write.error;
}

export async function scanPaperPortfolios(db: Db, now: number) {
  const result = await db.from('automation_profiles').select('user_id,enabled,entries_paused,updated_at').eq('market','crypto');
  if (result.error) throw result.error;
  const feed = marketDataClient();
  const accounts = await Promise.allSettled(result.data.map(profile => scanAccount(db, profile, now, feed)));
  if (accounts.some(a => a.status === 'rejected')) throw new Error('Paper portfolio observations are incomplete.');
  return accounts.length;
}
