// Performance figures that can be computed honestly.
//
// Two sources, kept apart:
//   - The exchange's own account history (value and P&L over time). Returns,
//     drawdown and Sharpe are measured on this, against real account equity.
//   - This app's trade log, per trade, net of fees and funding once the
//     exchange figures have been synced (lib/reconcile.ts).
//
// Removed on purpose: Sortino, Calmar, recovery factor, Kelly and VaR. They
// were computed on per-trade dollar P&L as if each trade were a daily return,
// and measured drawdown against cumulative P&L rather than equity, so the
// numbers meant nothing.
import type { Trade, MonthlyPnL } from '@/types';
import type { AccountHistory } from '@/lib/hyperliquid/public';
import { format, parseISO } from 'date-fns';
import { netPnl } from '@/lib/journal';

export interface TradeStats {
  /** Sum of net results of closed trades. */
  totalPnl: number;
  totalTrades: number; winningTrades: number; losingTrades: number;
  winRate: number;
  profitFactor: number;
  /** Average net result per closed trade. */
  expectancy: number;
  avgWin: number; avgLoss: number; avgWinLossRatio: number;
  largestWin: number; largestLoss: number;
  maxConsecutiveWins: number; maxConsecutiveLosses: number;
  avgTradeDurationHours: number;
  totalFees: number;
  /** Positive = paid. */
  totalFunding: number;
  /** Closed trades whose fees and funding have been confirmed from the exchange. */
  costedTrades: number;
}

export function calculateAnalytics(trades: Trade[]): TradeStats {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null)
    .sort((a, b) => new Date(a.exit_time ?? a.entry_time).getTime() - new Date(b.exit_time ?? b.entry_time).getTime());
  const nets = closed.map(netPnl);
  const wins = nets.filter(x => x > 0), losses = nets.filter(x => x < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0), grossLoss = -losses.reduce((a, b) => a + b, 0);
  const totalPnl = nets.reduce((a, b) => a + b, 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;

  let run = 0, maxWins = 0, maxLosses = 0;
  for (const x of nets) {
    run = x > 0 ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
    maxWins = Math.max(maxWins, run); maxLosses = Math.max(maxLosses, -run);
  }
  const durations = closed.map(t => t.duration_seconds).filter((d): d is number => d != null);

  return {
    totalPnl, totalTrades: closed.length, winningTrades: wins.length, losingTrades: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: closed.length ? totalPnl / closed.length : 0,
    avgWin, avgLoss, avgWinLossRatio: avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0,
    largestWin: wins.length ? Math.max(...wins) : 0, largestLoss: losses.length ? Math.min(...losses) : 0,
    maxConsecutiveWins: maxWins, maxConsecutiveLosses: maxLosses,
    avgTradeDurationHours: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 3600 : 0,
    totalFees: closed.reduce((a, t) => a + Number(t.fees ?? 0), 0),
    totalFunding: closed.reduce((a, t) => a + Number(t.funding_paid ?? 0), 0),
    costedTrades: closed.filter(t => t.fills_synced_at != null).length,
  };
}

/** Net result by the month each trade closed in. */
export function buildMonthlyPnL(trades: Trade[]): MonthlyPnL[] {
  const map = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    if (t.status !== 'closed' || t.pnl == null) continue;
    const month = format(parseISO(t.exit_time ?? t.entry_time), 'yyyy-MM');
    const m = map.get(month) ?? { pnl: 0, trades: 0, wins: 0 };
    const net = netPnl(t);
    map.set(month, { pnl: m.pnl + net, trades: m.trades + 1, wins: m.wins + (net > 0 ? 1 : 0) });
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, d]) => ({
    month: format(parseISO(`${month}-01`), 'MMM yyyy'), pnl: Math.round(d.pnl * 100) / 100, trades: d.trades,
    winRate: d.trades ? (d.wins / d.trades) * 100 : 0,
  }));
}

export interface EquityStats {
  /** Account value, and a return index (starts at 100) that ignores deposits and withdrawals. */
  points: Array<{ t: number; equity: number; index: number; drawdownPct: number }>;
  /** Profit and loss over the period, in dollars. */
  pnl: number;
  /** Return over the period with deposits and withdrawals taken out, percent. Null without enough history. */
  returnPct: number | null;
  /** Largest fall of the return index from an earlier high, percent. */
  maxDrawdownPct: number | null;
  /** Annualised Sharpe ratio from daily returns (risk-free rate 0). Null with fewer than 30 daily returns. */
  sharpe: number | null;
  /** Number of daily returns available. */
  days: number;
}

export const MIN_DAYS_FOR_SHARPE = 30;

/**
 * Statistics from the exchange's account history. Each step's return is the
 * P&L earned in it divided by the account value at its start, so a deposit
 * does not look like a profit.
 */
export function equityStats(history: AccountHistory | null | undefined): EquityStats {
  const empty: EquityStats = { points: [], pnl: 0, returnPct: null, maxDrawdownPct: null, sharpe: null, days: 0 };
  if (!history || history.equity.length < 2 || history.pnl.length !== history.equity.length) return empty;
  const { equity, pnl } = history;

  const points: EquityStats['points'] = [];
  let index = 100, peak = 100, maxDd = 0, started = false;
  for (let i = 0; i < equity.length; i++) {
    if (i > 0 && equity[i - 1].v > 0) { index *= 1 + (pnl[i].v - pnl[i - 1].v) / equity[i - 1].v; started = true; }
    peak = Math.max(peak, index);
    const dd = (1 - index / peak) * 100;
    maxDd = Math.max(maxDd, dd);
    points.push({ t: equity[i].t, equity: equity[i].v, index, drawdownPct: dd });
  }
  if (!started) return { ...empty, points, pnl: pnl[pnl.length - 1].v - pnl[0].v };

  // Daily returns: the last index value of each UTC day.
  const byDay = new Map<string, number>();
  for (const p of points) byDay.set(new Date(p.t).toISOString().slice(0, 10), p.index);
  const daily = [...byDay.values()];
  const rets = daily.slice(1).map((v, i) => v / daily[i] - 1);
  let sharpe: number | null = null;
  if (rets.length >= MIN_DAYS_FOR_SHARPE) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : null; // crypto trades every day of the year
  }
  return { points, pnl: pnl[pnl.length - 1].v - pnl[0].v, returnPct: index - 100, maxDrawdownPct: maxDd, sharpe, days: rets.length };
}
