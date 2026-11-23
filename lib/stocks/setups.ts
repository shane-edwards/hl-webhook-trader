import type { EtoroClient } from './etoro';
import { prepareStockOrder, type StockSizing } from './leverage';
import { freshStockAsk, previousStockSession, stockMarketClock } from './session';
import { currentStockEntry, dailyStockEntry, stockEntryWindow, stockTradeDailyBars, type StockEntry } from './trade-signals';
import { STOCK_INSTRUMENTS, STOCK_TRADE_RULES, STOCK_TRADE_SYMBOLS, supportsStockTradeRule, type StockTradeRule, type StockTradeSymbol } from './trade-rules';

type SignalMatch = { symbol: StockTradeSymbol; rule: StockTradeRule; signal: StockEntry };
type Quote = Awaited<ReturnType<EtoroClient['quotes']>>[number];
type ScanOptions = { symbols?: readonly StockTradeSymbol[]; rules?: readonly StockTradeRule[]; automatic?: boolean };
type Cost = Awaited<ReturnType<EtoroClient['stockOrderCosts']>>[number];

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
  if (ids.length) {
    const [quotes, eligibility] = await Promise.all([broker.quotes(ids), broker.stockOrderOptionsFor(ids)]);
    const byId = new Map(quotes.map(quote => [quote.instrumentId, quote]));
    const candidates = matches.flatMap(match => {
      const id = STOCK_INSTRUMENTS[match.symbol];
      const quote: Quote | undefined = byId.get(id);
      const ask = freshStockAsk(quote, Date.now());
      if (!ask || !quote?.bid || (ask - quote.bid) / ask > match.signal.maxSpread) { spreadSkipped++; return []; }
      return [{ ...match, id, ask, bid: quote.bid, spreadBps: (ask - quote.bid) * 10_000 / ask }];
    }).sort((a, b) => a.spreadBps - b.spreadBps || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
    // Price candidates with the tightest quoted spreads first. Leave quota for actual order reviews.
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
      rows.push({ ...candidate, quoteAt: byId.get(candidate.id)!.date, execution: execution.get(candidate.id)!,
        costs: estimate.costs, entryCost: estimatedStockEntryCost(estimate.costs, candidate.spreadBps, exposure) });
    }
  }
  rows.sort((a, b) => a.entryCost - b.entryCost || a.symbol.localeCompare(b.symbol) || a.rule.localeCompare(b.rule));
  return { rows, day: clock.day, open: clock.open, planned: planned.length, evaluated, outsideWindow: planned.length - inWindow.length,
    unavailable: [...unavailable].sort(), spreadSkipped, estimateSkipped, scannedAt: new Date().toISOString() };
}

export type StockSetupScan = Awaited<ReturnType<typeof scanStockSetups>>;
