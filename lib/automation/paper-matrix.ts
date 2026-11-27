// Paper results laid out as strategy by coin, so it is plain which pairs are making money and how
// far each is from the record Live review asks for. Pure functions over the paper trade rows.
import evidence from '@/lib/autopilot/evidence.json';
import { STRATEGIES } from '@/lib/autopilot/strategies';
import { PAPER_REQUIREMENT, paperThreshold } from './model';

export type PaperRow = { symbol: string; strategy_id: string; side: string; status: string; pnl: number | string | null; exit_time: string | null };

/** Where a pair stands against the Paper requirement. */
export type CellStatus = 'qualified' | 'ahead' | 'behind' | 'over-drawdown' | 'did-not-qualify' | 'open-only';

export interface PaperCell {
  symbol: string;
  closed: number; open: number; wins: number;
  /** Net result, largest drop, dates and t-statistic over the most recent closes the requirement judges. */
  net: number; drawdown: number; days: number; tStat: number | null;
  status: CellStatus;
}

export interface PaperLine {
  rule: string; name: string; side: 'long' | 'short';
  /** Whether this rule and direction passed its backtest. That backtest covers `backtestCoins` only. */
  backtest: 'passed' | 'failed' | 'untested';
  cells: Record<string, PaperCell>;
  closed: number; open: number; net: number;
}

export interface PaperMatrix {
  symbols: string[];
  lines: PaperLine[];
  backtestCoins: string[];
  requirement: typeof PAPER_REQUIREMENT;
  totals: { pairs: number; profitable: number; losing: number; qualified: number; closed: number; open: number; net: number };
}

const SIDES = ['long', 'short'] as const;

function backtestOf(rule: string, side: 'long' | 'short'): PaperLine['backtest'] {
  // A short is only ever taken by the long-and-short version of a rule, so that version's result applies.
  const row = evidence.strategies.find(s => s.id === rule && s.allowShort === (side === 'short'));
  return !row ? 'untested' : row.gatePassed ? 'passed' : 'failed';
}

function statusOf(result: ReturnType<typeof paperThreshold>, open: number): CellStatus {
  if (result.passed) return 'qualified';
  if (!result.closed) return open ? 'open-only' : 'behind';
  if (result.drawdown > PAPER_REQUIREMENT.maxDrawdownUsd) return 'over-drawdown';
  if (result.closed >= PAPER_REQUIREMENT.trades) return 'did-not-qualify';
  return result.net > 0 ? 'ahead' : 'behind';
}

export function buildPaperMatrix(rows: PaperRow[]): PaperMatrix {
  const known = new Map(STRATEGIES.map(s => [s.id, s.name]));
  const groups = new Map<string, { closes: { at: string; pnl: number }[]; open: number }>();
  const symbols = new Set<string>();
  for (const row of rows) {
    if (!known.has(row.strategy_id) || (row.side !== 'long' && row.side !== 'short')) continue;
    const key = `${row.strategy_id}|${row.side}|${row.symbol}`;
    const group = groups.get(key) ?? { closes: [], open: 0 };
    groups.set(key, group);
    if (row.status === 'open') { group.open += 1; symbols.add(row.symbol); continue; }
    const pnl = row.pnl == null ? NaN : Number(row.pnl);
    if (row.status !== 'closed' || !row.exit_time || !Number.isFinite(pnl)) continue;
    group.closes.push({ at: row.exit_time, pnl });
    symbols.add(row.symbol);
  }
  const backtestCoins = [...evidence.coins];
  const order = (s: string) => { const i = backtestCoins.indexOf(s); return i < 0 ? backtestCoins.length : i; };
  const columns = [...symbols].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const totals = { pairs: 0, profitable: 0, losing: 0, qualified: 0, closed: 0, open: 0, net: 0 };
  const lines: PaperLine[] = [];
  for (const strategy of STRATEGIES) for (const side of SIDES) {
    const line: PaperLine = { rule: strategy.id, name: strategy.name, side, backtest: backtestOf(strategy.id, side), cells: {}, closed: 0, open: 0, net: 0 };
    for (const symbol of columns) {
      const group = groups.get(`${strategy.id}|${side}|${symbol}`);
      if (!group || (!group.closes.length && !group.open)) continue;
      const result = paperThreshold(group.closes);
      const cell: PaperCell = { symbol, closed: group.closes.length, open: group.open, wins: group.closes.filter(c => c.pnl > 0).length,
        net: result.net, drawdown: result.drawdown, days: result.days, tStat: result.tStat, status: statusOf(result, group.open) };
      line.cells[symbol] = cell;
      line.closed += cell.closed; line.open += cell.open; line.net += cell.net;
      totals.pairs += 1; totals.closed += cell.closed; totals.open += cell.open; totals.net += cell.net;
      if (cell.status === 'qualified') totals.qualified += 1;
      if (cell.closed && cell.net > 0) totals.profitable += 1;
      if (cell.closed && cell.net < 0) totals.losing += 1;
    }
    lines.push(line);
  }
  return { symbols: columns, lines, backtestCoins, requirement: PAPER_REQUIREMENT, totals };
}
