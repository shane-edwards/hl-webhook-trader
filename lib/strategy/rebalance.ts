// Turns a target exposure into a concrete order. Pure, shared by the backtest
// (for the band) and the live runner.

/** Trade only when target and current exposure differ by more than this many multiples of equity. */
export const REBALANCE_BAND = 0.25;

/** Hyperliquid rejects orders under $10 notional. */
export const MIN_ORDER_USD = 10;

export interface RebalanceInput {
  /** Desired signed exposure as a multiple of equity. */
  targetExposure: number;
  /** Capital the strategy sizes against (USD). */
  equity: number;
  /** Current signed position in coins (negative = short). */
  positionSize: number;
  price: number;
  band?: number;
}

export interface RebalanceDecision {
  action: 'hold' | 'trade';
  reason: string;
  currentExposure: number;
  /** Signed coin quantity to trade (positive = buy). 0 when holding. */
  deltaSize: number;
  /** True when the trade only shrinks the existing position. */
  reduceOnly: boolean;
}

export function decideRebalance(input: RebalanceInput): RebalanceDecision {
  const { targetExposure, equity, positionSize, price } = input;
  const band = input.band ?? REBALANCE_BAND;
  const hold = (reason: string, currentExposure = 0): RebalanceDecision =>
    ({ action: 'hold', reason, currentExposure, deltaSize: 0, reduceOnly: false });

  if (!(equity > 0) || !(price > 0)) return hold('no equity or price');

  const currentExposure = (positionSize * price) / equity;
  const goingFlat = targetExposure === 0 && positionSize !== 0;
  if (!goingFlat && Math.abs(targetExposure - currentExposure) <= band) {
    return hold('within rebalance band', currentExposure);
  }

  const targetSize = (targetExposure * equity) / price;
  const deltaSize = targetSize - positionSize;
  if (!goingFlat && Math.abs(deltaSize) * price < MIN_ORDER_USD) {
    return hold('change is below the minimum order size', currentExposure);
  }

  const sameSide = positionSize !== 0 && Math.sign(targetSize) === Math.sign(positionSize);
  const reduceOnly = goingFlat || (sameSide && Math.abs(targetSize) < Math.abs(positionSize));
  return { action: 'trade', reason: goingFlat ? 'trend is down: go flat' : 'rebalance to target', currentExposure, deltaSize, reduceOnly };
}
