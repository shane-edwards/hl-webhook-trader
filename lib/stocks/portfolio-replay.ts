import type { EarningsTrade } from './backtest';
import { addStockGroupExposure, stockGroupExposure, type StockPortfolio } from './portfolio';
import { replayEntry, replayExit, replayNights, replayStop, stockReplayCosts, type StockReplayCost } from './replay';
import { stockSignal, type DailyStockRule, type StockBar } from './research';
import { previousStockSession } from './session';
import { STOCK_INSTRUMENTS, supportsStockTradeRule, type StockTradeRule, type StockTradeSymbol } from './trade-rules';
import { stockEdgeEvidence, stockRegime, type EvidenceTrade } from './evidence-model';
import edgeStudy from './edge-evidence.json';

export type StockPortfolioInput = { symbol: StockTradeSymbol; daily: StockBar[]; regular: StockBar[];
  events: EarningsTrade[]; missingEvents: number };
export type PortfolioReplaySettings = StockPortfolio & { capital: number; from: string; to: string };
type Entry = NonNullable<ReturnType<typeof replayEntry>>;
type Holding = { symbol: StockTradeSymbol; rule: StockTradeRule; position: Entry; entryDay: string; mark: number; held: number; exitOnOpen: boolean; basis: number };
type Candidate = { symbol: StockTradeSymbol; rule: StockTradeRule; ask: number; bid: number; event?: EarningsTrade };
type Timeline = ReturnType<typeof prepareTimeline>;

function indexBars(bars: StockBar[]) {
  return { bars, closes: bars.map(bar => bar.bidClose), index: new Map(bars.map((bar, i) => [bar.day, i])) };
}

function prepareTimeline(inputs: StockPortfolioInput[], benchmark: StockBar[], settings: PortfolioReplaySettings) {
  const evidence = edgeStudy.trades as EvidenceTrade[];
  return {
    benchmark: benchmark.filter(bar => bar.day >= settings.from && bar.day <= settings.to),
    market: indexBars(benchmark),
    evidence,
    stocks: new Map(inputs.map(input => [input.symbol, {
      daily: indexBars(input.daily), regular: indexBars(input.regular), events: new Map(input.events.map(event => [event.day, event])),
    }])),
  };
}

