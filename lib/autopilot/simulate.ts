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

/** 1x notional per position. Signal from bar i-1, executed at the open of bar i. */
export function simulate(bars: Bar[], s: StrategyDef, allowShort: boolean, funding: Map<string, number>, from = WARMUP_BARS): Run {
  const ind = computeIndicators(bars);
  let pos: -1 | 0 | 1 = 0, entry = 0, stop = 0, held = 0, tradeNet = 0, tradeGross = 0, entryT = 0, stopPct = 0;
  const trades: SimTrade[] = [];
  const hourly: Run['hourly'] = [];
  for (let i = Math.max(from, WARMUP_BARS); i < bars.length; i++) {
    const b = bars[i];
    const date = new Date(b.t).toISOString().slice(0, 10);
    let r = 0;
    const close = (px: number, extraCost = 0) => {
      const g = pos * (px / entry - 1);
      const move = pos * (px / (held === 0 ? entry : bars[i - 1].c) - 1);
      r += move - COST - extraCost; tradeGross = g; tradeNet += move - COST - extraCost;
      trades.push({ net: tradeNet, gross: tradeGross, date, entryT, exitT: b.t, stopPct });
      pos = 0; tradeNet = 0; held = 0;
    };

    const sig = s.evaluate(ind, bars, i - 1, pos, allowShort);
    // A position that was just closed is not re-opened on the same bar: its "hold" signal is not a fresh setup.
    const wasOpen = pos !== 0;
    if (wasOpen && (sig.target !== pos || (s.maxHoldHours > 0 && held >= s.maxHoldHours))) close(b.o);
    if (pos === 0 && !wasOpen && sig.target !== 0) {
      pos = sig.target; entry = b.o; stop = entry * (1 - pos * sig.stopPct); held = 0; entryT = b.t; stopPct = sig.stopPct;
      r -= COST; tradeNet = -COST;
    }
    if (pos !== 0) {
      const ref = held === 0 ? entry : bars[i - 1].c;
      const hit = pos === 1 ? b.l <= stop : b.h >= stop;
      if (hit) {
        // A gap through the stop fills at the open, not at the stop.
        const px = pos === 1 ? Math.min(stop, b.o) : Math.max(stop, b.o);
        const g = pos * (px / entry - 1), move = pos * (px / ref - 1);
        r += move - COST - STOP_SLIPPAGE; tradeNet += move - COST - STOP_SLIPPAGE;
        trades.push({ net: tradeNet, gross: g, date, entryT, exitT: b.t, stopPct });
        pos = 0; tradeNet = 0; held = 0;
      } else {
        const move = pos * (b.c / ref - 1), fund = (pos * (funding.get(date) ?? 0.0003)) / 24;
        r += move - fund; tradeNet += move - fund; held += 1;
      }
    }
    hourly.push({ date, r });
  }
  return { trades, hourly };
}
