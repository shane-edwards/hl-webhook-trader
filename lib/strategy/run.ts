import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { DEFAULT_TREND_CONFIG, targetExposure, warmupBars, type TrendConfig } from './trend';
import { decideRebalance } from './rebalance';

export interface StrategyRunConfig {
  symbol: string;
  targetVol: number;
  maxLeverage: number;
  /** Capital to size against; null uses the whole account value. */
  capitalUsd: number | null;
  /** Compute and report the decision without sending any order. */
  dryRun: boolean;
  slippagePercent: number;
}

export interface StrategyRunResult {
  symbol: string;
  status: 'held' | 'traded' | 'dry_run' | 'error';
  signalDate: string | null;
  trendScore: number | null;
  realizedVol: number | null;
  targetExposure: number | null;
  currentExposure: number | null;
  equityUsd: number | null;
  tradedSize: number | null;
  fillPrice: number | null;
  message: string;
}

const DAY_MS = 86_400_000;

/**
 * One pass of the daily trend strategy: read completed daily candles from the
 * exchange, compute the target exposure with the same function the backtest
 * uses, and trade the difference if it is outside the rebalance band.
 * Safe to call more than once a day: a second call finds the position already
 * at target and holds.
 */
export async function runStrategyOnce(hl: HyperliquidClient, cfg: StrategyRunConfig, now = Date.now()): Promise<StrategyRunResult> {
  const result: StrategyRunResult = {
    symbol: cfg.symbol, status: 'error', signalDate: null, trendScore: null, realizedVol: null,
    targetExposure: null, currentExposure: null, equityUsd: null, tradedSize: null, fillPrice: null, message: '',
  };

  try {
    const trendCfg: TrendConfig = { ...DEFAULT_TREND_CONFIG, targetVol: cfg.targetVol, maxLeverage: cfg.maxLeverage };
    const needed = warmupBars(trendCfg);

    const candles = await hl.getDailyCandles(cfg.symbol, needed + 10);
    if (candles.length < needed) throw new Error(`Only ${candles.length} daily candles available; ${needed} needed`);
    const last = candles[candles.length - 1];
    // The newest completed candle must be yesterday's. Trading on stale data is worse than not trading.
    if (now - last.time > 2 * DAY_MS + 3_600_000) {
      throw new Error(`Price data is stale: last completed candle is ${new Date(last.time).toISOString().slice(0, 10)}`);
    }
    result.signalDate = new Date(last.time).toISOString().slice(0, 10);

    const signal = targetExposure(candles.map(c => c.close), trendCfg);
    result.trendScore = signal.trendScore;
    result.realizedVol = signal.vol;
    result.targetExposure = signal.exposure;

    const [account, position, price] = await Promise.all([
      hl.getAccountSummary(),
      hl.getPosition(cfg.symbol),
      hl.getMarkPrice(cfg.symbol),
    ]);
    const equity = cfg.capitalUsd != null ? Math.min(account.totalValue, cfg.capitalUsd) : account.totalValue;
    result.equityUsd = equity;

    const positionSize = position ? (position.side === 'long' ? position.size : -position.size) : 0;
    const decision = decideRebalance({ targetExposure: signal.exposure, equity, positionSize, price });
    result.currentExposure = decision.currentExposure;

    if (decision.action === 'hold') {
      result.status = 'held';
      result.message = decision.reason;
      return result;
    }

    const side = decision.deltaSize > 0 ? 'buy' : 'sell';
    const plan = `${side} ${Math.abs(decision.deltaSize).toFixed(5)} ${cfg.symbol} (${decision.reason})`;

    if (cfg.dryRun) {
      result.status = 'dry_run';
      result.message = `Dry run, no order sent. Would ${plan}`;
      return result;
    }

    if (signal.exposure === 0) {
      const closed = await hl.closePosition(cfg.symbol, cfg.slippagePercent);
      result.tradedSize = closed.side === 'long' ? -closed.filledSize : closed.filledSize;
      result.fillPrice = closed.fillPrice;
      if (!closed.fullyClosed) throw new Error(`Position only partly closed (${closed.filledSize} filled)`);
    } else {
      if (!decision.reduceOnly) {
        // Exchange leverage only sets how much margin a position reserves. One
        // notch above the strategy cap leaves headroom so orders near the cap
        // are not rejected for margin; actual exposure is set by order size.
        const { meta } = await hl.getAsset(cfg.symbol);
        await hl.setLeverage(cfg.symbol, Math.min(meta.maxLeverage, Math.ceil(cfg.maxLeverage) + 1));
      }
      const fill = await hl.placeIocOrder({
        coin: cfg.symbol,
        isBuy: decision.deltaSize > 0,
        size: Math.abs(decision.deltaSize),
        reduceOnly: decision.reduceOnly,
        slippagePercent: cfg.slippagePercent,
      });
      result.tradedSize = decision.deltaSize > 0 ? fill.sizeInContracts : -fill.sizeInContracts;
      result.fillPrice = fill.fillPrice;
    }

    result.status = 'traded';
    result.message = `Executed: ${plan}`;
    return result;
  } catch (err) {
    result.status = 'error';
    result.message = err instanceof Error ? err.message : 'Unknown error';
    return result;
  }
}

interface StrategySettingsRow {
  strategy_symbol?: string | null;
  strategy_target_vol?: number | string | null;
  strategy_max_leverage?: number | string | null;
  strategy_capital_usd?: number | string | null;
  strategy_dry_run?: boolean | null;
  slippage_percent?: number | string | null;
}

export function strategyConfigFromSettings(s: StrategySettingsRow, forceDryRun = false): StrategyRunConfig {
  return {
    symbol: s.strategy_symbol ?? 'BTC',
    targetVol: Number(s.strategy_target_vol ?? DEFAULT_TREND_CONFIG.targetVol),
    maxLeverage: Number(s.strategy_max_leverage ?? DEFAULT_TREND_CONFIG.maxLeverage),
    capitalUsd: s.strategy_capital_usd == null ? null : Number(s.strategy_capital_usd),
    // Anything other than an explicit `false` is a dry run.
    dryRun: forceDryRun || s.strategy_dry_run !== false,
    slippagePercent: Number(s.slippage_percent ?? 2),
  };
}

export function runToRow(userId: string, r: StrategyRunResult) {
  return {
    user_id: userId,
    symbol: r.symbol,
    status: r.status,
    signal_date: r.signalDate,
    trend_score: r.trendScore,
    realized_vol: r.realizedVol,
    target_exposure: r.targetExposure,
    current_exposure: r.currentExposure,
    equity_usd: r.equityUsd,
    traded_size: r.tradedSize,
    fill_price: r.fillPrice,
    message: r.message,
  };
}
