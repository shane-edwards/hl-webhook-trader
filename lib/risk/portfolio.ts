// Account-wide limits, checked before every entry whatever opened it (manual
// ticket, webhook, Autopilot, limit orders). Closing and reducing are never blocked.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export interface PortfolioLimits {
  /** Total size of all positions may not exceed this multiple of account value. */
  maxGrossExposureX: number;
  /** No new entries for the rest of the UTC day once the account is down this percent. */
  dailyLossLimitPct: number;
}

export const DEFAULT_PORTFOLIO_LIMITS: PortfolioLimits = { maxGrossExposureX: 3, dailyLossLimitPct: 5 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function portfolioLimitsFromSettings(s: Record<string, any> | null | undefined): PortfolioLimits {
  const n = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? d : Number(v));
  return {
    maxGrossExposureX: n(s?.max_gross_exposure_x, DEFAULT_PORTFOLIO_LIMITS.maxGrossExposureX),
    dailyLossLimitPct: n(s?.portfolio_daily_loss_limit_pct, DEFAULT_PORTFOLIO_LIMITS.dailyLossLimitPct),
  };
}

export interface PortfolioCheckInput {
  equity: number;
  /** Sum of every open position's size in USD, long and short alike. */
  grossExposureUsd: number;
  newNotionalUsd: number;
  /** Account value at the start of the UTC day, or null when unknown (then the daily limit is skipped). */
  dayStartEquity: number | null;
  limits: PortfolioLimits;
}

/**
 * BTC, ETH and SOL tend to fall together, so positions are not treated as
 * independent: every dollar of exposure counts toward one gross cap.
 */
export function checkPortfolio(i: PortfolioCheckInput): { ok: boolean; reason: string | null } {
  if (!(i.equity > 0)) return { ok: false, reason: 'Account value is zero or unavailable.' };
  if (i.dayStartEquity != null && i.dayStartEquity > 0) {
    const dayPct = (i.equity / i.dayStartEquity - 1) * 100;
    if (dayPct <= -i.limits.dailyLossLimitPct) {
      return { ok: false, reason: `Daily loss limit reached: the account is down ${Math.abs(dayPct).toFixed(1)}% today (limit ${i.limits.dailyLossLimitPct}%). No new positions until 00:00 UTC.` };
    }
  }
  const cap = i.equity * i.limits.maxGrossExposureX;
  const after = i.grossExposureUsd + i.newNotionalUsd;
  if (after > cap * 1.001) {
    return { ok: false, reason: `Total exposure would be $${after.toFixed(0)}, over the limit of ${i.limits.maxGrossExposureX}x account value ($${cap.toFixed(0)}). Already open: $${i.grossExposureUsd.toFixed(0)}.` };
  }
  return { ok: true, reason: null };
}

/** Account value at the start of the current UTC day, recording it on the first call of the day. */
export async function dayStartEquity(db: Db, userId: string, equity: number, now = Date.now()): Promise<number | null> {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  try {
    const { data, error } = await db.from('portfolio_state').select('day_key, day_start_equity').eq('user_id', userId).maybeSingle();
    if (error) return null; // table not there yet (migration 006): skip the daily limit rather than block trading
    if (data && String(data.day_key) === dayKey && Number(data.day_start_equity) > 0) return Number(data.day_start_equity);
    await db.from('portfolio_state').upsert({ user_id: userId, day_key: dayKey, day_start_equity: equity, updated_at: new Date(now).toISOString() });
    return equity;
  } catch {
    return null;
  }
}

/** Throws with a plain-language reason if a new entry of `notionalUsd` would break a limit. */
export async function assertWithinPortfolioLimits(hl: HyperliquidClient, db: Db, userId: string, notionalUsd: number, limits: PortfolioLimits): Promise<void> {
  const [account, positions] = await Promise.all([hl.getAccountSummary(), hl.getPositions()]);
  const gross = positions.reduce((a, p) => a + p.size * p.markPrice, 0);
  const start = await dayStartEquity(db, userId, account.totalValue);
  const check = checkPortfolio({ equity: account.totalValue, grossExposureUsd: gross, newNotionalUsd: notionalUsd, dayStartEquity: start, limits });
  if (!check.ok) throw new Error(`Blocked by a portfolio limit. ${check.reason}`);
}
