// Trade ideas across every liquid Hyperliquid perp, refreshed in small batches
// by the scheduled market scan and cached, so no page ever computes them.
// Each time a market's read turns long or short it is logged, and logged ideas
// are scored later against what the price actually did (the scorecard).
import type { SupabaseClient } from '@supabase/supabase-js';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { getMarkets } from '@/lib/hyperliquid/public';
import { WARMUP_BARS } from '@/lib/autopilot/strategies';
import { buildSuggestion, type Suggestion } from '@/lib/suggestions';
import { resolveOutcome } from '@/lib/scorecard';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** A market must trade at least this much a day to be scanned. */
export const MIN_VOLUME_USD = 5_000_000;
export const MAX_MARKETS = 60;
/** Markets refreshed per run: each needs about 2,430 hourly candles, so the batch is kept small. */
const BATCH = 12;
const RESOLVE_BATCH = 12;
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

export interface Flip { symbol: string; from: string; to: 'long' | 'short'; strength: string; price: number; stopPct: number; targetPct: number }
export interface MarketScanResult { liquid: number; refreshed: string[]; flips: Flip[]; resolved: number; errors: string[] }

export async function runMarketScan(db: Db, now = Date.now()): Promise<MarketScanResult> {
  const result: MarketScanResult = { liquid: 0, refreshed: [], flips: [], resolved: 0, errors: [] };
  const hl = marketDataClient();

  const markets = (await getMarkets()).filter(m => m.volume24hUsd >= MIN_VOLUME_USD).sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, MAX_MARKETS);
  result.liquid = markets.length;
  const { data: cached, error } = await db.from('suggestions_cache').select('symbol, bias, bar_t, updated_at');
  if (error) throw new Error(`Could not read the ideas cache (has migration 006 been run?): ${error.message}`);
  const cache = new Map((cached ?? []).map(r => [r.symbol as string, r]));

  // Stalest first: never seen, then those computed from an older hourly bar.
  const latestBar = Math.floor(now / HOUR) * HOUR - HOUR;
  const due = markets
    .filter(m => !cache.has(m.coin) || Number(cache.get(m.coin)!.bar_t) < latestBar)
    .sort((a, b) => Number(cache.get(a.coin)?.bar_t ?? 0) - Number(cache.get(b.coin)?.bar_t ?? 0))
    .slice(0, BATCH);

  for (let i = 0; i < due.length; i += 4) {
    await Promise.all(due.slice(i, i + 4).map(async m => {
      try {
        const bars = await hl.getHourlyCandles(m.coin, WARMUP_BARS + 30);
        if (bars.length < 30) return;
        const s: Suggestion = buildSuggestion(m.coin, bars, m.price);
        const barT = bars[bars.length - 1].t;
        const prev = cache.get(m.coin);
        await db.from('suggestions_cache').upsert({
          symbol: m.coin, bias: s.bias, score: s.score, bar_t: barT, volume_24h_usd: m.volume24hUsd, payload: s, updated_at: new Date(now).toISOString(),
        });
        result.refreshed.push(m.coin);
        // A new idea: the read is long or short and was not on that side at the last look. A market seen
        // for the first time is not logged: its read may be days old, which would not be a fresh idea.
        if (s.bias !== 'neutral' && !s.limitedHistory && prev && prev.bias !== s.bias) {
          const lv = s[s.bias];
          const { error: logError } = await db.from('suggestion_log').insert({
            symbol: m.coin, bar_t: barT, price: m.price, bias: s.bias, score: s.score, strength: s.strength,
            stop_pct: lv.stopLossPct, target_pct: lv.takeProfitPct, stop_kind: lv.stopKind,
          });
          if (!logError) result.flips.push({ symbol: m.coin, from: String(prev.bias), to: s.bias, strength: s.strength, price: m.price, stopPct: lv.stopLossPct, targetPct: lv.takeProfitPct });
        }
      } catch (err) {
        result.errors.push(`${m.coin}: ${err instanceof Error ? err.message : err}`);
      }
    }));
  }

  // Markets that are no longer liquid drop out of the list.
  const liquid = new Set(markets.map(m => m.coin));
  const gone = [...cache.keys()].filter(s => !liquid.has(s));
  if (gone.length) await db.from('suggestions_cache').delete().in('symbol', gone);

  // ---- score earlier ideas ----
  // Ideas stay open for a week, so rotate through them rather than always re-checking the oldest.
  const { data: allOpen } = await db.from('suggestion_log').select('*').eq('resolved', false).lt('created_at', new Date(now - 2 * HOUR).toISOString())
    .order('created_at', { ascending: true }).limit(500);
  const pool = allOpen ?? [];
  const offset = pool.length > RESOLVE_BATCH ? (Math.floor(now / 300_000) * RESOLVE_BATCH) % pool.length : 0;
  const open = [...pool.slice(offset), ...pool.slice(0, offset)].slice(0, RESOLVE_BATCH);
  for (const row of open) {
    try {
      const shownAt = new Date(row.created_at).getTime();
      const bars = await hl.getCandles(row.symbol, '1h', Number(row.bar_t) + HOUR, Math.min(now, shownAt + WEEK + 2 * HOUR));
      const o = resolveOutcome(Number(row.price), row.bias === 'long' ? 1 : -1, Number(row.stop_pct), Number(row.target_pct), shownAt, bars.filter(b => b.t + HOUR > shownAt));
      const weekOver = now - shownAt >= WEEK + HOUR;
      await db.from('suggestion_log').update({
        outcome: o.outcome ?? (weekOver ? 'neither' : null),
        outcome_at: o.outcomeT ? new Date(o.outcomeT).toISOString() : null,
        ret_1d: o.ret1d, ret_3d: o.ret3d, ret_7d: o.ret7d, resolved: weekOver,
      }).eq('id', row.id);
      result.resolved += 1;
    } catch (err) {
      result.errors.push(`score ${row.symbol}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}
