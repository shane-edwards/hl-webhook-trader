import type { EtoroClient } from '@/lib/stocks/etoro';
import { freshStockAsk, previousStockSession, stockMarketClock } from '@/lib/stocks/session';
import { observation, observations, record, type Database, type StudyCard } from './journal';

// Fixed forward cohort, verified on 2026-11-27. Do not apply these links to earlier periods.
export const SUPPLIERS = [
  { symbol: 'CRUS', customers: ['AAPL'], sector: 'XLK', source: 'https://www.sec.gov/Archives/edgar/data/772406/000077240626000018/crus-20260328.htm' },
  { symbol: 'LEA', customers: ['GM', 'F'], sector: 'XLY', source: 'https://www.sec.gov/Archives/edgar/data/842162/000084216226000011/lear-20251231.htm' },
  { symbol: 'MAS', customers: ['HD'], sector: 'XLI', source: 'https://www.sec.gov/Archives/edgar/data/62996/000006299626000005/mas-20251231.htm' },
  { symbol: 'CPB', customers: ['WMT'], sector: 'XLP', source: 'https://www.sec.gov/Archives/edgar/data/16732/000001673226000026/cpb-20260802.htm' },
  { symbol: 'MCK', customers: ['CVS'], sector: 'XLV', source: 'https://www.sec.gov/Archives/edgar/data/927653/000092765326000069/mck-20260331.htm' },
];
export type StockFeed = Pick<EtoroClient, 'instrument' | 'quotes' | 'candles'>;
export type Quote = { bid: number; ask: number; time: string };
type Basket = { top: string; bottom: string; sector: string; ranks: { symbol: string; momentum: number }[]; quotes: Record<string, Quote> };
const series = (user: string) => 'supplier-momentum-v1:' + user;
export const stockFee = 0.0005;
export const priceReturn = (entry: Quote, exit: Quote) => exit.bid * (1 - stockFee) / (entry.ask * (1 + stockFee)) - 1;

export async function stockQuotes(feed: StockFeed, symbols: string[], now: () => number) {
  const instruments = await Promise.all(symbols.map(async symbol => {
    const instrument = await feed.instrument(symbol);
    if (!instrument) throw new Error('Instrument unavailable: ' + symbol);
    return { symbol, id: instrument.instrumentId };
  }));
  const rates = await feed.quotes(instruments.map(i => i.id));
  const quotes: Record<string, Quote> = {};
  for (const { symbol, id } of instruments) {
    const rate = rates.find(r => r.instrumentId === id);
    if (!rate || !freshStockAsk(rate, now())) throw new Error('Waiting for a current ' + symbol + ' quote');
    quotes[symbol] = { bid: rate.bid!, ask: rate.ask!, time: rate.date! };
  }
  return quotes;
}

export function supplierWindow(now: number) {
  const clock = stockMarketClock(now);
  const last = previousStockSession(now);
  return clock.open && clock.minutes < 585 && !!last && last.slice(0, 7) !== clock.day.slice(0, 7) && clock.day > '2026-11-27';
}

