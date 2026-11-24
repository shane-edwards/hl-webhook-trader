// Autopilot risk rules. Pure functions so they can be unit tested; the runner
// applies them before every entry and on every scan.

export interface RiskConfig {
  /** Percent of equity lost if a position's stop is hit. */
  riskPerTradePct: number;
  maxPositions: number;
  /** Cap on one position's notional as a multiple of equity. */
  maxLeveragePerPosition: number;
  /** Stop opening new positions for the rest of the UTC day after losing this percent. */
  dailyLossLimitPct: number;
  /** Pause the autopilot entirely once equity falls this far below its peak. */
  maxDrawdownPct: number;
}

export const DEFAULT_RISK: RiskConfig = {
  riskPerTradePct: 0.5,
  maxPositions: 3,
  maxLeveragePerPosition: 2,
  dailyLossLimitPct: 3,
  maxDrawdownPct: 15,
};

/** Hyperliquid's minimum order notional. */
export const MIN_NOTIONAL_USD = 10;

/**
 * Position size from the stop distance: if the stop is hit, the loss is
 * `riskPerTradePct` of equity. Capped by the per-position leverage limit.
 */
export function sizeNotional(equity: number, stopPct: number, cfg: RiskConfig): number {
  if (!(equity > 0) || !(stopPct > 0)) return 0;
  const byRisk = (equity * cfg.riskPerTradePct) / 100 / stopPct;
  return Math.min(byRisk, equity * cfg.maxLeveragePerPosition);
}

export function capAutomationNotional(notional: number, stopPct: number, lossBudget: number | undefined, maxOrder: number | undefined) {
  const adverseMove = stopPct + 0.0075; // fees, execution and a modeled gap through the stop
  return Math.min(notional, maxOrder ?? Infinity, lossBudget == null ? Infinity : lossBudget / adverseMove);
}

export interface RiskState {
  /** UTC date the day-start figure belongs to. */
  dayKey: string;
  dayStartEquity: number;
  peakEquity: number;
  /** Set when the drawdown breaker has tripped; stays until the user resets it. */
  haltedReason: string | null;
}

export interface RiskCheck {
  state: RiskState;
  /** May new positions be opened right now? */
  canOpen: boolean;
  reason: string | null;
  dayPnlPct: number;
  drawdownPct: number;
}

export function checkRisk(prev: RiskState | null, equity: number, now: number, cfg: RiskConfig): RiskCheck {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  const state: RiskState = {
    dayKey,
    dayStartEquity: prev && prev.dayKey === dayKey && prev.dayStartEquity > 0 ? prev.dayStartEquity : equity,
    peakEquity: Math.max(prev?.peakEquity ?? 0, equity),
    haltedReason: prev?.haltedReason ?? null,
  };
  const dayPnlPct = state.dayStartEquity > 0 ? (equity / state.dayStartEquity - 1) * 100 : 0;
  const drawdownPct = state.peakEquity > 0 ? (1 - equity / state.peakEquity) * 100 : 0;

  if (!state.haltedReason && drawdownPct >= cfg.maxDrawdownPct) {
    state.haltedReason = `Equity is ${drawdownPct.toFixed(1)}% below its peak (limit ${cfg.maxDrawdownPct}%)`;
  }
  if (state.haltedReason) return { state, canOpen: false, reason: `Paused: ${state.haltedReason}`, dayPnlPct, drawdownPct };
  if (dayPnlPct <= -cfg.dailyLossLimitPct) {
    return { state, canOpen: false, reason: `Daily loss limit reached (${dayPnlPct.toFixed(1)}% today)`, dayPnlPct, drawdownPct };
  }
  return { state, canOpen: true, reason: null, dayPnlPct, drawdownPct };
}

/** Final gate before an entry. */
export function canOpenPosition(openPositions: number, notionalUsd: number, cfg: RiskConfig): { ok: boolean; reason: string | null } {
  if (openPositions >= cfg.maxPositions) return { ok: false, reason: `Already holding the maximum of ${cfg.maxPositions} positions` };
  if (notionalUsd < MIN_NOTIONAL_USD) return { ok: false, reason: 'Position would be under the $10 minimum; account too small for this risk setting' };
  return { ok: true, reason: null };
}
