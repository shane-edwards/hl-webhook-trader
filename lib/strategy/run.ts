import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { hlClientFromSettings } from '@/lib/hyperliquid/from-settings';
import { notify } from '@/lib/notify';
import { withTradingLock } from '@/lib/trading-lock';
import { DEFAULT_TREND_CONFIG, targetExposure, warmupBars, type TrendConfig } from './trend';
import { decideRebalance } from './rebalance';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * Distance of the strategy's exchange-side stop-loss from the mark price, in
 * percent. It is a catastrophe stop, not part of the signal: it only matters
 * if the price moves this far before the next daily run, or if the scheduler
 * stops running. The trend signal itself (lib/strategy/trend.ts) is unchanged.
 */
export const STRATEGY_STOP_PCT = 15;

export interface StrategyRunConfig {
  symbol: string;
  targetVol: number;
  maxLeverage: number;
  /** Capital to size against; null uses the whole account value. */
  capitalUsd: number | null;
  /** Compute and report the decision without sending any order. */
  dryRun: boolean;
  slippagePercent: number;
  /** Stop-loss distance from the mark price in percent. Defaults to STRATEGY_STOP_PCT. */
  stopPct?: number;
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
  /** Trigger price of the verified stop-loss resting on the exchange after this run; null when flat, dry or unverified. */
  stopPrice: number | null;
  message: string;
}

const DAY_MS = 86_400_000;

const emptyResult = (symbol: string): StrategyRunResult => ({
  symbol, status: 'error', signalDate: null, trendScore: null, realizedVol: null,
  targetExposure: null, currentExposure: null, equityUsd: null, tradedSize: null, fillPrice: null, stopPrice: null, message: '',
});

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error');

/**
 * One pass of the daily trend strategy: read completed daily candles from the
 * exchange, compute the target exposure with the same function the backtest
 * uses, and trade the difference if it is outside the rebalance band.
 * Safe to call more than once a day: a second call finds the position already
 * at target and holds.
 *
 * A live run never ends with the position unprotected and reported as fine:
 * whatever the rebalance did (traded, held or failed), the position that is
 * left gets one verified, full-size stop-loss resting on the exchange, or the
 * run is an error that says so. A dry run sends and cancels nothing.
 */
export async function runStrategyOnce(hl: HyperliquidClient, cfg: StrategyRunConfig, now = Date.now()): Promise<StrategyRunResult> {
  const result = emptyResult(cfg.symbol);

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
    } else {
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
    }
  } catch (err) {
    result.status = 'error';
    result.message = reasonOf(err);
  }

  // Dry runs place nothing, and that includes stops.
  if (cfg.dryRun) return result;

  // Runs after a failed rebalance too: a position left by an order that only
  // partly filled, or one that could not be rebalanced today, still needs its stop.
  try {
    const stop = await syncStrategyStop(hl, cfg);
    result.stopPrice = stop.stopPrice;
    if (stop.note) result.message = `${result.message}. ${stop.note}`;
    if (stop.cleanupError) {
      result.status = 'error';
      result.message = `${result.message}. ${stop.cleanupError}`;
    }
  } catch (err) {
    result.status = 'error';
    result.message = `${result.message}. ${reasonOf(err)}`;
  }
  return result;
}

interface StopSync {
  /** Trigger price of the verified resting stop, or null when there is no position. */
  stopPrice: number | null;
  /** What to add to the run message. */
  note: string | null;
  /** Set when the position is protected but older orders could not be cleared. */
  cleanupError: string | null;
}

/**
 * Brings the exchange-side stop into line with the position as it is now.
 * With a position: places a new reduce-only stop for the whole size at
 * `stopPct` from the mark price, checks that it is really resting, and only
 * then cancels the older stop / target orders on the symbol, so the position is
 * never without a stop. Without a position: clears leftover stop orders.
 * Throws when a position exists and its stop could not be placed or verified;
 * nothing is cancelled or closed in that case, so an earlier stop stays.
 */
