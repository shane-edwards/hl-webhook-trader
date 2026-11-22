// Position size from the amount the user is prepared to lose. Pure, so the
// trade ticket and the tests share one implementation.
import { sizeNotional, MIN_NOTIONAL_USD } from '@/lib/autopilot/risk';

export interface RiskSizeInput {
  /** Account value in USD. Needed for percent risk and for the leverage cap. */
  equity: number;
  /** Amount to lose if the stop is hit: dollars, or percent of the account. */
  risk: number;
  riskUnit: 'usd' | 'pct';
  /** Stop distance from entry, in percent. */
  stopPct: number;
  /** The user's max position size setting (USD), less anything already held in this market. */
  maxPositionUsd: number;
  /** The market's maximum leverage. */
  maxLeverage: number;
}

export interface RiskSize {
  /** Position size in USD, after the caps. 0 when it cannot be sized. */
  sizeUsd: number;
  /** What is actually lost at the stop with this size (less than asked if a cap bit). */
  riskUsd: number;
  /** Smallest whole-number leverage that funds the position from the account. */
  leverageNeeded: number;
  marginUsd: number;
  /** Which limit reduced the size, if any. */
  cappedBy: 'max position size' | 'market max leverage' | null;
  /** Why no size could be given. */
  error: string | null;
}

export function sizeByRisk(input: RiskSizeInput): RiskSize {
  const none = (error: string): RiskSize => ({ sizeUsd: 0, riskUsd: 0, leverageNeeded: 1, marginUsd: 0, cappedBy: null, error });
  const { equity, risk, riskUnit, stopPct, maxPositionUsd, maxLeverage } = input;
  if (!(stopPct > 0)) return none('Set a stop-loss: the size is worked out from the stop distance');
  if (!(risk > 0)) return none('Enter the amount to risk');
  if (!(equity > 0)) return none('Account value unavailable, so the size cannot be checked against it. Use "Size in USD" instead.');

  const riskPct = riskUnit === 'pct' ? risk : (risk / equity) * 100;
  const uncapped = (equity * riskPct) / 100 / (stopPct / 100);
  // Same formula the Autopilot uses: size = risk / stop distance, capped by leverage.
  const byLeverage = sizeNotional(equity, stopPct / 100, {
    riskPerTradePct: riskPct, maxPositions: 1, maxLeveragePerPosition: Math.max(1, maxLeverage), dailyLossLimitPct: 0, maxDrawdownPct: 0,
  });

  let sizeUsd = byLeverage;
  let cappedBy: RiskSize['cappedBy'] = byLeverage < uncapped - 1e-9 ? 'market max leverage' : null;
  if (sizeUsd > maxPositionUsd) { sizeUsd = Math.max(0, maxPositionUsd); cappedBy = 'max position size'; }
  sizeUsd = Math.floor(sizeUsd * 100 + 1e-6) / 100;
  if (sizeUsd < MIN_NOTIONAL_USD) return none(`That risk gives a position under the $${MIN_NOTIONAL_USD} minimum${cappedBy ? ` (limited by your ${cappedBy})` : ''}`);

  const leverageNeeded = Math.max(1, Math.ceil(sizeUsd / equity - 1e-9));
  return { sizeUsd, riskUsd: (sizeUsd * stopPct) / 100, leverageNeeded, marginUsd: sizeUsd / leverageNeeded, cappedBy, error: null };
}