export async function captureSuppliers(db: Database, user: string, feed: StockFeed, time: number, now = Date.now) {
  if (!supplierWindow(time)) return;
  const day = stockMarketClock(time).day;
  if (await observation(db, series(user), day)) return;
  const end = previousStockSession(time)!;
  const start = previousStockSession(Date.parse(end.slice(0, 7) + '-01T17:00:00Z'));
  const returns = new Map<string, number>();
  await Promise.all([...new Set(SUPPLIERS.flatMap(s => s.customers))].map(async symbol => {
    const instrument = await feed.instrument(symbol);
    if (!instrument) throw new Error('Customer prices unavailable: ' + symbol);
    const bars = await feed.candles(instrument.instrumentId, 70, time, true, true);
    const a = bars.find(b => b.day === start)?.bidClose, b = bars.find(b => b.day === end)?.bidClose;
    if (!a || !b) throw new Error('Month-end price missing: ' + symbol);
    returns.set(symbol, b / a - 1);
  }));
  const ranks = SUPPLIERS.map(s => ({ symbol: s.symbol, momentum: s.customers.reduce((sum, c) => sum + returns.get(c)!, 0) / s.customers.length }))
    .sort((a,b) => b.momentum - a.momentum || a.symbol.localeCompare(b.symbol));
  const top = ranks[0].symbol, bottom = ranks[ranks.length - 1].symbol;
  const sector = SUPPLIERS.find(s => s.symbol === top)!.sector;
  const [previous] = await observations<Basket>(db, series(user), 1);
  const previousSymbols = previous ? [previous.detail.top, previous.detail.bottom, previous.detail.sector] : [];
  const symbols = [...new Set([...SUPPLIERS.map(row => row.symbol), sector, ...previousSymbols])];
  const quotes = await stockQuotes(feed, symbols, now);
  if (!supplierWindow(now()) || Object.values(quotes).some(q => !supplierWindow(Date.parse(q.time)))) return;
  await record(db, series(user), day, now(), { top, bottom, sector, ranks, quotes } satisfies Basket);
}

export async function supplierReport(db: Database, user: string, connected: boolean): Promise<StudyCard> {
  const rows = await observations<Basket>(db, series(user), 240);
  const latest = rows[0];
  const results = rows.slice(0, -1).map((exit, i) => {
    const entry = rows[i + 1], b = entry.detail;
    const month = (day: string) => Number(day.slice(0,4)) * 12 + Number(day.slice(5,7));
    const gap = month(exit.day) - month(entry.day) !== 1;
    const result = (symbol: string) => gap ? null : priceReturn(b.quotes[symbol], exit.detail.quotes[symbol]);
    return { date: exit.day, label: b.top + ' vs ' + b.bottom, net: result(b.top), control: result(b.bottom),
      benchmark: result(b.sector), note: gap ? 'Missed rebalance' : b.sector + ' sector benchmark' };
  });
  // Rerank the original cohort with each customer and its linked suppliers removed.
  // Compare identical, fully observed months in every alternative.
  const customers = [...new Set(SUPPLIERS.flatMap(row => row.customers))];
  const months = rows.slice(0,-1).map((exit,i) => ({ exit, entry: rows[i+1], scored: results[i].net != null }))
    .filter(m => m.scored && SUPPLIERS.every(s => m.entry.detail.quotes[s.symbol] && m.exit.detail.quotes[s.symbol]));
  const excluded = months.length < 2 ? [] : customers.map(customer => {
    let sum = 0;
    for (const { entry,exit } of months) {
      const ranks = entry.detail.ranks.filter(r => !SUPPLIERS.find(s => s.symbol === r.symbol)!.customers.includes(customer));
      const first = ranks[0].symbol, last = ranks[ranks.length-1].symbol;
      sum += priceReturn(entry.detail.quotes[first],exit.detail.quotes[first]) - priceReturn(entry.detail.quotes[last],exit.detail.quotes[last]);
    }
    return { customer, excess: sum / months.length };
  }).sort((a,b) => a.excess - b.excess);
  const weakest = excluded[0];
  return { id: 'supplier', name: 'Supplier momentum', status: !connected ? 'Demo market data needed' : latest ? 'Last selection · ' + latest.detail.top + ' on ' + latest.day : 'Waiting for the first monthly rebalance',
    rule: 'Each month, follow the strongest customer trend among five suppliers. Buy at the ask and sell at the bid on the first trading morning. Price returns include a modeled 0.05% fee per side and exclude dividends.',
    comparison: 'Weakest supplier and sector ETF', results, needsConnection: !connected,
    sensitivity: weakest && { label: 'Smallest lead after removing one customer', value: weakest.excess,
      detail: weakest.customer + ' removed · ' + months.length + ' months' } };
}
