// Paper record versus backtest: for the dates the paper account has been
// running, what would the backtest's simulator have made with the same rules,
// markets and position sizing? If the paper line falls well away from the
// replay line, the live scanner and the backtest disagree and the evidence
// behind a strategy should not be trusted until the cause is found.
import { simulate } from './simulate';
import { getStrategy, type Bar } from './strategies';
import { sizeNotional, type RiskConfig } from './risk';

export interface DriftPoint { t: number; paper: number; replay: number }
export interface StrategyDrift {
  id: string; name: string;
  paperTrades: number; replayTrades: number;
  /** Cumulative realised P&L in dollars at the end of the period. */
  paperPnl: number; replayPnl: number;
  points: DriftPoint[];
}

export interface PaperTrade { strategyId: string; exitTime: number; pnl: number }

/**
 * `bars` per symbol must include the warm-up history before `since`.
 * The replay sizes every trade from a fixed `equity` (the paper account's
 * starting balance), where the paper book sizes from its running balance; over
 * a short record the difference is small.
 */
export function computeDrift(p: {
  strategyIds: string[]; symbols: string[]; bars: Map<string, Bar[]>; allowShort: boolean;
  risk: RiskConfig; equity: number; since: number; now: number; paper: PaperTrade[];
}): StrategyDrift[] {
  const out: StrategyDrift[] = [];
  for (const id of p.strategyIds) {
    const strategy = getStrategy(id);
    if (!strategy) continue; // the cross-coin basket has no per-market replay
    const replay: Array<{ t: number; pnl: number }> = [];
    for (const symbol of p.symbols) {
      const bars = p.bars.get(symbol);
      if (!bars) continue;
      const from = bars.findIndex(b => b.t >= p.since);
      if (from < 0) continue;
      // The replay uses a 0.03% daily funding assumption. The forward paper
      // book accrues actual exchange funding, so this comparison includes that difference.
      for (const t of simulate(bars, strategy, p.allowShort, new Map(), from).trades) {
        replay.push({ t: t.exitT, pnl: sizeNotional(p.equity, t.stopPct, p.risk) * t.net });
      }
    }
    const paper = p.paper.filter(x => x.strategyId === id).map(x => ({ t: x.exitTime, pnl: x.pnl }));
    const times = [...new Set([p.since, ...replay.map(x => x.t), ...paper.map(x => x.t), p.now])].sort((a, b) => a - b);
    const cum = (rows: Array<{ t: number; pnl: number }>, t: number) => rows.filter(r => r.t <= t).reduce((a, r) => a + r.pnl, 0);
    out.push({
      id, name: strategy.name, paperTrades: paper.length, replayTrades: replay.length,
      paperPnl: cum(paper, p.now), replayPnl: cum(replay, p.now),
      points: times.map(t => ({ t, paper: cum(paper, t), replay: cum(replay, t) })),
    });
  }
  return out;
}
