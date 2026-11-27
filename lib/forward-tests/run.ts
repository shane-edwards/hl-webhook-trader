import { strFromU8, unzipSync } from 'fflate';
import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import seed from './positioning-seed.json';
import { advance, COINS, DAY, dayStart, entrySignal, isoDay, scoreline, stopPrice, STRATEGY, TESTED_COINS, tradeResult,
  type DayBar, type Positioning, type Side } from './crowded-break';

type Db = ReturnType<typeof createServiceClient>;

export interface ForwardFeed {
  /** The reading for one coin and UTC day, or null when Binance has not published that day yet. */
  positioning(symbol: string, day: number): Promise<Positioning | null>;
  dailyBars(symbol: string, from: number, through: number): Promise<DayBar[]>;
  /** Hourly funding rates on the traded venue between two times. */
  funding(symbol: string, from: number, to: number): Promise<number[]>;
}

/** Binance's public daily archive: the last valid row between 22:45 and 23:00 UTC, as the study used. */
async function binancePositioning(symbol: string, day: number): Promise<Positioning | null> {
  const iso = isoDay(day), name = `${symbol}USDT-metrics-${iso}`;
  const response = await fetch(`https://data.binance.vision/data/futures/um/daily/metrics/${symbol}USDT/${name}.zip`,
    { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Positioning archive ${response.status}`);
  const file = unzipSync(new Uint8Array(await response.arrayBuffer()))[name + '.csv'];
  if (!file) throw new Error('Positioning archive is empty');
  let best: { at: string; oi: number; ratio: number } | null = null;
  for (const line of strFromU8(file).split('\n')) {
    const cells = line.split(',');
    if (cells.length < 7 || !cells[0].startsWith(iso)) continue;
    const at = cells[0].slice(11, 16), oi = Number(cells[2]), ratio = Number(cells[6]);
    if (at < '22:45' || at > '23:00' || !(oi > 0) || !(ratio > 0)) continue;
    if (!best || at >= best.at) best = { at, oi, ratio };
  }
  return best && { oi: best.oi, ratio: best.ratio };
}

export function liveFeed(): ForwardFeed {
  const hl = marketDataClient();
  return {
    positioning: binancePositioning,
    dailyBars: async (symbol, from, through) => {
      const bars: DayBar[] = (await hl.getCandles(symbol, '1d', from, through + DAY - 1))
        .filter(bar => bar.t % DAY === 0 && [bar.o, bar.h, bar.l, bar.c].every(v => Number.isFinite(v) && v > 0));
      // The client returns completed candles only. The day still forming is needed for its open alone,
      // which is the open of its first completed five-minute candle.
      const today = dayStart(Date.now());
      if (today <= through && !bars.some(bar => bar.t === today)) {
        const first = (await hl.getCandles(symbol, '5m', today, today + 5 * 60_000 - 1)).find(bar => bar.t === today);
        if (first && first.o > 0) bars.push({ t: today, o: first.o, h: first.o, l: first.o, c: first.o });
      }
      return bars;
    },
    funding: async (symbol, from, to) => (await hl.getFundingRates(symbol, from, to)).filter(row => row.time >= from && row.time < to).map(row => row.rate),
  };
}

const seedDays = seed.days.map(day => Date.parse(day + 'T00:00:00Z'));
const seedCoins = seed.coins as unknown as Record<string, Array<[number, number] | null>>;
export const SEED_THROUGH = seedDays[seedDays.length - 1];

function seedHistory(symbol: string) {
  const history = new Map<number, Positioning>();
  (seedCoins[symbol] ?? []).forEach((row, i) => { if (row) history.set(seedDays[i], { oi: row[0], ratio: row[1] }); });
  return history;
}

/** How many archive files one run may fetch, so a long gap is caught up over several runs. */
const FETCH_BUDGET = 54;

/**
 * One pass for the UTC day containing `now`: tops up positioning, closes or carries open trades and
 * logs any new entry at today's open. Safe to call every few minutes; a day is only worked once.
 */
export async function runCrowdedBreak(db: Db, now: number, feed: ForwardFeed = liveFeed()) {
  const today = dayStart(now);
  // Leave the venue a few minutes to print today's opening bar.
  if (now - today < 5 * 60_000) return { status: 'waiting' as const };
  const done = await db.from('forward_test_days').select('day').eq('strategy', STRATEGY).eq('day', isoDay(today)).maybeSingle();
  if (done.error) throw new Error(`Could not read the forward test log: ${done.error.message}`);
  if (done.data) return { status: 'done' as const };

  const setupDay = today - 2 * DAY;
  const stored = await db.from('forward_positioning').select('symbol,day,open_interest,account_ratio').gte('day', isoDay(SEED_THROUGH));
  if (stored.error) throw new Error(`Could not read stored positioning: ${stored.error.message}`);
  const histories = new Map(COINS.map(symbol => [symbol, seedHistory(symbol)] as const));
  for (const row of stored.data ?? []) histories.get(row.symbol)?.set(Date.parse(row.day + 'T00:00:00Z'), { oi: Number(row.open_interest), ratio: Number(row.account_ratio) });

  // Fetch the days still missing, oldest first, up to yesterday.
  const wanted: Array<{ symbol: string; day: number }> = [];
  for (let day = SEED_THROUGH + DAY; day < today; day += DAY)
    for (const symbol of COINS) if (!histories.get(symbol)!.has(day)) wanted.push({ symbol, day });
  const fetched = await Promise.allSettled(wanted.slice(0, FETCH_BUDGET).map(async item => ({ ...item, row: await feed.positioning(item.symbol, item.day) })));
  const fresh = fetched.flatMap(result => result.status === 'fulfilled' && result.value.row ? [result.value] : []);
  for (const item of fresh) histories.get(item.symbol)!.set(item.day, item.row!);
  if (fresh.length) {
    const saved = await db.from('forward_positioning').insert(fresh.map(item => ({ symbol: item.symbol, day: isoDay(item.day),
      open_interest: item.row!.oi, account_ratio: item.row!.ratio })));
    if (saved.error && saved.error.code !== '23505') throw new Error(`Could not store positioning: ${saved.error.message}`);
  }

  const open = await db.from('forward_trades').select('*').eq('strategy', STRATEGY).eq('status', 'open');
  if (open.error) throw new Error(`Could not read open forward trades: ${open.error.message}`);
  const openBySymbol = new Map((open.data ?? []).map(row => [row.symbol as string, row]));

  const notes: Record<string, string> = {};
  let entered = 0, closed = 0, incomplete = wanted.length > FETCH_BUDGET;
  await Promise.all(COINS.map(async symbol => {
    try {
      const trade = openBySymbol.get(symbol);
      const from = Math.min(today - 8 * DAY, trade ? Date.parse(trade.entry_day + 'T00:00:00Z') : today);
      const bars = new Map((await feed.dailyBars(symbol, from, today)).map(bar => [bar.t, bar] as const));
      if (!bars.has(today)) { incomplete = true; notes[symbol] = 'no opening bar yet'; return; }

      if (trade) {
        const entryDay = Date.parse(trade.entry_day + 'T00:00:00Z'), side = trade.side as Side;
        const step = advance({ side, entryDay, entryPrice: Number(trade.entry_price), stop: Number(trade.stop_price),
          lastDay: Date.parse(trade.last_day + 'T00:00:00Z') }, bars, today);
        if ('exit' in step) {
          // Funding runs from the entry open to the exit: the whole exit day for an intraday stop, its open otherwise.
          const until = step.exit.reason === 'intraday_stop' ? step.exit.day + DAY : step.exit.day;
          const result = tradeResult(side, Number(trade.entry_price), step.exit.price, await feed.funding(symbol, entryDay, until));
          const saved = await db.from('forward_trades').update({ status: 'closed', exit_day: isoDay(step.exit.day), exit_price: step.exit.price,
            exit_reason: step.exit.reason, gross: result.gross, funding: result.funding, net: result.net, last_day: isoDay(step.exit.day) }).eq('id', trade.id);
          if (saved.error) throw new Error(saved.error.message);
          closed += 1;
          notes[symbol] = `closed ${side} (${step.exit.reason})`;
        } else if (isoDay(step.lastDay) !== trade.last_day) {
          const saved = await db.from('forward_trades').update({ last_day: isoDay(step.lastDay) }).eq('id', trade.id);
          if (saved.error) throw new Error(saved.error.message);
        }
        return; // one position per coin, and none on the day one closes
      }

      const history = histories.get(symbol)!;
      if (!history.has(setupDay)) { incomplete = true; notes[symbol] = 'positioning for the setup day is not published yet'; return; }
      const side = entrySignal(history, bars, today);
      if (!side) return;
      const price = bars.get(today)!.o;
      const saved = await db.from('forward_trades').insert({ strategy: STRATEGY, symbol, side, signal_day: isoDay(setupDay), entry_day: isoDay(today),
        entry_price: price, stop_price: stopPrice(price, side), last_day: isoDay(today - DAY), status: 'open',
        basket: (TESTED_COINS as readonly string[]).includes(symbol) ? 'tested' : 'extension' });
      if (saved.error && saved.error.code !== '23505') throw new Error(saved.error.message);
      if (!saved.error) { entered += 1; notes[symbol] = `entered ${side}`; }
    } catch (error) {
      incomplete = true;
      notes[symbol] = `error: ${error instanceof Error ? error.message : error}`;
    }
  }));

  // Late in the day stop retrying: an entry that could not be evaluated near the open is skipped, not back-filled.
  const giveUp = now - today > 6 * 3_600_000;
  if (!incomplete || giveUp) {
    const logged = await db.from('forward_test_days').insert({ strategy: STRATEGY, day: isoDay(today), checked_at: new Date(now).toISOString(),
      detail: { entered, closed, complete: !incomplete, notes } });
    if (logged.error && logged.error.code !== '23505') throw new Error(`Could not log the forward test day: ${logged.error.message}`);
  }
  return { status: incomplete ? 'partial' as const : 'checked' as const, entered, closed, notes };
}

export async function readForwardTest(db: Db) {
  const [trades, last] = await Promise.all([
    db.from('forward_trades').select('symbol,side,basket,signal_day,entry_day,entry_price,stop_price,exit_day,exit_price,exit_reason,gross,funding,net,status')
      .eq('strategy', STRATEGY).order('entry_day', { ascending: false }).limit(500),
    db.from('forward_test_days').select('day,checked_at,detail').eq('strategy', STRATEGY).order('day', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (trades.error) throw new Error(trades.error.message);
  if (last.error) throw new Error(last.error.message);
  const rows = trades.data ?? [];
  const closedOf = (basket?: string) => rows.filter(row => row.status === 'closed' && row.net != null && (!basket || row.basket === basket))
    .map(row => ({ symbol: row.symbol as string, net: Number(row.net) }));
  return {
    strategy: STRATEGY, startedAfter: isoDay(SEED_THROUGH), lastChecked: last.data?.day ?? null, lastDetail: last.data?.detail ?? null,
    coins: { tested: [...TESTED_COINS], extension: COINS.filter(symbol => !(TESTED_COINS as readonly string[]).includes(symbol)) },
    score: { all: scoreline(closedOf()), tested: scoreline(closedOf('tested')), extension: scoreline(closedOf('extension')) },
    open: rows.filter(row => row.status === 'open'), closed: rows.filter(row => row.status === 'closed').slice(0, 50),
  };
}
