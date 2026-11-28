import { closeUnverifiedEntry } from './recovery';
import { PAPER_COST, openPaperPnl, paperFill } from './paper-fill';
import { getUserFills, getUserFunding } from '@/lib/hyperliquid/public';
import { attributeCosts, exitFromFills } from '@/lib/reconcile';
import { accountResource, liveEntryReservation, withTradingLock } from '@/lib/trading-lock';
// The Autopilot scan: look at every watched market, manage positions it owns,
// and open new ones when a strategy fires and the risk rules allow it.
//
// Paper mode runs the identical logic against live prices but only records
// what it would have done, building a forward-test track record.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { closePositionFully, openPosition } from '@/lib/execution';
import { notify } from '@/lib/notify';
import { computeIndicators, getStrategy, WARMUP_BARS, type Bar } from './strategies';
import { BARS_NEEDED, entrySignal, HOUR_MS, isLiveEligible, strategyDirection } from './signals';
export { isLiveEligible } from './signals';
import { MOMENTUM_ID, MOMENTUM_STOP_PCT, runMomentumPaper } from './momentum';
import { runMomentumLive } from './momentum-live';
import { portfolioLimitsFromSettings, type PortfolioLimits } from '@/lib/risk/portfolio';
import { canOpenPosition, capAutomationNotional, checkRisk, DEFAULT_RISK, sizeNotional, type RiskConfig, type RiskState } from './risk';
import { estimateFill, liquidityVerdict } from '@/lib/liquidity';
import { readPages } from '@/lib/supabase/pages';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
export type Mode = 'paper' | 'live';


export interface AutopilotConfig {
  mode: Mode;
  symbols: string[];
  strategies: string[];
  allowShort: boolean;
  risk: RiskConfig;
  slippagePercent: number;
  /** Symbol reserved by the built-in daily strategy, if that is trading live. */
  reservedSymbol: string | null;
  /** Account-wide limits shared with manual and webhook trades (live mode only). */
  portfolio?: PortfolioLimits;
  manageOnly?: boolean;
  automationVersion?: string;
  paperTests?: { symbol:string; rule:string; version:string }[];
  allPaperSignals?: boolean;
  maxOrderUsd?: number;
  dollarLossBudget?: number;
  checkEntries?: () => Promise<boolean>;
  manualEntry?: { id: string; symbol: string; side: 'long' | 'short'; barT: number; plan?: string };
}

export interface AutopilotEvent { level: 'info' | 'trade' | 'warn' | 'error'; symbol?: string; strategyId?: string; message: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function configFromSettings(s: Record<string, any>): AutopilotConfig {
  const n = (v: unknown, d: number) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    mode: s.autopilot_mode === 'live' ? 'live' : 'paper',
    symbols: (Array.isArray(s.autopilot_symbols) ? s.autopilot_symbols : ['BTC', 'ETH', 'SOL']).map((x: unknown) => String(x).toUpperCase()).slice(0, 20),
    strategies: Array.isArray(s.autopilot_strategies) ? s.autopilot_strategies.map(String) : ['trend_breakout'],
    allowShort: s.autopilot_allow_short === true,
    risk: {
      riskPerTradePct: n(s.autopilot_risk_per_trade_pct, DEFAULT_RISK.riskPerTradePct),
      maxPositions: n(s.autopilot_max_positions, DEFAULT_RISK.maxPositions),
      maxLeveragePerPosition: n(s.autopilot_max_leverage, DEFAULT_RISK.maxLeveragePerPosition),
      dailyLossLimitPct: n(s.autopilot_daily_loss_limit_pct, DEFAULT_RISK.dailyLossLimitPct),
      maxDrawdownPct: n(s.autopilot_max_drawdown_pct, DEFAULT_RISK.maxDrawdownPct),
    },
    slippagePercent: n(s.slippage_percent, 2),
    portfolio: portfolioLimitsFromSettings(s),
    reservedSymbol: s.strategy_enabled === true && s.strategy_dry_run === false ? String(s.strategy_symbol ?? 'BTC') : null,
  };
}

interface PositionRow {
  entry_order_id?: string; recovery_pending?: boolean; account_resource?: string;
  id: string; symbol: string; strategy_id: string; side: 'long' | 'short';
  entry_price: number; size: number; notional_usd: number; stop_price: number; entry_bar_t: number; entry_time: string; funding_paid?: number; last_funding_time?: number;
}

