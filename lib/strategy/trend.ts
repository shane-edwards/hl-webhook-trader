// Volatility-targeted trend following on daily closes.
//
// This module is pure (no I/O) and is the single source of truth for the
// signal: the backtester and the live cron runner both call targetExposure(),
// so what gets backtested is exactly what gets traded.

export interface TrendConfig {
  /** Moving-average lengths (days). The trend score is the fraction of these the last close is above. */
  smaLookbacks: number[];
  /** Days of daily returns used to estimate realised volatility. */
  volLookback: number;
  /** Annualised volatility the position is scaled to when the trend score is 1 (e.g. 0.4 = 40%). */
  targetVol: number;
  /** Hard cap on exposure as a multiple of account equity. */
  maxLeverage: number;
  /** If true, a trend score of 0 goes short instead of flat (score is mapped to -1..1). */
  allowShort: boolean;
}

export const DEFAULT_TREND_CONFIG: TrendConfig = {
  smaLookbacks: [50, 100, 150, 200],
  volLookback: 30,
  targetVol: 0.4,
  maxLeverage: 2,
  allowShort: false,
};

export const DAYS_PER_YEAR = 365; // crypto trades every day

export function sma(values: number[], length: number, endIndex = values.length - 1): number {
  if (length <= 0 || endIndex - length + 1 < 0) return NaN;
  let sum = 0;
  for (let i = endIndex - length + 1; i <= endIndex; i++) sum += values[i];
  return sum / length;
}

/** Annualised standard deviation of daily log returns over the `length` days ending at endIndex. */
export function realizedVol(closes: number[], length: number, endIndex = closes.length - 1): number {
  if (length < 2 || endIndex - length < 0) return NaN;
  const rets: number[] = [];
  for (let i = endIndex - length + 1; i <= endIndex; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * DAYS_PER_YEAR);
}

/** Number of completed daily closes needed before a signal can be produced. */
export function warmupBars(cfg: TrendConfig): number {
  return Math.max(...cfg.smaLookbacks, cfg.volLookback + 1);
}

export interface TrendSignal {
  /** Desired position as a signed multiple of account equity (0 = flat, 1.5 = long 1.5x). */
  exposure: number;
  /** Fraction of moving averages the close is above (0..1). */
  trendScore: number;
  /** Annualised realised volatility used for sizing. */
  vol: number;
}

/**
 * Target exposure given completed daily closes (oldest first). `endIndex` is the
 * last bar the signal may look at; nothing after it is read.
 */
export function targetExposure(closes: number[], cfg: TrendConfig, endIndex = closes.length - 1): TrendSignal {
  if (endIndex + 1 < warmupBars(cfg)) return { exposure: 0, trendScore: 0, vol: NaN };

  const close = closes[endIndex];
  const above = cfg.smaLookbacks.filter(n => close > sma(closes, n, endIndex)).length;
  const trendScore = above / cfg.smaLookbacks.length;
  const vol = realizedVol(closes, cfg.volLookback, endIndex);
  if (!Number.isFinite(vol) || vol <= 0) return { exposure: 0, trendScore, vol };

  const direction = cfg.allowShort ? 2 * trendScore - 1 : trendScore;
  const raw = direction * (cfg.targetVol / vol);
  const exposure = Math.max(-cfg.maxLeverage, Math.min(cfg.maxLeverage, raw));
  return { exposure, trendScore, vol };
}
