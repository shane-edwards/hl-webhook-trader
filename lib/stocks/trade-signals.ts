import type { EtoroClient, IntradayBar } from './etoro';
import { earningsBeforeOpen, type EarningsFiling } from './factor-research';
import { STOCK_CIK } from './fundamentals';
import { regularStockSessions, type StockSession } from './intraday';
import { stockSignal, type DailyStockRule, type StockBar } from './research';
import { previousStockSession, stockMarketClock } from './session';
import { type StockTradeRule, type StockTradeSymbol } from './trade-rules';

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const HALF_HOUR = 30 * MINUTE;
export type StockEntry = { validUntil: number; exitAt: number | null; maxSpread: number; description?: string };

export function regularDailyBars(sessions: StockSession[]): StockBar[] {
  return sessions.map(({ day, bars }) => ({
    day, bidOpen: bars[0].bidOpen, askOpen: bars[0].askOpen, bidClose: bars.at(-1)!.bidClose,
    high: Math.max(...bars.map(bar => bar.bidHigh)),
    low: Math.min(...bars.map(bar => bar.bidLow)),
  }));
}

export function dailyTradeSignal(bars: StockBar[], rule: DailyStockRule, held: number | null) {
  return stockSignal(bars, bars.map(bar => bar.bidClose), bars.length - 1, rule, held);
}

export async function stockTradeDailyBars(broker: EtoroClient, instrumentId: number, rule: DailyStockRule, now: number) {
  if (rule !== 'inside-day') return broker.candles(instrumentId, 240, now, true);
  // This setup was replayed on regular-session prices, so extended-hours prints cannot trigger it.
  const paired = await broker.intradayCandles(instrumentId, now - 120 * DAY, now, undefined, '30m');
  return regularDailyBars(regularStockSessions(paired, 30).sessions.filter(session => session.day < stockMarketClock(now).day));
}

const midpoint = (bar: IntradayBar) => (bar.bidOpen + bar.askOpen) / 2;
export function earningsRebound(stock: IntradayBar[], market: IntradayBar[], filings: EarningsFiling[], now: number): StockEntry | null {
  const clock = stockMarketClock(now);
  const prior = previousStockSession(now);
  if (!clock.open || clock.close !== 960 || clock.minutes < 600 || clock.minutes >= 605 || !prior) return null;
  const open = (series: IntradayBar[]) => series.find(bar => {
    const time = stockMarketClock(bar.t);
    return time.day === clock.day && time.minutes === 570 && bar.t + HALF_HOUR <= now;
  });
  const priorClose = (series: IntradayBar[]) => regularStockSessions(series.filter(bar => stockMarketClock(bar.t).day === prior), 30).sessions[0]?.bars.at(-1);
  const stockOpen = open(stock), spyOpen = open(market), stockPrior = priorClose(stock), spyPrior = priorClose(market);
  if (!stockOpen || !spyOpen || !stockPrior || !spyPrior || stockOpen.t !== spyOpen.t || stockPrior.t !== spyPrior.t
    || !earningsBeforeOpen(filings, stockPrior.t + HALF_HOUR, stockOpen.t)) return null;
  const gap = midpoint(stockOpen) / stockPrior.bidClose - midpoint(spyOpen) / spyPrior.bidClose;
  if (gap > -0.01 || gap <= -0.25) return null;
  return {
    validUntil: stockOpen.t + 35 * MINUTE,
    exitAt: stockOpen.t + 380 * MINUTE,
    maxSpread: 0.001,
    description: `${(gap * 100).toFixed(2)}% opening gap relative to SPY`,
  };
}

export async function recentEarnings(symbol: StockTradeSymbol): Promise<EarningsFiling[]> {
  const cik = STOCK_CIK[symbol];
  if (!cik) return [];
  const response = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, {
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' },
    next: { revalidate: 60 },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('SEC earnings filing data unavailable');
  const { filings: { recent } } = await response.json() as { filings: { recent: {
    form: string[]; acceptanceDateTime: string[]; reportDate: string[]; items: string[];
  } } };
  return recent.form.flatMap((form, i) => {
    const time = Date.parse(recent.acceptanceDateTime[i]);
    const reportDate = recent.reportDate[i];
    return form === '8-K' && recent.items[i]?.split(/[,;]/).some(item => item.trim() === '2.02')
      && Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}$/.test(reportDate) ? [{ time, reportDate }] : [];
  });
}

export function stockEntryWindow(strategy: StockTradeRule, now: number, automatic: boolean) {
  const clock = stockMarketClock(now);
  if (!clock.open) return false;
  if (strategy === 'earnings-rebound') return clock.close === 960 && clock.minutes >= 600 && clock.minutes < 605;
  return (!automatic && strategy !== 'inside-day') || clock.minutes < 600;
}

export async function currentStockEntry(broker: EtoroClient, symbol: StockTradeSymbol, instrumentId: number, strategy: StockTradeRule, now: number): Promise<StockEntry | null> {
  if (!stockEntryWindow(strategy, now, false)) return null;
  if (strategy !== 'earnings-rebound') {
    const bars = await stockTradeDailyBars(broker, instrumentId, strategy, now);
    return bars.at(-1)?.day === previousStockSession(now) && dailyTradeSignal(bars, strategy, null)
      ? { validUntil: now + 120_000, exitAt: null, maxSpread: 0.003 } : null;
  }

  const filings = await recentEarnings(symbol);
  if (!filings.some(filing => filing.time >= now - 5 * DAY && filing.time < now)) return null;
  const spy = await broker.instrument('SPY');
  if (!spy) return null;
  const [stock, market] = await Promise.all([
    broker.intradayCandles(instrumentId, now - 7 * DAY, now, undefined, '30m'),
    broker.intradayCandles(spy.instrumentId, now - 7 * DAY, now, undefined, '30m'),
  ]);
  return earningsRebound(stock, market, filings, now);
}
