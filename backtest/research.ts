// Research studies beyond the single-coin perp trend strategy. Pure functions
// over the cached datasets; used by the CLI report and by the in-app Lab.
import { loadCandles, loadCoinCandles, loadFunding, loadRealFunding } from './data';
import { computeStats, runBacktest, type BacktestResult, type Candle, type Stats } from './engine';
import { DEFAULT_TREND_CONFIG, targetExposure, type TrendConfig } from '../lib/strategy/trend';
import { REBALANCE_BAND } from '../lib/strategy/rebalance';

export const BASKET = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'];

// Hyperliquid base-tier fees.
export const PERP_TAKER_FEE = 0.00045;
export const SPOT_TAKER_FEE = 0.0007;
export const SLIPPAGE = 0.0003;
const MAINTENANCE_MARGIN = 0.0125;

/** Stats for an arbitrary equity series (reuses the engine's maths). */
export function statsFromEquity(dates: string[], equity: number[], exposure?: number[], trades = 0): Stats {
  const r: BacktestResult = {
    dates, equity, exposure: exposure ?? equity.map(() => 1), trades, turnover: 0, feesPaid: 0, fundingPaid: 0, liquidated: null,
  };
  return computeStats(r, 10_000);
}

// ---------------------------------------------------------------------------
// Trend strategy on any coin, perp or spot-first
// ---------------------------------------------------------------------------

export interface TrendRunOptions {
  coin?: string;
  /** 'bitstamp' = long BTC history (2012+); 'binance' = basket data (2017+). */
  source?: 'bitstamp' | 'binance';
  config?: Partial<TrendConfig>;
  startDate: string;
  endDate?: string;
  /** Hold spot for the first 1x and only use the perp above that. */
  spotFirst?: boolean;
  band?: number;
  fundingMultiplier?: number;
}

export function runTrend(opts: TrendRunOptions): BacktestResult {
  const coin = opts.coin ?? 'BTC';
  const candles: Candle[] = opts.source === 'bitstamp' || (!opts.source && coin === 'BTC') ? loadCandles() : loadCoinCandles(coin);
  const closes = candles.map(c => c.close);
  const cfg = { ...DEFAULT_TREND_CONFIG, ...opts.config };
  return runBacktest(candles, i => targetExposure(closes, cfg, i - 1).exposure, {
    startDate: opts.startDate,
    endDate: opts.endDate,
    rebalanceBand: opts.band ?? REBALANCE_BAND,
    costs: {
      takerFee: opts.spotFirst ? SPOT_TAKER_FEE : PERP_TAKER_FEE,
      slippage: SLIPPAGE,
      fundingForDate: loadFunding(0.0003, opts.fundingMultiplier ?? 1, coin),
      maintenanceMargin: MAINTENANCE_MARGIN,
      spotFirst: opts.spotFirst,
    },
  });
}

/** Buy and hold spot from the first bar on or after startDate. */
export function runHold(coin: string, source: 'bitstamp' | 'binance', startDate: string, endDate?: string): BacktestResult {
  const candles = source === 'bitstamp' ? loadCandles() : loadCoinCandles(coin);
  return runBacktest(candles, () => 1, {
    startDate, endDate, rebalanceBand: 0.9,
    costs: { takerFee: 0, slippage: 0, fundingForDate: () => 0, maintenanceMargin: MAINTENANCE_MARGIN },
  });
}

// ---------------------------------------------------------------------------
// Multi-coin trend: one equal-capital sleeve per coin, rebalanced daily
// ---------------------------------------------------------------------------

export interface BasketResult {
  dates: string[];
  equity: number[];
  exposure: number[];
  stats: Stats;
  perCoin: Array<{ coin: string; stats: Stats }>;
}

