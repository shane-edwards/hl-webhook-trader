import { unzipSync } from 'fflate';
import { setTimeout as wait } from 'node:timers/promises';
import type { createServiceClient } from '@/lib/supabase/server';
import { stockFeed } from '@/lib/automation/research';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { regularStockSessions } from '@/lib/stocks/intraday';
import { EtoroError } from '@/lib/stocks/etoro';
import { STOCK_INSTRUMENTS, isStockTradeSymbol } from '@/lib/stocks/trade-rules';
import { CATALYST_INSTRUMENTS, CATALYST_UNIVERSE } from '@/lib/stocks/catalyst-universe';
import type { EtoroClient } from '@/lib/stocks/etoro';
import { BAR_MS, searchKey, type Experiment, type ForwardBook, type SearchBar, type SearchPair } from './model';
import { attachContext, stockContext, type DailyContext, type EpsFact } from './context';
import { positioningContext } from './crypto-context';
import { archivePositioning, type PositionDay } from './positioning';
import { advanceForward, checkPerpVenue, searchHistory } from './engine';

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

function spotBar(values: Array<string | number>): SearchBar | null {
  const [stamp, o, h, l, c, v] = values.slice(0, 6).map(Number);
  const t = stamp > 10 ** 14 ? Math.floor(stamp / 1000) : stamp;
  return Number.isFinite(t) && [o, h, l, c].every(value => Number.isFinite(value) && value > 0) &&
    h >= Math.max(o, c) && l <= Math.min(o, c) ? { t, o, h, l, c, v } : null;
}

