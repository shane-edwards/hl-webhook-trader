import type { EtoroClient } from './etoro';
import { prepareStockOrder, type StockSizing } from './leverage';
import { freshStockAsk, previousStockSession, stockMarketClock } from './session';
import { currentStockEntry, dailyStockEntry, stockEntryWindow, stockTradeDailyBars, type StockEntry } from './trade-signals';
import { STOCK_INSTRUMENTS, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, supportsStockTradeRule, type StockTradeRule, type StockTradeSymbol } from './trade-rules';
import { stockEdgeEvidence, stockRegime, type EvidenceTrade, type StockMarketRegime } from './evidence-model';
import edgeStudy from './edge-evidence.json';

type SignalMatch = { symbol: StockTradeSymbol; rule: StockTradeRule; signal: StockEntry };
type Quote = Awaited<ReturnType<EtoroClient['quotes']>>[number];
type ScanOptions = { symbols?: readonly StockTradeSymbol[]; rules?: readonly StockTradeRule[]; automatic?: boolean;
  slippageBySymbol?: Partial<Record<StockTradeSymbol, { samples: number; slipBps: number | null }>> };
type Cost = Awaited<ReturnType<EtoroClient['stockOrderCosts']>>[number];
const evidenceRank = { Qualified: 0, Watch: 1, Skip: 2 };

export function estimatedStockEntryCost(costs: Cost[], spreadBps: number, exposure: number) {
  const extra = costs.filter(cost => cost.currency.toUpperCase() === 'USD' && ['markup', 'transactionFee', 'sdrt'].includes(cost.costType))
    .reduce((sum, cost) => sum + Math.max(0, cost.value), 0);
  // The quoted spread already captures the bid/ask difference.
  return spreadBps * exposure / 10_000 + extra;
}

