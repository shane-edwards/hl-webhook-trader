// The Autopilot rule simulator. Shared by the backtest (backtest/autopilot.ts)
// and the paper-versus-backtest comparison on the Autopilot page, so the
// "prediction" a paper record is compared with comes from the same code that
// produced the evidence.
import { computeIndicators, WARMUP_BARS, type Bar, type StrategyDef } from './strategies';

export const COST = 0.00045 + 0.0002; // taker fee + slippage per fill
export const STOP_SLIPPAGE = 0.0005; // stops fill worse than their trigger

export interface SimTrade {
  /** Return after costs and funding, as a fraction of the position's size. */
  net: number; gross: number; date: string;
  /** Open time (ms) of the bars the trade was entered and exited on. */
  entryT: number; exitT: number;
  /** Stop distance at entry, as a fraction of price: what position sizing is based on. */
  stopPct: number;
}
export interface Run { trades: SimTrade[]; hourly: Array<{ date: string; r: number }> }

/** Fixed coin quantity, sized at 1x equity at entry. Completed-bar signal,
 * next-bar execution. Hourly returns reconcile to the same cash P&L as trades. */
export function simulate(bars: Bar[], s: StrategyDef, allowShort: boolean, funding: Map<string, number>, from = WARMUP_BARS,
  options: { cost?: number; stopSlippage?: number; hourlyFunding?: Map<number, number> } = {}): Run {
  const ind = computeIndicators(bars);
  let pos: -1 | 0 | 1 = 0;
  let equity = 1, entry = 0, entryNotional = 0, reference = 0, stop = 0;
  let held = 0, costs = 0, entryT = 0, stopPct = 0;
  const trades: SimTrade[] = [];
  const hourly: Run['hourly'] = [];
  const cost = options.cost ?? COST;
  for (let i = Math.max(from, WARMUP_BARS); i < bars.length; i++) {
    const b = bars[i];
    const date = new Date(b.t).toISOString().slice(0, 10);
    const before = equity;
    const close = (px: number, extraCost = 0) => {
      const exitCost = (cost + extraCost) * px / entry;
      equity += entryNotional * (pos * (px - reference) / entry - exitCost);
      costs += exitCost;
      const gross = pos * (px / entry - 1);
      trades.push({ net: gross - costs, gross, date, entryT, exitT: b.t, stopPct });
      pos = 0; held = 0;
    };
    const sig = s.evaluate(ind, bars, i - 1, pos, allowShort);
    const wasOpen = pos !== 0;
    if (wasOpen && (sig.target !== pos || (s.maxHoldHours > 0 && held >= s.maxHoldHours))) close(b.o);
    if (!wasOpen && sig.target !== 0 && equity > 0) {
      pos = sig.target; entry = b.o; reference = entry; entryNotional = equity;
      stop = entry * (1 - pos * sig.stopPct); held = 0; entryT = b.t; stopPct = sig.stopPct;
      costs = cost; equity -= entryNotional * cost;
    }
    if (pos !== 0) {
      const hit = pos === 1 ? b.l <= stop : b.h >= stop;
      if (hit) close(pos === 1 ? Math.min(stop, b.o) : Math.max(stop, b.o), options.stopSlippage ?? STOP_SLIPPAGE);
      else {
        const rate = options.hourlyFunding ? options.hourlyFunding.get(b.t + 3_600_000) ?? 0 : (funding.get(date) ?? 0.0003) / 24;
        const fund = pos * rate * b.c / entry;
        equity += entryNotional * (pos * (b.c - reference) / entry - fund);
        costs += fund; reference = b.c; held++;
      }
    }
    equity = Math.max(0, equity);
    hourly.push({ date, r: before > 0 ? equity / before - 1 : 0 });
    if (equity === 0) break;
  }
  return { trades, hourly };
}
