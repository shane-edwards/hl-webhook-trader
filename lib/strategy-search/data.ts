import { unzipSync } from 'fflate';
import type { createServiceClient } from '@/lib/supabase/server';
import { stockFeed } from '@/lib/automation/research';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { STOCK_INSTRUMENTS, isStockTradeSymbol } from '@/lib/stocks/trade-rules';
import { BAR_MS, type SearchBar, type SearchPair } from './model';
import { checkPerpVenue, searchHistory } from './engine';

type Db = ReturnType<typeof createServiceClient>;
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function inBatches<T, R>(items: T[], size: number, load: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...await Promise.all(items.slice(i, i + size).map(load)));
  return results;
}

function assemble(bars: SearchBar[]) {
  return [...new Map(bars.map(row => [row.t, row])).values()].sort((a, b) => a.t - b.t);
}

export async function binanceArchive(pair: SearchPair, now: number) {
  const date = new Date(now);
  const months = Array.from({ length: 37 }, (_, i) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 37 + i, 1)).toISOString().slice(0, 7));
  const symbol = `${pair.symbol}USDT`;
  const chunks = await inBatches(months, 6, async month => {
    const archive = `${symbol}-${pair.frame}-${month}`;
    const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${pair.frame}/${archive}.zip`;
    const response = await fetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error('The Binance archive is temporarily unavailable.');
    const entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
    if (!entries[`${archive}.csv`]) throw new Error('The Binance archive returned an unexpected file.');
    const csv = new TextDecoder().decode(entries[`${archive}.csv`]);
    return csv.trim().split('\n').map(line => {
      const fields = line.split(',', 6).map(Number);
      const [stamp, o, h, l, c, v] = fields;
      return { t: stamp > 10 ** 14 ? Math.round(stamp / 1000) : stamp, o, h, l, c, v };
    }).filter(row => Number.isFinite(row.t) && [row.o, row.h, row.l, row.c].every(value => value > 0) &&
      row.h >= Math.max(row.o, row.c) && row.l <= Math.min(row.o, row.c));
  });
  const bars = assemble(chunks.flat());
  // A good old archive alone cannot make a current venue relevant.
  if (bars.length && now - bars.at(-1)!.t > 70 * DAY) return [];
  return bars;
}

async function pairedStocks(db: Db, user: string, pair: SearchPair, now: number): Promise<SearchBar[]> {
  if (!isStockTradeSymbol(pair.symbol)) return [];
  const broker = await stockFeed(db, user);
  const instrument = STOCK_INSTRUMENTS[pair.symbol];
  if (pair.frame === '1d') {
    const days = await broker.candles(instrument, 3 * 365 + 30, now, true, false, 15_000);
    return days.map(row => ({ t: Date.parse(row.day), o: row.bidOpen, h: row.high, l: row.low, c: row.bidClose, ask: row.askOpen, v: 0 }));
  }
  const interval = pair.frame === '5m' ? 5 : 30;
  const count = interval === 5 ? 6 : 7;
  const span = (interval === 5 ? 28 : 165) * DAY;
  const ends = Array.from({ length: count }, (_, i) => now - (count - 1 - i) * span);
  const quotes = await inBatches(ends, 3, end => broker.intradayCandles(instrument, end - span, end, undefined, `${interval}m`, false, 12_000));
  const { sessions } = regularStockSessions(quotes.flat(), interval);
  const last = sessions.at(-1);
  if (!last || now - last.bars[0].t > 8 * DAY || sessions.some((session, index) => index > 0 && Date.parse(session.day) - Date.parse(sessions[index - 1].day) > 10 * DAY)) return [];
  return sessions.flatMap(session => session.bars.map(row => ({ t: row.t, o: row.bidOpen, h: row.bidHigh, l: row.bidLow,
    c: row.bidClose, v: row.volume, ask: row.askOpen, session: session.day })));
}

export async function runSearch(db: Db, user: string, pair: SearchPair, asOf: string) {
  const now = Date.parse(asOf);
  if (pair.market === 'stocks') return searchHistory(pair, await pairedStocks(db, user, pair, now), 'eToro bid/ask cash-stock history');
  const report = searchHistory(pair, await binanceArchive(pair, now), 'Binance archived spot candles');
  if (report.verdict !== 'paper-candidate') return report;
  // A transfer check using actual perp data and observed funding, independent of choosing the rule.
  const frame = pair.frame === '30m' ? '15m' : pair.frame;
  try {
    const client = marketDataClient();
    const since = Math.max(now - 120 * DAY, now - 4980 * BAR_MS[frame]);
    const [bars, funding] = await Promise.all([
      client.getCandles(pair.symbol, frame, since, now),
      client.getFundingRates(pair.symbol, since, now),
    ]);
    const expected = Math.floor((now - since) / HOUR);
    if (new Set(funding.map(row => Math.round(row.time / HOUR))).size < .95 * expected) throw new Error('Incomplete funding history');
    const bucket = new Map<number, number>();
    for (const payment of funding) {
      const t = Math.floor(Math.round(payment.time / HOUR) * HOUR / BAR_MS[frame]) * BAR_MS[frame];
      bucket.set(t, (bucket.get(t) ?? 0) + Math.max(0, payment.rate));
    }
    return checkPerpVenue(report, bars.filter(row => row.t + BAR_MS[frame] <= now).map(row => ({ ...row, funding: bucket.get(row.t) ?? 0 })));
  } catch {
    return { ...report, verdict: 'venue-failed' as const, note: 'Hyperliquid prices or funding are unavailable' };
  }
}