export async function scanStockSetups(broker: EtoroClient, sizing: StockSizing, options: ScanOptions = {}, now = Date.now()) {
  const clock = stockMarketClock(now);
  const symbols = options.symbols ?? STOCK_TRADE_SYMBOLS;
  const rules = options.rules ?? STOCK_TRADE_RULES.map(rule => rule.id);
  const planned = symbols.flatMap(symbol => rules.filter(rule => supportsStockTradeRule(rule, symbol)).map(rule => ({ symbol, rule })));
  const inWindow = planned.filter(({ rule }) => stockEntryWindow(rule, now, options.automatic ?? false));
  const matches: SignalMatch[] = [];
  const unavailable = new Set<string>();
  let evaluated = 0, spreadSkipped = 0, estimateSkipped = 0;
  const rows = [];
  const prior = previousStockSession(now);
  // Share the previous close between rules. Keep the SEC and broker reads in bounded batches.
  const enabledSymbols = [...new Set(inWindow.map(item => item.symbol))];
  for (let offset = 0; offset < enabledSymbols.length; offset += 6) {
    await Promise.all(enabledSymbols.slice(offset, offset + 6).map(async symbol => {
      const id = STOCK_INSTRUMENTS[symbol];
      const strategies = inWindow.filter(item => item.symbol === symbol);
      const daily = strategies.some(({ rule }) => rule === 'breakout' || rule === 'pullback')
        ? stockTradeDailyBars(broker, id, 'breakout', now).catch(() => null) : null;
      await Promise.all(strategies.map(async ({ rule }) => {
        try {
          let signal: StockEntry | null;
          if (rule === 'earnings-rebound') {
            signal = await currentStockEntry(broker, symbol, id, rule, now);
          } else {
            const bars = rule === 'inside-day' ? await stockTradeDailyBars(broker, id, rule, now) : await daily;
            if (!bars || bars.length < (rule === 'inside-day' ? 51 : 101) || bars.at(-1)?.day !== prior) throw new Error('Incomplete price history');
            signal = dailyStockEntry(bars, rule, now);
          }
          evaluated++;
          if (signal) matches.push({ symbol, rule, signal });
        } catch {
          unavailable.add(symbol);
        }
      }));
    }));
  }
  const ids = [...new Set(matches.map(match => STOCK_INSTRUMENTS[match.symbol]))];
  let regime: StockMarketRegime | null = null;
  if (ids.length) {
    const [quotes, eligibility, spy] = await Promise.all([broker.quotes(ids), broker.stockOrderOptionsFor(ids),
      stockTradeDailyBars(broker, STOCK_INSTRUMENTS.SPY, 'inside-day', now).catch(() => [])]);
    regime = spy.at(-1)?.day === prior ? stockRegime(spy) : null;
    const assess = (candidate: SignalMatch, frictionBps: number, slipBps: number, spreadBps: number) => {
      const edge = stockEdgeEvidence(edgeStudy.trades as EvidenceTrade[], candidate.symbol, candidate.rule, regime,
        candidate.rule === 'earnings-rebound' ? clock.minutes < 605 : clock.minutes < 600, frictionBps, sizing.leverage, slipBps, spreadBps);
      return sizing.leverage === 1 ? edge
        : { ...edge, status: 'Watch' as const, reason: 'Use a leveraged replay to validate this stop and financing assumption' };
    };
    const compare = (a: { evidence: ReturnType<typeof assess> }, b: { evidence: ReturnType<typeof assess> }) =>
      evidenceRank[a.evidence.status] - evidenceRank[b.evidence.status]
        || (b.evidence.lowerBps ?? -Infinity) - (a.evidence.lowerBps ?? -Infinity);
    const byId = new Map(quotes.map(quote => [quote.instrumentId, quote]));
    const candidates = matches.flatMap(match => {
      const id = STOCK_INSTRUMENTS[match.symbol];
      const quote: Quote | undefined = byId.get(id);
      const ask = freshStockAsk(quote, Date.now());
      if (!ask || !quote?.bid || (ask - quote.bid) / ask > match.signal.maxSpread) { spreadSkipped++; return []; }
      const spreadBps = (ask - quote.bid) * 10_000 / ask;
      const calibration = options.slippageBySymbol?.[match.symbol];
      const slipBps = Math.max(3, calibration?.slipBps ?? 0);
      return [{ ...match, id, ask, bid: quote.bid, spreadBps, slipBps, journalSamples: calibration?.samples ?? 0,
        evidence: assess(match, spreadBps, slipBps, spreadBps) }];
    }).sort((a, b) => compare(a, b) || a.spreadBps - b.spreadBps || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
    // Price the strongest preliminary candidates first and leave quota for order reviews.
    const estimates = new Map<number, Promise<{ costs: Cost[] } | null>>();
    const execution = new Map<number, ReturnType<typeof prepareStockOrder>>();
    for (const candidate of candidates) {
      if (estimates.has(candidate.id)) continue;
      if (estimates.size >= 10) break;
      try {
        const order = prepareStockOrder(candidate.id, candidate, eligibility.get(candidate.id) ?? [], sizing);
        execution.set(candidate.id, order);
        estimates.set(candidate.id, broker.stockOrderCosts(order).then(costs => ({ costs })).catch(() => null));
      } catch {
        estimates.set(candidate.id, Promise.resolve(null));
      }
    }
    for (const candidate of candidates) {
      const estimate = await estimates.get(candidate.id);
      if (!estimate) { estimateSkipped++; continue; }
      const readyAt = Date.now();
      if (!freshStockAsk(byId.get(candidate.id), readyAt) || readyAt >= candidate.signal.validUntil
          || !stockEntryWindow(candidate.rule, readyAt, options.automatic ?? false)) { spreadSkipped++; continue; }
      const exposure = sizing.amount * sizing.leverage;
      const entryCost = estimatedStockEntryCost(estimate.costs, candidate.spreadBps, exposure);
      const evidence = assess(candidate, 2 * entryCost * 10_000 / exposure - candidate.spreadBps, candidate.slipBps, candidate.spreadBps);
      rows.push({ ...candidate, quoteAt: byId.get(candidate.id)!.date, execution: execution.get(candidate.id)!,
        costs: estimate.costs, entryCost, evidence });
    }
    rows.sort((a, b) => compare(a, b) || a.entryCost - b.entryCost || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
  }
  return { rows, day: clock.day, open: clock.open, planned: planned.length, evaluated, outsideWindow: planned.length - inWindow.length,
    unavailable: [...unavailable].sort(), spreadSkipped, estimateSkipped, scannedAt: new Date().toISOString(),
    evidenceThrough: edgeStudy.through, regime };
}

export type StockSetupScan = Awaited<ReturnType<typeof scanStockSetups>>;