async function recentSpot(pair: SearchPair, after: number, now: number) {
  const step = BAR_MS[pair.frame];
  const close = Math.floor(now / step) * step;
  const pages = Array.from({ length: Math.ceil(Math.max(0, close - after) / (1000 * step)) }, (_, i) => after + i * step * 1000);
  return (await inBatches(pages, 5, async start => {
    const query = new URLSearchParams({ symbol: `${pair.symbol}USDT`, interval: pair.frame, startTime: String(start),
      endTime: String(Math.min(close, start + 1000 * step) - 1), limit: '1000' });
    const response = await fetch(`https://data-api.binance.vision/api/v3/klines?${query}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('Recent Binance candles are temporarily unavailable.');
    const rows: Array<Array<string | number>> = await response.json();
    if (!Array.isArray(rows)) throw new Error('Recent Binance candles are temporarily unavailable.');
    return rows.flatMap(row => {
      const bar = spotBar(row);
      return bar && bar.t >= start && bar.t + step <= close ? [bar] : [];
    });
  })).flat();
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
    return csv.trim().split('\n').flatMap(line => spotBar(line.split(',', 6)) ?? []);
  });
  const bars = assemble(chunks.flat());
  const last = bars.at(-1);
  if (!last || now - last.t > 70 * DAY) return [];
  const step = BAR_MS[pair.frame];
  const complete = assemble([...bars, ...await recentSpot(pair, last.t + step, now)]);
  if (now - complete.at(-1)!.t > 3 * step) throw new Error('Recent Binance candles are temporarily unavailable.');
  return complete;
}

async function pairedStocks(broker: EtoroClient, pair: SearchPair, now: number): Promise<SearchBar[]> {
  if (!isStockTradeSymbol(pair.symbol)) return [];
  const instrument = STOCK_INSTRUMENTS[pair.symbol];
  if (pair.frame === '1d') {
    const days = await broker.candles(instrument, 3 * 365 + 30, now, true, false, 15_000, true);
    if (!days.length || now - Date.parse(days.at(-1)!.day) > 8 * DAY ||
      days.some((row,i) => i > 0 && Date.parse(row.day) - Date.parse(days[i-1].day) > 10 * DAY)) return [];
    return days.map(row => ({ t: Date.parse(row.day), o: row.bidOpen, h: row.high, l: row.low, c: row.bidClose, ask: row.askOpen,
      askHigh: row.askHigh, askLow: row.askLow, askClose: row.askClose, v: 0 }));
  }
  const interval = pair.frame === '5m' ? 5 : 30;
  const count = interval === 5 ? 6 : 8;
  const span = (interval === 5 ? 27 : 145) * DAY;
  const ends = Array.from({ length: count }, (_, i) => now - (count - 1 - i) * span);
  let nextRequest = 0;
  const pace = async () => {
    const at = Math.max(nextRequest, Date.now());
    nextRequest = at + 180;
    await wait(Math.max(0, at - Date.now()));
  };
  const quotes = await inBatches(ends, 2, async end => {
    const load = () => broker.intradayCandles(instrument, end - span, end, pace, `${interval}m`, false, 10_000, true);
    try {
      return await load();
    } catch (error) {
      if (!(error instanceof EtoroError) || ![502, 503, 504].includes(error.status)) throw error;
      await wait(500);
      return load();
    }
  });
  const { sessions } = regularStockSessions(quotes.flat(), interval);
  const last = sessions.at(-1);
  if (!last || now - last.bars[0].t > 8 * DAY || sessions.some((session, index) => index > 0 && Date.parse(session.day) - Date.parse(sessions[index - 1].day) > 10 * DAY)) return [];
  return sessions.flatMap(session => session.bars.map(row => ({ t: row.t, o: row.bidOpen, h: row.bidHigh, l: row.bidLow,
    c: row.bidClose, v: row.volume, ask: row.askOpen, askHigh: row.askHigh, askLow: row.askLow, askClose: row.askClose, session: session.day })));
}

async function stockHistory(db: Db, user: string, pair: SearchPair, now: number) {
  const broker = await stockFeed(db, user);
  const market = CATALYST_UNIVERSE.find(item => item.symbol === pair.symbol);
  if (!market) return pairedStocks(broker, pair, now);
  const closes = (symbol: string) => broker.candles(CATALYST_INSTRUMENTS[symbol], 1200, now, true, true, 7000).catch(() => []);
  async function epsFacts(cik: number): Promise<EpsFact[]> {
    const id = String(cik).padStart(10,'0');
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${id}/us-gaap/EarningsPerShareDiluted.json`, {
      headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'Tideframe Research (https://hl-webhook-trader.vercel.app)' },
      next: { revalidate: 86400 }, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const rows = (await res.json()).units?.['USD/shares'];
    return Array.isArray(rows) ? rows : [];
  }
  const [bars, stock, sector, facts] = await Promise.all([pairedStocks(broker, pair, now),
    pair.frame === '1d' ? [] : closes(pair.symbol), closes(market.etf), epsFacts(market.cik).catch(() => [])]);
  const daily = pair.frame === '1d' ? bars.map(b => ({ day: new Date(b.t).toISOString().slice(0,10), bidClose: b.c })) : stock;
  return attachContext(bars, stockContext(bars, daily, sector, facts));
}

async function perpetualBars(pair: SearchPair, now: number): Promise<SearchBar[]> {
  // A transfer check using actual perp data and observed funding, independent of choosing the rule.
  const frame = pair.frame === '30m' ? '15m' : pair.frame;
  try {
    const client = marketDataClient();
    // Daily rules need enough actual perpetual sessions to satisfy the same venue sample gate.
    const since = Math.max(now - (frame === '1d' ? 900 : 120) * DAY, now - 4980 * BAR_MS[frame]);
    const [bars, funding] = await Promise.all([
      client.getCandles(pair.symbol, frame, since, now),
      client.getFundingRates(pair.symbol, since, now),
    ]);
    const expected = Math.floor((now - since) / HOUR);
    if (new Set(funding.map(row => Math.round(row.time / HOUR))).size < .95 * expected) throw new Error('Incomplete funding history');
    const settlements = new Map(funding.map(row => [Math.round(row.time / HOUR) * HOUR, row.rate]));
    const bucket = new Map<number, { funding: number; shortFunding: number; count: number }>();
    for (const [settled, rate] of settlements) {
      const t = Math.floor((settled - 1) / BAR_MS[frame]) * BAR_MS[frame];
      const costs = bucket.get(t) ?? { funding: 0, shortFunding: 0, count: 0 };
      costs.funding += Math.max(0, rate);
      costs.shortFunding += Math.max(0, -rate);
      costs.count++;
      bucket.set(t, costs);
    }
    return bars.filter(row => row.t + BAR_MS[frame] <= now && (bucket.get(row.t)?.count ?? 0) ===
      Math.floor((row.t + BAR_MS[frame]) / HOUR) - Math.floor(row.t / HOUR)).map(row => ({ ...row, ...bucket.get(row.t) }));
  } catch {
    return [];
  }
}

export async function runSearch(db: Db, user: string, pair: SearchPair, asOf: string) {
  const now = Date.parse(asOf);
  async function loadPositioning() {
    if (pair.market !== 'crypto') return { context:new Map() as DailyContext, tail:undefined };
    const { data, error } = await db.from('automation_runs').select('tail:work->0->positioning')
      .eq('user_id',user).eq('market','crypto').eq('kind','focused').eq('status','completed')
      .like('idea_id',`search:crypto:${pair.symbol}:%`).not('work->0->positioning','is',null)
      .order('completed_at',{ascending:false}).limit(1).maybeSingle();
    if (error) throw new Error('Could not read positioning history.');
    return archivePositioning(pair.symbol,now,(data?.tail ?? []) as unknown as PositionDay[]);
  }
  const [last, history, positioning] = await Promise.all([
    db.from('automation_runs').select('books:report->data->search->forward,experiments:work->0->experiments,cutoff:work->0->discoveryThrough').eq('user_id', user)
      .eq('market', pair.market).eq('kind', 'focused').eq('idea_id', searchKey(pair)).eq('status', 'completed')
      .order('completed_at', { ascending: false }).limit(8),
    pair.market === 'stocks' ? stockHistory(db, user, pair, now) : binanceArchive(pair, now),
    loadPositioning(),
  ]);
  if (last.error) throw new Error('Could not read frozen forward strategies.');
  const previous = (last.data[0]?.books ?? []) as unknown as ForwardBook[];
  if (!Array.isArray(previous)) throw new Error('Invalid forward simulation checkpoint.');
  if (pair.market === 'crypto') attachContext(history, positioning.context);
  const discoveryThrough = history[Math.floor(history.length * .44) - 1]?.t ?? 0;
  const archive = last.data.flatMap(r => Number(r.cutoff) <= discoveryThrough && Array.isArray(r.experiments) ? r.experiments : []) as unknown as Experiment[];
  const experiments: Experiment[] = [];
  let report = searchHistory(pair, history, pair.market === 'stocks' ? 'eToro bid/ask cash-stock history' : 'Binance spot candles',
    { previous: archive, record: experiments });
  let forwardBars = history;
  if (pair.market === 'crypto' && (report.verdict === 'paper-candidate' || previous.some(b => b.state === 'tracking' || b.state === 'data-gap'))) {
    forwardBars = attachContext(await perpetualBars(pair, now), positioning.context);
    // Preserve the data source of any frozen rule from the original Bybit release.
    if (previous.some(b => ['tracking','data-gap'].includes(b.state) && ['fundingChange','openInterest'].includes(b.rule.recipe?.context ?? '')))
      attachContext(forwardBars, await positioningContext(pair.symbol,now));
    report = checkPerpVenue(report, forwardBars);
  }
  return { search: { ...report, forward: advanceForward(report, previous, forwardBars, Date.now()) }, experiments, discoveryThrough,
    positioning:positioning.tail };
}