export interface ScanResult { mode: Mode; equity: number; canOpen: boolean; haltReason: string | null; events: AutopilotEvent[]; manualOpened?: boolean }

export async function runAutopilot(hl: HyperliquidClient, db: Db, userId: string, cfg: AutopilotConfig, now = Date.now(), reload?: () => Promise<AutopilotConfig>): Promise<ScanResult> {
  return withTradingLock(hl, db, userId, async () => runAutopilotLocked(hl, db, userId, reload ? await reload() : cfg, now), cfg.mode === 'paper');
}

async function runAutopilotLocked(hl: HyperliquidClient, db: Db, userId: string, cfg: AutopilotConfig, now = Date.now()): Promise<ScanResult> {
  const { mode } = cfg;
  const started = Date.now();
  const clock = () => now + Date.now() - started;
  const resource = mode === 'live' ? accountResource(hl, userId) : null;
  const events: AutopilotEvent[] = [];
  let manualOpened = false;
  const log = (e: AutopilotEvent) => { events.push(e); };

  // ---- state and equity ----
  const { data: stateRow, error: stateError } = await db.from('autopilot_state').select('*').eq('user_id', userId).eq('mode', mode).maybeSingle();
  if (stateError) throw new Error(stateError.message);
  const closedPaper = mode === 'paper' ? await readPages((from,to) => db.from('autopilot_positions').select('pnl').eq('user_id', userId)
    .eq('mode', 'paper').eq('status', 'closed').order('id').range(from,to)) : [];
  let paperEquity = 10_000 + closedPaper.reduce((sum, p) => sum + Number(p.pnl ?? 0), 0);
  const liveAccount = mode === 'live' ? await hl.getAccountSummary() : null;

  const openRows = await readPages((from,to) => db.from('autopilot_positions').select('*')
    .eq('user_id', userId).eq('mode', mode).eq('status', 'open').order('id').range(from,to));
  if (resource && openRows?.length) {
    if (openRows.some(row => row.account_resource && row.account_resource !== resource))
      throw new Error('A managed position belongs to another Hyperliquid wallet or network. Check the original account.');
    if (openRows.some(row => !row.account_resource))
      throw new Error('An older live position has no verified wallet. Reconcile its original exchange order before continuing.');
  }
  let recovering = !!openRows?.some(row => row.recovery_pending);
  // The momentum basket has its own weekly cycle and is handled below.
  const open = new Map<string, PositionRow>((openRows ?? []).filter(r => r.strategy_id !== MOMENTUM_ID).map(r => [r.id, { ...r, entry_price: +r.entry_price, size: +r.size, notional_usd: +r.notional_usd, stop_price: +r.stop_price, entry_bar_t: +r.entry_bar_t }]));
  const openSymbols = () => [...open.values()].map(row => row.symbol);
  const samples = mode === 'paper' && !cfg.manualEntry ? cfg.paperTests : undefined;
  const quotes = new Map<string,Awaited<ReturnType<HyperliquidClient['getBookSnapshot']>>>();
  const paperFeed = { getBookSnapshot: async (symbol:string) => {
    const saved = quotes.get(symbol);
    if (saved?.time != null && clock() - saved.time < 5_000) return saved;
    const book = await hl.getBookSnapshot(symbol);
    quotes.set(symbol,book);
    return book;
  } };
  const missingFunding = new Set<string>();

  const exchangePositions = mode === 'live' ? new Map((await hl.getPositions()).map(p => [p.symbol, p])) : null;

  // ---- per-market data ----
  const market = new Map<string, { bars: Bar[]; ind: ReturnType<typeof computeIndicators>; last: number }>();
  async function loadMarket(symbol:string) {
    try {
      const bars = await hl.getHourlyCandles(symbol, BARS_NEEDED);
      if (bars.length < WARMUP_BARS + 2) { log({ level: 'warn', symbol, message: `Only ${bars.length} hourly candles available; skipped` }); return; }
      if (now - bars[bars.length - 1].t > 3 * HOUR_MS) { log({ level: 'warn', symbol, message: 'Price data is stale; skipped' }); return; }
      market.set(symbol, { bars, ind: computeIndicators(bars), last: bars.length - 1 });
    } catch (err) {
      log({ level: 'error', symbol, message: `Could not load candles: ${err instanceof Error ? err.message : err}` });
    }
  }
  const symbols = [...new Set([...cfg.symbols, ...openSymbols()])];
  const batchSize = samples ? 4 : 1;
  for (let i=0; i<symbols.length; i+=batchSize) await Promise.all(symbols.slice(i,i+batchSize).map(loadMarket));

  if (mode === 'paper') {
    const paperPositions = [...open.values(), ...(openRows ?? []).filter(p => p.strategy_id === MOMENTUM_ID)];
    const earliest = new Map<string,number>();
    const fundingBySymbol = new Map<string,Awaited<ReturnType<HyperliquidClient['getFundingRates']>>>();
    for (const p of paperPositions) earliest.set(p.symbol, Math.min(earliest.get(p.symbol) ?? Infinity,
      Number(p.last_funding_time ?? Date.parse(p.entry_time))));
    for (const p of paperPositions) {
      const since = p.last_funding_time ?? new Date(p.entry_time).getTime();
      if (missingFunding.has(p.symbol)) continue;
      if (!fundingBySymbol.has(p.symbol)) {
        try { fundingBySymbol.set(p.symbol,hl.getFundingRates ? await hl.getFundingRates(p.symbol, earliest.get(p.symbol)! + 1, now) : []); }
        catch (error) {
          if (!samples) throw error;
          missingFunding.add(p.symbol);
          log({level:'warn',symbol:p.symbol,message:'Waiting for funding data on this market.'});
          continue;
        }
      }
      const rates = fundingBySymbol.get(p.symbol)!.filter(r => r.time > since);
      if (!rates.length) continue;
      const dir = p.side === 'long' ? 1 : -1;
      const bars = market.get(p.symbol)?.bars ?? (rates.length && hl.getHourlyCandles ? await hl.getHourlyCandles(p.symbol, Math.min(5000, Math.ceil((now - since) / HOUR_MS) + 2)) : []);
      const paid = rates.reduce((sum, r) => {
        const price = bars.findLast(b => b.t <= r.time)?.c ?? p.entry_price;
        return sum + dir * p.size * price * r.rate;
      }, 0);
      p.funding_paid = Number(p.funding_paid ?? 0) + paid;
      p.last_funding_time = rates.at(-1)?.time ?? since;
      const saved = await db.from('autopilot_positions').update({ funding_paid: p.funding_paid, last_funding_time: p.last_funding_time }).eq('id', p.id);
      if (saved.error) throw new Error(saved.error.message);
    }
  }

  const settle = async (p: PositionRow, exitPrice: number, reason: string, costRate: number, actualPnl?: number) => {
    const dir = p.side === 'long' ? 1 : -1;
    const pnl = actualPnl ?? (p.notional_usd * (dir * (exitPrice / p.entry_price - 1)) - p.notional_usd * (costRate / 2 + costRate / 2 * exitPrice / p.entry_price) - Number(p.funding_paid ?? 0));
    const settled = await db.from('autopilot_positions').update({ status: 'closed', recovery_pending: false, exit_price: exitPrice, exit_time: new Date(now).toISOString(), exit_reason: reason, pnl }).eq('id', p.id);
    if (settled.error) throw new Error(settled.error.message);
    if (mode === 'paper') paperEquity += pnl;
    open.delete(p.id);
    log({ level: 'trade', symbol: p.symbol, strategyId: p.strategy_id, message: `Closed ${p.side} at ${exitPrice.toFixed(4)} (${reason}), P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` });
  };

  // ---- 1. manage what is already open ----
  for (const p of [...open.values()]) {
    if (missingFunding.has(p.symbol)) continue;
    const m = market.get(p.symbol);
    const strategy = getStrategy(p.strategy_id);
    try {
      let observedExit: Awaited<ReturnType<typeof paperFill>> | undefined;
      if (mode === 'live') {
        const ex = exchangePositions!.get(p.symbol);
        if (!ex) {
          const since = new Date(p.entry_time).getTime();
          const [{ fills, truncated }, funding] = await Promise.all([
            getUserFills(hl.address, since - 5000, hl.isTestnet), getUserFunding(hl.address, since, hl.isTestnet),
          ]);
          if (truncated) throw new Error('Fill history is incomplete; live settlement is deferred');
          const symbolFills = fills.filter(f => f.coin === p.symbol && f.time >= since);
          const opening = symbolFills.filter(f => f.dir.toLowerCase() === 'open ' + p.side && (!p.entry_order_id || f.oid === p.entry_order_id));
          const exit = exitFromFills(p.recovery_pending ? symbolFills : fills, p.symbol, since - 5000);
          if (!p.entry_order_id && p.recovery_pending && now - since >= 180_000 && !symbolFills.length) {
            const saved = await db.from('autopilot_positions').update({ status: 'closed', recovery_pending: false,
              exit_time: new Date(now).toISOString(), exit_reason: 'Verified flat with no exchange fill', pnl: null }).eq('id', p.id);
            if (saved.error) throw new Error(saved.error.message);
            open.delete(p.id);
            continue;
          }
          if (p.recovery_pending) {
            const opened = opening.reduce((sum, f) => sum + f.sz, 0);
            const closed = symbolFills.filter(f => f.dir.toLowerCase() === 'close ' + p.side).reduce((sum, f) => sum + f.sz, 0);
            if (!(opened > 0) || Math.abs(opened - closed) > opened * 1e-7) {
              log({ level: 'warn', symbol: p.symbol, message: 'Recovery is waiting for matching entry and exit fills' });
              continue;
            }
          }
          if (!exit) { log({ level: 'warn', symbol: p.symbol, message: 'Waiting for exchange closing fills before settlement' }); continue; }
          const actual = attributeCosts([{ id: p.id, symbol: p.symbol, size: p.size, entryTime: since, exitTime: exit.time }], fills, funding).get(p.id)!;
          await settle(p, exit.price, 'closed on the exchange; confirmed from fills', 0, actual.netPnl);
          continue;
        }
        if (p.recovery_pending) {
          await closeUnverifiedEntry(hl, db, userId, p, cfg.slippagePercent);
          log({ level: 'warn', symbol: p.symbol, message: 'Recovery verified flat. Waiting for exchange fills to settle the trade.' });
          continue;
        }
      } else {
        // Only a bar that started after the simulated fill can prove a subsequent stop touch.
        const dir = p.side === 'long' ? 1 : -1;
        const hit = m?.bars.find(b => b.t >= Date.parse(p.entry_time) && (dir === 1 ? b.l <= p.stop_price : b.h >= p.stop_price));
        if (hit) { const gapPrice = dir === 1 ? Math.min(p.stop_price, hit.o) : Math.max(p.stop_price, hit.o); await settle(p, gapPrice, 'stop hit', 2 * PAPER_COST + 0.0005); continue; }
        observedExit = await paperFill(paperFeed, p.symbol, dir === 1 ? 'sell' : 'buy', { quantity: p.size }, cfg.slippagePercent, clock);
        if (dir === 1 ? observedExit.price <= p.stop_price : observedExit.price >= p.stop_price) {
          await settle(p, observedExit.price, 'stop hit', 2 * PAPER_COST);
          continue;
        }
      }
      if (!m || !strategy) continue;

      const pos = p.side === 'long' ? 1 : -1;
      const heldHours = (m.bars[m.last].t - p.entry_bar_t) / HOUR_MS;
      const sig = strategy.evaluate(m.ind, m.bars, m.last, pos, cfg.allowShort);
      const timeUp = strategy.maxHoldHours > 0 && heldHours >= strategy.maxHoldHours;
      if (sig.target !== pos || timeUp) {
        const reason = timeUp ? `held ${strategy.maxHoldHours}h` : sig.reason;
        if (mode === 'live') {
          const closed = await closePositionFully(hl, db, userId, p.symbol, cfg.slippagePercent, `Autopilot exit: ${reason}`);
          log({ level: 'info', symbol: p.symbol, message: `Closed at ${closed.fillPrice}; awaiting exchange fill settlement` });
        } else {
          const fill = observedExit ?? await paperFill(hl, p.symbol, p.side === 'long' ? 'sell' : 'buy', { quantity: p.size }, cfg.slippagePercent, clock);
          await settle(p, fill.price, reason, 2 * PAPER_COST);
        }
      }
    } catch (err) {
      log({ level: 'error', symbol: p.symbol, strategyId: p.strategy_id, message: `Could not manage position: ${err instanceof Error ? err.message : err}` });
    }
  }

  // ---- 2. risk limits ----
  const paperMids = mode === 'paper' && openRows?.length ? await hl.getAllMids?.() : null;
  const markedRows = [...open.values(), ...(openRows ?? []).filter(p => p.strategy_id === MOMENTUM_ID)];
  const unrealized = (mode === 'paper' ? markedRows : []).reduce((sum, p) => {
    const m = market.get(p.symbol);
    const price = Number(paperMids?.[p.symbol] ?? m?.bars[m.last].c ?? p.entry_price);
    return sum + openPaperPnl(p, price);
  }, 0);
  const dailyRisk = mode === 'live' && hl.getDailyRisk ? await hl.getDailyRisk() : null;
  const cashFlowBaseline = Number(stateRow?.cash_flow_baseline ?? dailyRisk?.netDeposits ?? 0);
  const equity = mode === 'live' ? liveAccount!.totalValue : paperEquity + unrealized;
  const riskEquity = dailyRisk ? equity - (dailyRisk.netDeposits - cashFlowBaseline) : equity;
  const prev: RiskState | null = stateRow?.day_key
    ? { dayKey: String(stateRow.day_key), dayStartEquity: Number(stateRow.day_start_equity), peakEquity: Number(stateRow.peak_equity), haltedReason: stateRow.halted_reason ?? null }
    : null;
  const risk = checkRisk(dailyRisk ? { dayKey: new Date(now).toISOString().slice(0, 10), dayStartEquity: riskEquity - dailyRisk.pnl, peakEquity: prev?.peakEquity ?? riskEquity, haltedReason: prev?.haltedReason ?? null } : prev, riskEquity, now, cfg.risk);
  if (!samples && risk.state.haltedReason && !prev?.haltedReason) {
    log({ level: 'warn', message: `Autopilot paused: ${risk.state.haltedReason}. Open positions keep their stops; no new trades until you reset it.` });
  }

  // ---- 1b. the weekly long/short basket ----
  const basketSelected = cfg.strategies.includes(MOMENTUM_ID);
  const manualBasket = cfg.manualEntry?.id === MOMENTUM_ID ? cfg.manualEntry.plan : undefined;
  let basketPositions = (openRows ?? []).filter(p => p.strategy_id === MOMENTUM_ID);
  if ((!cfg.manualEntry || manualBasket) && (basketSelected || basketPositions.length) && !basketPositions.some(p => missingFunding.has(p.symbol))) {
    try {
      const independentBasket = mode === 'paper' && cfg.allPaperSignals === true;
      const canOpen = (independentBasket || risk.canOpen) && !recovering && !cfg.manageOnly && basketSelected && (!cfg.checkEntries || await cfg.checkEntries());
      if (mode === 'paper') {
        const exposure = equity * (cfg.portfolio?.maxGrossExposureX ?? 3) - [...open.values()].reduce((sum, p) => sum + p.notional_usd, 0);
        const m = await runMomentumPaper(hl, db, userId, independentBasket ? 10_000 : paperEquity, now, {
          canOpen, maxPositions: independentBasket ? Infinity : cfg.risk.maxPositions - open.size,
          availableNotional: independentBasket ? Infinity : Math.min(exposure, equity * cfg.risk.riskPerTradePct / MOMENTUM_STOP_PCT),
          occupied: new Set(independentBasket ? [] : [...openSymbols(), ...(cfg.reservedSymbol ? [cfg.reservedSymbol] : [])]),
          manualPlan: manualBasket, slippagePercent: cfg.slippagePercent,
        });
        if (manualBasket && m.opened) manualOpened = true;
        paperEquity += m.pnl;
        for (const e of m.events) log({ ...e, strategyId: MOMENTUM_ID });
      } else {
        const basketEvents: AutopilotEvent[] = [];
        // An open basket is still managed and closed; only a new automatic basket needs the long/short evidence.
        const opened = await runMomentumLive(hl, db, userId, cfg, equity, canOpen && (isLiveEligible(MOMENTUM_ID, true) || !!manualBasket), now, basketEvents, manualBasket);
        if (manualBasket && opened) manualOpened = true;
        for (const e of basketEvents) log({ ...e, strategyId: MOMENTUM_ID });
      }
    } catch (err) {
      log({ level: 'error', strategyId: MOMENTUM_ID, message: `Momentum basket failed: ${err instanceof Error ? err.message : err}` });
    }
    const fresh = await db.from('autopilot_positions').select('*').eq('user_id', userId).eq('mode', mode).eq('status', 'open').eq('strategy_id', MOMENTUM_ID);
    if (fresh.error) throw new Error(fresh.error.message);
    basketPositions = fresh.data ?? [];
    if (basketPositions.some(p => p.recovery_pending)) recovering = true;
  }
  const basketSymbols = new Set(basketPositions.map(p => p.symbol));

  // ---- 3. look for new entries ----
  if ((samples || risk.canOpen) && !recovering && !cfg.manageOnly) {
    const manual = cfg.manualEntry;
    const pending = new Set(mode === 'live' && hl.getOpenOrders ? (await hl.getOpenOrders()).filter(o => !o.reduceOnly).map(o => o.coin) : []);
    for (const symbol of manual ? [manual.symbol] : cfg.symbols) {
      if (recovering) break;
      if (missingFunding.has(symbol)) continue;
      if (pending.has(symbol)) continue;
      if (!samples && (openSymbols().includes(symbol) || basketSymbols.has(symbol))) continue;
      const m = market.get(symbol);
      if (!m) continue;
      if (!samples && symbol === cfg.reservedSymbol) continue;
      if (mode === 'live' && exchangePositions!.has(symbol)) continue; // a position the autopilot did not open: leave it alone

      const rules = samples ? samples.filter(row => row.symbol === symbol).map(row => row.rule) : manual ? [manual.id] : cfg.strategies;
      for (const id of rules) {
        // Automatic Live entries follow the evidence file. Paper and a reviewed manual entry use every selected rule.
        const shortOk = strategyDirection(id, cfg.allowShort, mode === 'paper' || !!manual);
        if (shortOk === null) continue;
        const sig = entrySignal(id, m, now, shortOk);
        if (!sig || (manual && (sig.barT !== manual.barT || sig.side !== manual.side))) continue;
        const { side, barT } = sig;
        // One open position per rule and coin. A setup that stays true for several hours is one trade, not one per hour.
        if (samples && [...open.values()].some(p => p.symbol === symbol && p.strategy_id === id)) continue;
        if (cfg.checkEntries && !await cfg.checkEntries()) break;

        const testedVersion = samples?.find(row => row.symbol === symbol && row.rule === id)?.version ?? cfg.automationVersion;
        // A short sample is independent of the long-only strategy version used for live review.
        const version = samples && side === 'short' ? testedVersion + '.short' : testedVersion;
        const notional = samples ? 1_000 : capAutomationNotional(sizeNotional(equity, sig.stopPct, cfg.risk), sig.stopPct, cfg.dollarLossBudget, cfg.maxOrderUsd);
        if (!samples) {
          const gate = canOpenPosition(open.size + basketPositions.length, notional, cfg.risk);
          if (!gate.ok) { log({ level: 'info', symbol, strategyId: id, message: `Signal skipped: ${gate.reason}` }); break; }
        }

        const reason = manual ? `Manual entry · ${sig.reason}` : sig.reason;
        try {
          const entrySlippage = version ? Math.min(cfg.slippagePercent, .35) : cfg.slippagePercent;
          if (cfg.automationVersion && mode === 'live') {
            const liquidity = liquidityVerdict(estimateFill(await hl.getBook(symbol), side === 'long' ? 'buy' : 'sell', notional), entrySlippage);
            if (liquidity.level === 'block') {
              log({ level: 'info', symbol, strategyId: id, message: `Signal skipped: ${liquidity.message}` });
              break;
            }
            if (cfg.checkEntries && !await cfg.checkEntries()) break;
          }
          // Reserve the signal bar first; the unique index makes a second scan of the same bar a no-op.
          const paper = mode === 'paper' ? await paperFill(paperFeed, symbol, side === 'long' ? 'buy' : 'sell', { usd: notional }, entrySlippage, clock) : null;
          if (samples && cfg.checkEntries && !await cfg.checkEntries()) break;
          const price = paper?.price ?? m.bars[m.last].c;
          if (!Number.isFinite(price) || price <= 0) throw new Error('Current price unavailable');
          const { data: row, error } = await db.from('autopilot_positions').insert({
            user_id: userId, mode, symbol, strategy_id: id, side, status: 'open',
            ...(version ? { automation_version: version } : {}),
            ...(paper ? { entry_time: new Date(paper.at).toISOString(), paper_book_fill: true } : { account_resource: resource, recovery_pending: true, entry_time: new Date(clock()).toISOString() }),
            entry_price: price, size: notional / price, notional_usd: notional,
            stop_price: price * (1 - sig.target * sig.stopPct), entry_bar_t: barT, entry_reason: reason,
          }).select('*').single();
          if (error) { if (error.code !== '23505') throw new Error(error.message); if (samples) continue; break; }

          let entry = price, size = notional / price, stop = price * (1 - sig.target * sig.stopPct);
          if (mode === 'live') {
            try {
              const opened = await liveEntryReservation.run(row.id, () => openPosition(hl, db, {
                userId, symbol, side, sizeUsd: notional, leverage: Math.max(1, Math.ceil(cfg.risk.maxLeveragePerPosition)),
                slippagePercent: entrySlippage, stopLossPct: sig.stopPct * 100, takeProfitPct: null,
                source: 'autopilot', payload: { strategy: id, reason, manual: !!manual }, limits: cfg.portfolio,
              }));
              entry = opened.fillPrice; size = opened.size; stop = opened.stopLossPx ?? stop;
              const needsExit = !!opened.protectionError || opened.stopLossPx == null;
              const saved = await db.from('autopilot_positions').update({ entry_price: entry, size, notional_usd: size * entry,
                stop_price: stop, entry_order_id: opened.orderId, recovery_pending: needsExit }).eq('id', row.id);
              if (saved.error) throw new Error(saved.error.message);
              if (needsExit) {
                recovering = true;
                await closePositionFully(hl, db, userId, symbol, cfg.slippagePercent, 'Autopilot stop unconfirmed');
                log({ level: 'warn', symbol, message: 'Stop unconfirmed. Recovery verified flat and is awaiting exchange fills.' });
                break;
              }
            } catch (err) {
              recovering = true;
              throw new Error(`Live entry requires reconciliation. New entries are blocked: ${err instanceof Error ? err.message : err}`);
            }
          }
          open.set(row.id, { ...row, entry_price: entry, size, notional_usd: size * entry, stop_price: stop, entry_bar_t: barT });
          if (manual) manualOpened = true;
          log({ level: 'trade', symbol, strategyId: id, message: `Opened ${side} $${(size * entry).toFixed(0)} at ${entry.toFixed(4)}, stop ${stop.toFixed(4)} (${reason})` });
        } catch (err) {
          log({ level: 'error', symbol, strategyId: id, message: `Entry failed: ${err instanceof Error ? err.message : err}` });
        }
        if (!samples) break;
      }
    }
  }

  // ---- 4. persist ----
  await db.from('autopilot_state').upsert({
    user_id: userId, mode, day_key: risk.state.dayKey, day_start_equity: risk.state.dayStartEquity,
    peak_equity: risk.state.peakEquity, halted_reason: risk.state.haltedReason, paper_equity: paperEquity,
    last_run_at: new Date(now).toISOString(), cash_flow_baseline: cashFlowBaseline,
  });
  if (events.length) {
    await db.from('autopilot_events').insert(events.map(e => ({ user_id: userId, mode, level: e.level, symbol: e.symbol ?? null, strategy_id: e.strategyId ?? null, message: e.message })));
    const important = events.filter(e => e.level !== 'info');
    if (important.length) await notify(`Autopilot (${mode}):\n` + important.map(e => `${e.symbol ?? ''} ${e.message}`.trim()).join('\n'), undefined, userId);
  }

  return { mode, equity, canOpen: (!!samples || risk.canOpen) && !recovering, haltReason: recovering ? 'Live entry recovery in progress' : samples ? null : risk.reason, events, manualOpened };
}