async function syncStrategyStop(hl: HyperliquidClient, cfg: StrategyRunConfig): Promise<StopSync> {
  const stopPct = cfg.stopPct ?? STRATEGY_STOP_PCT;
  const readPosition = async () => {
    try {
      return await hl.getPosition(cfg.symbol);
    } catch (err) {
      throw new Error(`Could not read the ${cfg.symbol} position to check its stop-loss (${reasonOf(err)}): if a position is open it may be UNPROTECTED`);
    }
  };
  const position = await readPosition();

  if (!position) {
    let leftovers: Awaited<ReturnType<HyperliquidClient['getOpenOrders']>>;
    try {
      const orders = await hl.getOpenOrders(cfg.symbol);
      leftovers = orders.filter(o => o.isTrigger && o.reduceOnly);
      // A resting entry order may own stop / target orders that wait for it to fill: leave those alone.
      if (leftovers.length === 0 || orders.some(o => !o.reduceOnly)) return { stopPrice: null, note: null, cleanupError: null };
    } catch (err) {
      // With no position a leftover reduce-only order cannot trade, so this is a note, not a failed run.
      return { stopPrice: null, note: `Leftover ${cfg.symbol} stop orders could not be checked (${reasonOf(err)})`, cleanupError: null };
    }
    // Cancelling a stop is the one step here that removes protection, so be sure the account really is flat.
    if (await readPosition()) {
      throw new Error(`The ${cfg.symbol} position read as closed and then as open: no stop order was cancelled or placed, so it may be UNPROTECTED`);
    }
    try {
      await hl.cancelOrders(cfg.symbol, leftovers.map(o => o.oid));
    } catch (err) {
      return { stopPrice: null, note: `No position, but ${leftovers.length} leftover stop/target order${leftovers.length === 1 ? '' : 's'} could not be cancelled (${reasonOf(err)})`, cleanupError: null };
    }
    return { stopPrice: null, note: `No position: ${leftovers.length} leftover stop/target order${leftovers.length === 1 ? '' : 's'} cancelled`, cleanupError: null };
  }

  const held = `${position.size} ${cfg.symbol} ${position.side}`;
  let stopPx: number, mark: number, newOid: string;
  let resting: Awaited<ReturnType<HyperliquidClient['getOpenOrders']>>;
  try {
    if (!(stopPct > 0 && stopPct < 100)) throw new Error(`invalid stop distance ${stopPct}%`);
    mark = await hl.getMarkPrice(cfg.symbol);
    if (!(mark > 0)) throw new Error('no mark price');
    const wanted = position.side === 'long' ? mark * (1 - stopPct / 100) : mark * (1 + stopPct / 100);
    // Fixed-size, reduce-only: it can shrink or close the position, never grow or flip it.
    const [oid] = await hl.placeTriggerOrders({ coin: cfg.symbol, side: position.side, legs: [{ kind: 'sl', triggerPx: wanted, size: position.size }], grouping: 'na' });
    // Do not take the exchange's word for it: look for the stop actually resting.
    resting = await hl.getOpenOrders(cfg.symbol);
    const stop = oid == null ? undefined : resting.find(o => String(o.oid) === String(oid) && o.isTrigger && o.reduceOnly && /stop/i.test(o.orderType)
      && o.side === (position.side === 'long' ? 'sell' : 'buy') && o.size >= position.size * 0.999 && Math.abs(o.triggerPx - wanted) <= wanted * 0.01);
    if (!stop) throw new Error('the stop-loss was accepted but is not resting on the exchange at the required size and price');
    stopPx = stop.triggerPx;
    newOid = String(oid);
  } catch (err) {
    throw new Error(`POSITION UNPROTECTED: the stop-loss for the ${held} position could not be placed or verified (${reasonOf(err)}). The position was left open and any earlier stop order was left in place; check the exchange`);
  }

  const note = `Stop-loss resting at ${stopPx} (${stopPct}% ${position.side === 'long' ? 'below' : 'above'} mark ${mark}) for ${held}`;
  // Only now that the new stop is confirmed do the older ones go.
  const older = resting.filter(o => o.isTrigger && o.reduceOnly && String(o.oid) !== newOid);
  try {
    if (older.length) await hl.cancelOrders(cfg.symbol, older.map(o => o.oid));
  } catch (err) {
    return { stopPrice: stopPx, note, cleanupError: `The position is protected, but ${older.length} older stop/target order${older.length === 1 ? '' : 's'} could not be cancelled (${reasonOf(err)})` };
  }
  return { stopPrice: stopPx, note, cleanupError: null };
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
    stopPct: STRATEGY_STOP_PCT,
  };
}