export function runBasketTrend(coins: string[], startDate: string, config: Partial<TrendConfig> = {}, spotFirst = false): BasketResult {
  const runs = coins.map(coin => ({ coin, r: runTrend({ coin, source: 'binance', config, startDate, spotFirst }) }));
  const byCoin = runs.map(({ r }) => {
    const ret = new Map<string, number>();
    const exp = new Map<string, number>();
    let prev = 10_000;
    r.dates.forEach((d, i) => {
      ret.set(d, prev > 0 ? r.equity[i] / prev - 1 : 0);
      exp.set(d, r.exposure[i]);
      prev = r.equity[i];
    });
    return { ret, exp };
  });
  const dates = [...new Set(runs.flatMap(({ r }) => r.dates))].sort();
  let eq = 10_000;
  const equity: number[] = [];
  const exposure: number[] = [];
  for (const d of dates) {
    // Every coin gets an equal sleeve; a coin with no data yet sits in cash.
    let r = 0;
    let e = 0;
    for (const c of byCoin) {
      r += c.ret.get(d) ?? 0;
      e += c.exp.get(d) ?? 0;
    }
    eq *= 1 + r / coins.length;
    equity.push(eq);
    exposure.push(e / coins.length);
  }
  return {
    dates, equity, exposure,
    stats: statsFromEquity(dates, equity, exposure),
    perCoin: runs.map(({ coin, r }) => ({ coin, stats: computeStats(r) })),
  };
}

// ---------------------------------------------------------------------------
// Funding capture: long spot + short perp of equal size (delta neutral)
// ---------------------------------------------------------------------------

export interface CarryOptions {
  coin: string;
  /**
   * Share of capital held as spot; the rest is margin for the short. 0.5 means
   * the short is backed 1:1 (liquidated only if price doubles in a day).
   */
  spotFraction?: number;
  /** Only hold the trade while trailing funding (annualised) is above this; otherwise sit in cash. */
  minAnnualFunding?: number;
  /** Days of trailing funding used for the filter. */
  lookbackDays?: number;
}

export interface CarryResult {
  coin: string;
  dates: string[];
  equity: number[];
  stats: Stats;
  /** Average annualised funding rate over the sample (what a short collects per unit of notional). */
  avgAnnualFunding: number;
  shareOfDaysPositive: number;
  shareOfDaysInTrade: number;
  /** Days the short leg would have been liquidated by the intraday high. */
  liquidations: string[];
  switches: number;
}

export function runCarry(opts: CarryOptions): CarryResult {
  const { coin } = opts;
  const f = opts.spotFraction ?? 0.5;
  const lookback = opts.lookbackDays ?? 7;
  const funding = loadRealFunding(coin);
  const candles = loadCoinCandles(coin).filter(c => funding.has(c.date));
  const rates = candles.map(c => funding.get(c.date)!);

  const legCost = SPOT_TAKER_FEE + PERP_TAKER_FEE + 2 * SLIPPAGE; // open (or close) both legs, per unit notional
  // Price rise that liquidates the short: margin (1-f) against notional f.
  const liqMove = ((1 - f) / f - MAINTENANCE_MARGIN) / (1 + MAINTENANCE_MARGIN);

  let equity = 10_000;
  let inTrade = false;
  let switches = 0;
  const dates: string[] = [];
  const eq: number[] = [];
  const exposure: number[] = [];
  const liquidations: string[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    // Decide with funding known up to yesterday.
    let want = true;
    if (opts.minAnnualFunding != null) {
      if (i < lookback) want = false;
      else {
        let sum = 0;
        for (let j = i - lookback; j < i; j++) sum += rates[j];
        want = (sum / lookback) * 365 > opts.minAnnualFunding;
      }
    }
    if (want !== inTrade) {
      equity -= equity * f * legCost;
      inTrade = want;
      switches += 1;
    }

    if (inTrade) {
      const notional = equity * f;
      equity += notional * rates[i]; // shorts receive positive funding, pay negative
      // Keeping the two legs equal as price moves means trading a little of each.
      const move = Math.abs(c.close / c.open - 1);
      equity -= notional * (1 - f) * move * (SPOT_TAKER_FEE + PERP_TAKER_FEE);
      const upMove = c.high / c.open - 1;
      if (upMove >= liqMove) {
        // The spot leg's gain offsets the short's loss, so the damage is the
        // maintenance margin the exchange keeps plus the cost of re-opening.
        liquidations.push(c.date);
        equity -= notional * (1 + upMove) * MAINTENANCE_MARGIN + notional * legCost;
      }
    }
    dates.push(c.date);
    eq.push(equity);
    exposure.push(inTrade ? f : 0);
  }

  const n = rates.length;
  return {
    coin, dates, equity: eq,
    stats: statsFromEquity(dates, eq, exposure),
    avgAnnualFunding: (rates.reduce((a, b) => a + b, 0) / n) * 365,
    shareOfDaysPositive: rates.filter(r => r > 0).length / n,
    shareOfDaysInTrade: exposure.filter(e => e > 0).length / n,
    liquidations,
    switches,
  };
}