function simulate(timeline: Timeline, settings: PortfolioReplaySettings, costs: StockReplayCost) {
  const positions = new Map<StockTradeSymbol, Holding>();
  const results = new Map<StockTradeRule, { pnl: number; trades: number }>();
  const skips = { position: 0, exposure: 0, group: 0, dailyLoss: 0, cash: 0, spread: 0, cost: 0, evidence: 0 };
  const curve: { day: string; equity: number }[] = [];
  const amount = costs.amount!;
  const notional = amount * (costs.leverage ?? 1);
  let cash = settings.capital, peak = cash, drawdown = 0, grossSum = 0, trades = 0, wins = 0, financing = 0, stops = 0, missingBars = 0;
  const equity = () => cash + [...positions.values()].reduce((sum, item) => sum + replayExit(item.position, item.mark, costs), 0);
  const close = (holding: Holding, bid: number, stopped = false) => {
    const proceeds = replayExit(holding.position, bid, costs);
    cash += proceeds;
    positions.delete(holding.symbol);
    const pnl = proceeds - holding.basis;
    const rule = results.get(holding.rule) ?? { trades: 0, pnl: 0 };
    results.set(holding.rule, { trades: rule.trades + 1, pnl: rule.pnl + pnl });
    stops += Number(stopped);
    wins += Number(pnl > 0);
    trades++;
  };
  function barsFor(symbol: StockTradeSymbol, rule: StockTradeRule) {
    const asset = timeline.stocks.get(symbol);
    return rule === 'inside-day' ? asset?.regular : asset?.daily;
  }
  function tryEntries(batch: Candidate[], day: string, openingEquity: number) {
    if (!batch.length) return;
    const spread = ({ ask, bid }: Candidate) => (ask - bid) / ask * 10_000;
    const leverage = costs.leverage ?? 1;
    const index = timeline.market.index.get(day)!;
    const regime = stockRegime(timeline.market.bars.slice(Math.max(0, index - 21), index));
    const past = timeline.evidence.filter(trade => trade.closed < day);
    const rank = { Qualified: 0, Watch: 1, Skip: 2 };
    const ranked = batch.map(candidate => {
      const friction = spread(candidate) + 10_000 * costs.commission / notional + (leverage > 1 ? costs.cfdFeeBps ?? 0 : 0);
      const edge = stockEdgeEvidence(past, candidate.symbol, candidate.rule, regime, true,
        2 * friction - spread(candidate), leverage, costs.slipBps, spread(candidate));
      return { ...candidate, friction, edge: leverage === 1 ? edge : { ...edge, status: 'Watch' as const } };
    }).sort((a, b) => rank[a.edge.status] - rank[b.edge.status] ||
      (b.edge.lowerBps ?? -Infinity) - (a.edge.lowerBps ?? -Infinity) || a.friction - b.friction ||
      a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
    for (const candidate of ranked) {
      const { symbol, rule, ask, bid, event } = candidate;
      if (positions.has(symbol) || positions.size >= settings.maxPositions) { skips.position++; continue; }
      if (openingEquity - equity() >= settings.dailyLoss) { skips.dailyLoss++; continue; }
      if (spread(candidate) > (event ? 10 : 30)) { skips.spread++; continue; }
      if (candidate.friction > settings.maxCostBps) { skips.cost++; continue; }
      if (candidate.edge.status === 'Skip' || (settings.evidenceOnly && candidate.edge.status !== 'Qualified')) {
        skips.evidence++;
        continue;
      }
      const group = new Map<string, number>();
      let gross = 0;
      for (const holding of positions.values()) {
        const exposure = Math.max(notional, holding.mark * holding.position.units);
        addStockGroupExposure(group, STOCK_INSTRUMENTS[holding.symbol], exposure);
        gross += exposure;
      }
      if (gross + notional > settings.maxExposure) { skips.exposure++; continue; }
      if (stockGroupExposure(group, STOCK_INSTRUMENTS[symbol]) + notional > settings.maxGroup) { skips.group++; continue; }
      if (event && (costs.leverage ?? 1) > 1 && !event.path?.length) { missingBars++; continue; }
      const position = replayEntry(cash, ask, bid, costs);
      if (!position) { skips.cash++; continue; }
      const basis = cash - position.cash;
      cash = position.cash;
      positions.set(symbol, { symbol, rule, position: { ...position, cash: 0 }, entryDay: day, mark: bid, held: 0, exitOnOpen: false, basis });
    }
  }

  for (const { day } of timeline.benchmark) {
    const morning: Candidate[] = [], earnings: Candidate[] = [];
    const prior = previousStockSession(Date.parse(`${day}T15:00:00Z`));
    for (const symbol of settings.symbols) {
      const holding = positions.get(symbol);
      if (holding) {
        const history = barsFor(symbol, holding.rule);
        const index = history?.index.get(day);
        const bar = index == null ? undefined : history?.bars[index];
        if (!bar) { missingBars++; continue; }
        holding.mark = bar.bidOpen;
      }
      for (const rule of settings.strategies) {
        if (!supportsStockTradeRule(rule, symbol)) continue;
        if (rule === 'earnings-rebound') {
          const event = timeline.stocks.get(symbol)?.events.get(day);
          if (event) earnings.push({ symbol, rule, ask: event.ask, bid: event.path?.[0]?.bidOpen ?? event.ask, event });
          continue;
        }
        const history = barsFor(symbol, rule);
        const index = history?.index.get(day);
        if (!history || index == null || index === 0 || history.bars[index - 1].day !== prior) continue;
        if (stockSignal(history.bars, history.closes, index - 1, rule, null)) {
          const entry = history.bars[index];
          morning.push({ symbol, rule, ask: entry.askOpen, bid: entry.bidOpen });
        }
      }
    }
    const openingEquity = equity();
    const closed = new Set<StockTradeSymbol>();
    for (const holding of positions.values()) {
      const history = barsFor(holding.symbol, holding.rule);
      if (!history?.index.has(day)) continue;
      const stop = replayStop(holding.position.stop, holding.mark, holding.mark);
      if (holding.exitOnOpen || stop != null) {
        close(holding, holding.mark, stop != null);
        closed.add(holding.symbol);
      }
    }
    tryEntries(morning.filter(row => !closed.has(row.symbol)), day, openingEquity);
    tryEntries(earnings.filter(row => !closed.has(row.symbol)), day, openingEquity);
    let observedExposure = 0;
    for (const holding of positions.values()) {
      if (holding.rule === 'earnings-rebound') {
        const event = timeline.stocks.get(holding.symbol)!.events.get(day)!;
        const stop = event.path?.map(bar => replayStop(holding.position.stop, bar.bidOpen, bar.bidLow)).find(price => price != null);
        observedExposure += notional * 350 / 390;
        close(holding, stop ?? event.bid, stop != null);
        continue;
      }
      const history = barsFor(holding.symbol, holding.rule);
      const i = history?.index.get(day);
      observedExposure += Math.max(notional, holding.position.units * holding.mark);
      if (!history || i == null) {
        const fee = holding.position.nightlyFee * replayNights(day);
        cash -= fee;
        holding.basis += fee;
        financing += fee;
        continue;
      }
      const bar = history.bars[i];
      const stop = replayStop(holding.position.stop, bar.bidOpen, bar.low);
      if (stop != null) { close(holding, stop, true); continue; }
      holding.mark = bar.bidClose;
      holding.held++;
      holding.exitOnOpen = stockSignal(history.bars, history.closes, i, holding.rule as DailyStockRule, holding.held);
      if (day === timeline.benchmark.at(-1)?.day) { close(holding, holding.mark); continue; }
      const fee = holding.position.nightlyFee * replayNights(day);
      cash -= fee;
      holding.basis += fee;
      financing += fee;
    }
    const value = equity();
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (peak - value) / peak);
    grossSum += observedExposure;
    curve.push({ day, equity: value });
  }
  const averageExposure = curve.length ? grossSum / curve.length : 0;
  const baseline = timeline.benchmark[0];
  const end = timeline.benchmark.at(-1);
  const spy = baseline && end ? (end.bidClose / baseline.askOpen - 1) * averageExposure / settings.capital : 0;
  return { return: equity() / settings.capital - 1, drawdown, averageExposure, cashReturn: 0, spy, trades, wins, financing, stops,
    skips, missingBars, openAtEnd: positions.size, curve, contribution: [...results].map(([rule, result]) => ({ rule, ...result })) };
}

export function replayStockPortfolio(inputs: StockPortfolioInput[], benchmark: StockBar[], settings: PortfolioReplaySettings, costs: StockReplayCost) {
  const timeline = prepareTimeline(inputs, benchmark, settings);
  const combined = simulate(timeline, settings, costs);
  const stressed = simulate(timeline, settings, stockReplayCosts(costs));
  const standalone = settings.strategies.map(rule => {
    const replay = simulate(timeline, { ...settings, strategies: [rule] }, costs);
    return { rule, return: replay.return, drawdown: replay.drawdown, trades: replay.trades };
  });
  return { ...combined, stressedReturn: stressed.return, standalone, sessions: timeline.benchmark.length,
    missingEvents: inputs.reduce((sum, input) => sum + input.missingEvents, 0) };
}
