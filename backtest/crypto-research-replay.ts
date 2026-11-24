import { FLOW_MARKETS, FRAME } from './crypto-flow-data';
import { DAY, HOUR } from './price-action-data';

export type Side = 1 | -1;
export type Window = readonly [number, number];
export type Trigger = { index: number; side: Side };
export type Costs = { fill: number; stop: number };
type ReplayInput = { rows: { t: number; perp: { o: number; h: number; l: number; c: number } }[];
  rowIndex: Map<number, number>; priorRange: number[]; funding: Map<number, number> };

export function replay(input: ReplayInput, triggers: Trigger[], hold: number, [from, to]: Window, expense: Costs, swing: boolean, frame = FRAME) {
  const { rows, rowIndex, priorRange, funding } = input;
  const [floor, cap, multiplier] = frame === HOUR
    ? (swing ? [.025, .12, 4] : [.006, .045, 1.4])
    : (swing ? [.03, .13, 14] : [.0035, .04, 3.25]);
  const trades: { t: number; pnl: number; side: Side }[] = [];
  const marks: { t: number; value: number }[] = [];
  let equity = 1;
  let available = 0;
  let totalFunding = 0;
  for (const { index, side } of triggers) {
    const start = rows[index];
    if (index < available || start.t < from) continue;
    const endTime = start.t + hold * frame;
    if (endTime >= to || equity <= 0) break;
    const end = rowIndex.get(endTime);
    if (end !== index + hold) continue;
    const entry = start.perp.o * (1 + side * expense.fill);
    const capital = equity;
    const distance = Math.max(floor, Math.min(cap, priorRange[index] * multiplier));
    const stop = entry * (1 - side * distance);
    let tradeFunding = 0;
    let priorMark = 0;
    for (let j = index; j <= end; j++) {
      const row = rows[j], bar = row.perp;
      // Process funding on an already-open position before an exit at that timestamp.
      if (j > index) tradeFunding -= side * (funding.get(row.t) ?? 0) * bar.o / entry;
      const stopped = j < end && (side === 1 ? bar.l <= stop : bar.h >= stop);
      const exit = j === end || stopped;
      const price = j === end ? bar.o : stopped ? (side === 1 ? Math.min(stop, bar.o) : Math.max(stop, bar.o)) : bar.c;
      const mark = side * (price * (1 - side * (expense.fill + (stopped ? expense.stop : 0))) / entry - 1) + tradeFunding;
      const value = capital * (mark - priorMark);
      equity += value;
      marks.push({ t: row.t, value });
      priorMark = mark;
      if (exit) {
        trades.push({ t: start.t, pnl: mark, side });
        totalFunding += capital * tradeFunding;
        available = stopped ? j + 1 : j;
        break;
      }
    }
  }
  return { trades, marks, net: equity - 1, totalFunding };
}

export function summarize(books: ReturnType<typeof replay>[], [from, to]: Window, symbols: readonly string[] = FLOW_MARKETS) {
  const weeks = new Float64Array(Math.ceil((to - from) / (7 * DAY)));
  const entryDays = new Set<number>();
  const returns = new Map<number, number>();
  const activeWeeks = new Set<number>();
  for (const book of books) {
    for (const mark of book.marks) returns.set(mark.t, (returns.get(mark.t) ?? 0) + mark.value / books.length);
    for (const trade of book.trades) {
      entryDays.add(Math.floor(trade.t / DAY));
      activeWeeks.add(Math.floor((trade.t - from) / (7 * DAY)));
    }
  }
  let equity = 1, peak = 1, drawdown = 0;
  for (const [time, value] of [...returns].sort(([a], [b]) => a - b)) {
    weeks[Math.floor((time - from) / (7 * DAY))] += value;
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  }
  const average = (equity - 1) / weeks.length;
  const error = Math.sqrt(weeks.reduce((sum, week) => sum + (week - average) ** 2, 0) / (weeks.length - 1) / weeks.length);
  const trades = books.flatMap(book => book.trades);
  return { net: equity - 1, drawdown, days: entryDays.size, weeks: activeWeeks.size, trades: trades.length,
    longs: trades.filter(trade => trade.side === 1).length, score: error > 0 ? average / error : 0,
    averageBps: trades.length ? trades.reduce((sum, trade) => sum + trade.pnl, 0) * 1e4 / trades.length : null,
    markets: books.map((book, index) => ({ coin: symbols[index], net: book.net, trades: book.trades.length })),
    funding: books.reduce((sum, book) => sum + book.totalFunding, 0) / books.length };
}