export function runToRow(userId: string, r: StrategyRunResult) {
  // The stop price has no column of its own: it is part of the message.
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

// ---------- one account's run, as the scheduled jobs do it ----------

// The settings row of one account: strategy settings plus the wallet columns the exchange client reads.
type AccountSettings = StrategySettingsRow & NonNullable<Parameters<typeof hlClientFromSettings>[0]> & { user_id: string; updated_at?: string | null };

export interface AccountRunOptions {
  /** How long to wait for the account's trading lease when another worker holds it. Default: fail at once. */
  lockWaitMs?: number;
  now?: number;
  /** Test seams; the scheduled jobs use the defaults. */
  client?: (settings: AccountSettings) => HyperliquidClient | null;
  notify?: (message: string, subject: string | undefined, userId: string) => Promise<unknown>;
}

/**
 * Runs the strategy once for one account under its trading lease, records the
 * run in `strategy_runs` and sends the alert. Never throws: every failure
 * becomes a recorded 'error' run. Shared by the daily job and the scan's catch-up.
 */
export async function runStrategyForAccount(db: Db, settings: AccountSettings, opts: AccountRunOptions = {}): Promise<StrategyRunResult> {
  const cfg = strategyConfigFromSettings(settings);
  let result: StrategyRunResult;
  try {
    const hl = (opts.client ?? hlClientFromSettings)(settings);
    if (!hl) throw new Error('Hyperliquid credentials not configured');
    result = await withTradingLock(hl, db, settings.user_id, () => runStrategyOnce(hl, cfg, opts.now ?? Date.now()), false, { waitMs: opts.lockWaitMs });
  } catch (err) {
    result = { ...emptyResult(cfg.symbol), message: reasonOf(err) };
  }
  if (result.status === 'error') console.error('[strategy]', result.message);
  try {
    const { error } = await db.from('strategy_runs').insert(runToRow(settings.user_id, result));
    if (error) console.error('[strategy] run not recorded:', error.message);
  } catch (err) {
    console.error('[strategy] run not recorded:', reasonOf(err));
  }
  // Quiet days ("held") are not worth a message; trades, dry-run signals and errors are.
  if (result.status !== 'held') {
    try {
      await (opts.notify ?? notify)(`Strategy ${cfg.symbol} ${result.status === 'error' ? 'ERROR' : result.status}: ${result.message}`, undefined, settings.user_id);
    } catch { /* an alert that cannot be sent must not hide the run */ }
  }
  return result;
}

// ---------- catch-up from the five-minute scan ----------

/** The daily job is scheduled at 00:10 UTC (job hl-strategy, supabase/migrations/007_execution.sql). */
export const STRATEGY_DAILY_RUN_UTC_MINUTE = 10;
/**
 * The scan leaves the daily job this long to finish (it may run for a minute)
 * before stepping in, so the two do not both run at 00:10.
 */
export const STRATEGY_CATCH_UP_GRACE_MINUTES = 2;
/** A configuration that keeps failing stops being retried, and stops alerting, after this many error runs in a UTC day. */
export const MAX_STRATEGY_ERROR_RUNS_PER_DAY = 3;

export interface StrategyRunStamp { status: string; created_at: string }

/**
 * Should the scan run the strategy now? Yes when the daily job's time has
 * passed and today (UTC) has no run yet, or the latest run today is an error
 * and the day's error allowance is not used up. A successful run ('traded',
 * 'held' or 'dry_run') settles the day. Pure: `runs` are the account's
 * strategy_runs rows; rows from other days are ignored.
 */
export function shouldCatchUpStrategy(runs: StrategyRunStamp[], now: number): boolean {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  if (now < dayStart + (STRATEGY_DAILY_RUN_UTC_MINUTE + STRATEGY_CATCH_UP_GRACE_MINUTES) * 60_000) return false;
  const today = runs
    .map(r => ({ status: r.status, at: new Date(r.created_at).getTime() }))
    .filter(r => r.at >= dayStart && r.at < dayStart + DAY_MS);
  if (today.length === 0) return true;
  const latest = today.reduce((a, b) => (b.at >= a.at ? b : a));
  if (latest.status !== 'error') return false;
  return today.filter(r => r.status === 'error').length < MAX_STRATEGY_ERROR_RUNS_PER_DAY;
}

/** Reads today's runs for the account and applies shouldCatchUpStrategy. Throws when the runs cannot be read. */
export async function strategyCatchUpDue(db: Db, settings: AccountSettings, now = Date.now()): Promise<boolean> {
  // Before the daily job's time there is nothing to look up.
  if (!shouldCatchUpStrategy([], now)) return false;
  const dayStart = new Date(Math.floor(now / DAY_MS) * DAY_MS).toISOString();
  const { data, error } = await db.from('strategy_runs').select('status, created_at')
    .eq('user_id', settings.user_id).eq('symbol', strategyConfigFromSettings(settings).symbol)
    .gte('created_at', dayStart).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(`Could not read today's strategy runs: ${error.message}`);
  if (!shouldCatchUpStrategy(data ?? [], now)) return false;
  // A day with no run at all is only made up when the settings are as the daily job would have
  // seen them. If they changed since its time, the strategy may just have been switched on or
  // reconfigured: that waits for the next daily run instead of trading within minutes.
  if (!(data ?? []).length) {
    const jobTime = Math.floor(now / DAY_MS) * DAY_MS + STRATEGY_DAILY_RUN_UTC_MINUTE * 60_000;
    const changed = Date.parse(String(settings.updated_at ?? ''));
    if (Number.isFinite(changed) && changed >= jobTime) return false;
  }
  return true;
}
