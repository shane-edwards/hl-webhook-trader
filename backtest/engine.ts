// Daily-bar backtest engine for a single perpetual contract.
//
// Timeline for bar t: the strategy sees closes up to t-1, trades at the open
// of bar t (paying fee + slippage), then holds through bar t. Funding accrues
// on the open notional. The bar's low/high is used to check for liquidation,
// so a strategy cannot survive an intraday wipe-out just because the close
// recovered.

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CostModel {
  /** Fee per unit of traded notional (Hyperliquid base taker = 0.00045). */
  takerFee: number;
  /** Extra adverse execution per unit of traded notional. */
  slippage: number;
  /** Funding paid by longs per day, as a fraction of notional, for a date. Shorts receive it. */
  fundingForDate: (date: string) => number;
  /** Position is liquidated when equity < maintenanceMargin * notional. HL BTC (40x max) = 1.25%. */
  maintenanceMargin: number;
}

export interface BacktestOptions {
  startDate: string;
  endDate?: string;
  initialEquity?: number;
  /** Only trade when |target - current| exposure exceeds this (in units of equity). */
  rebalanceBand: number;
  costs: CostModel;
}

export interface BacktestResult {
  dates: string[];
  equity: number[];
  exposure: number[];
  trades: number;
  turnover: number; // total traded notional / average equity
  feesPaid: number;
  fundingPaid: number;
  liquidated: string | null;
}

/** exposureFn(i) may only look at candles[0..i-1]; it returns the desired exposure for bar i. */
export function runBacktest(
  candles: Candle[],
  exposureFn: (i: number) => number,
  opts: BacktestOptions
): BacktestResult {
  const { costs, rebalanceBand } = opts;
  let equity = opts.initialEquity ?? 10_000;
  let qty = 0; // signed BTC position
  const out: BacktestResult = {
    dates: [], equity: [], exposure: [], trades: 0, turnover: 0, feesPaid: 0, fundingPaid: 0, liquidated: null,
  };
  let tradedNotional = 0;
  let equitySum = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (c.date < opts.startDate) continue;
    if (opts.endDate && c.date > opts.endDate) break;

    if (!out.liquidated) {
      // Mark to the open (gap from the previous close).
      equity += qty * (c.open - candles[i - 1].close);

      const target = exposureFn(i);
      const current = (qty * c.open) / equity;
      const goingFlat = target === 0 && qty !== 0;
      if (goingFlat || Math.abs(target - current) > rebalanceBand) {
        const newQty = (target * equity) / c.open;
        const traded = Math.abs(newQty - qty) * c.open;
        const cost = traded * (costs.takerFee + costs.slippage);
        equity -= cost;
        out.feesPaid += cost;
        tradedNotional += traded;
        out.trades += 1;
        qty = newQty;
      }

      // Funding on the notional held through the day.
      const funding = qty * c.open * costs.fundingForDate(c.date);
      equity -= funding;
      out.fundingPaid += funding;

      // Worst intraday point for this position.
      const worstPx = qty >= 0 ? c.low : c.high;
      const worstEquity = equity + qty * (worstPx - c.open);
      if (qty !== 0 && worstEquity <= costs.maintenanceMargin * Math.abs(qty) * worstPx) {
        out.liquidated = c.date;
        equity = 0;
        qty = 0;
      } else {
        equity += qty * (c.close - c.open);
      }
    }

    out.dates.push(c.date);
    out.equity.push(equity);
    out.exposure.push(equity > 0 ? (qty * c.close) / equity : 0);
    equitySum += equity;
  }

  out.turnover = equitySum > 0 ? tradedNotional / (equitySum / out.equity.length) : 0;
  return out;
}

export interface Stats {
  totalReturn: number;
  cagr: number;
  vol: number;
  sharpe: number;
  maxDrawdown: number;
  worstYear: number;
  bestYear: number;
  timeInMarket: number;
  avgExposure: number;
  tradesPerYear: number;
  byYear: Record<string, number>;
}

export function computeStats(r: BacktestResult, initialEquity = 10_000): Stats {
  const n = r.equity.length;
  const years = n / 365;
  const final = r.equity[n - 1];
  const rets: number[] = [];
  let prev = initialEquity;
  let peak = initialEquity;
  let maxDrawdown = 0;
  const yearStart: Record<string, number> = {};
  const yearEnd: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const e = r.equity[i];
    rets.push(prev > 0 ? e / prev - 1 : 0);
    const y = r.dates[i].slice(0, 4);
    if (!(y in yearStart)) yearStart[y] = prev;
    yearEnd[y] = e;
    prev = e;
    if (e > peak) peak = e;
    maxDrawdown = Math.max(maxDrawdown, 1 - e / peak);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const vol = Math.sqrt(variance * 365);
  const byYear: Record<string, number> = {};
  for (const y of Object.keys(yearStart)) byYear[y] = yearStart[y] > 0 ? yearEnd[y] / yearStart[y] - 1 : 0;
  const yearly = Object.values(byYear);
  const inMarket = r.exposure.filter(e => Math.abs(e) > 1e-9);
  return {
    totalReturn: final / initialEquity - 1,
    cagr: final > 0 ? (final / initialEquity) ** (1 / years) - 1 : -1,
    vol,
    sharpe: vol > 0 ? (mean * 365) / vol : 0,
    maxDrawdown,
    worstYear: Math.min(...yearly),
    bestYear: Math.max(...yearly),
    timeInMarket: inMarket.length / n,
    avgExposure: r.exposure.reduce((a, b) => a + Math.abs(b), 0) / n,
    tradesPerYear: r.trades / years,
    byYear,
  };
}
