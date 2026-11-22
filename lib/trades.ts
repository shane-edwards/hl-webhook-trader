export interface PnlInput {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  /** Position size in coins. */
  size: number;
  leverage: number;
}

/**
 * Realised P&L of a round trip, before fees and funding.
 * `pnl` is in USD (price move x coins). `pnlPercentage` is return on the
 * margin posted, i.e. the price move multiplied by leverage.
 */
export function computePnl({ side, entryPrice, exitPrice, size, leverage }: PnlInput) {
  const direction = side === 'long' ? 1 : -1;
  const pnl = (exitPrice - entryPrice) * size * direction;
  const pnlPercentage = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * direction * leverage * 100 : 0;
  return { pnl, pnlPercentage };
}
