import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { DAY, isoDay } from './crowded-break';
import { BASKET_COINS, BASKET_START, BASKET_STRATEGY, dailyFunding, LOOKBACK_DAYS, MIN_DAYS, pickBasket, rankingRate, rebalanceCost, summariseBasket, WEEK,
  weekFunding, weekResult, type BasketWeek, type FundingDay, type FundingPrint } from './funding-basket';
import { liveFeed, type ForwardFeed } from './run';

type Db = ReturnType<typeof createServiceClient>;

export interface BasketFeed {
  dailyBars: ForwardFeed['dailyBars'];
  /** Hourly funding prints on the traded venue between two times. */
  fundingPrints(symbol: string, from: number, to: number): Promise<FundingPrint[]>;
}

export function liveBasketFeed(): BasketFeed {
  const hl = marketDataClient();
  return { dailyBars: liveFeed().dailyBars, fundingPrints: (symbol, from, to) => hl.getFundingRates(symbol, from, to) };
}

const dayOf = (iso: string) => Date.parse(iso + 'T00:00:00Z');
/** The venue returns 500 hourly prints a page and limits how fast pages may be asked for. */
const PAGE_HOURS = 500;
/** Funding pages one run may fetch. A first fill of 30 days for 16 coins is spread over a few runs. */
const PAGE_BUDGET = 8;

/** Three tries with a growing pause, for a venue that answers "too many requests". */
async function retried<T>(read: () => Promise<T>, pause: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); } catch (error) {
      if (attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, pause * (attempt + 1)));
    }
  }
}

/**
 * Works the next Monday that is due: scores the week just ended and sets the new basket. The first
 * Monday is the one after the backtest data ended, so weeks already past are filled in from recorded
 * prices and funding. Daily funding is kept in `forward_funding_daily`, so each run only fetches what
 * is missing and a rate-limited run picks up where it stopped. Safe to call every few minutes.
 */
export async function runFundingBasket(db: Db, now: number, feed: BasketFeed = liveBasketFeed(), pause = 700) {
  const latest = await db.from('forward_test_days').select('day,detail').eq('strategy', BASKET_STRATEGY).order('day', { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw new Error(`Could not read the funding basket log: ${latest.error.message}`);
  const due = latest.data ? dayOf(latest.data.day) + WEEK : BASKET_START;
  // Leave the venue a few minutes to print the opening bar and the last funding of Sunday.
  if (now - due < 5 * 60_000) return { status: 'waiting' as const };
  const previous = latest.data && dayOf(latest.data.day) === due - WEEK ? latest.data.detail as BasketWeek : null;

  const from = due - LOOKBACK_DAYS * DAY;
  const stored = await db.from('forward_funding_daily').select('symbol,day,funding_sum,prints').gte('day', isoDay(from)).lt('day', isoDay(due));
  if (stored.error) throw new Error(`Could not read stored funding: ${stored.error.message}`);
  const funding = new Map<string, Map<number, FundingDay>>(BASKET_COINS.map(symbol => [symbol, new Map()]));
  for (const row of stored.data ?? []) funding.get(row.symbol)?.set(dayOf(row.day), { day: dayOf(row.day), sum: Number(row.funding_sum), prints: Number(row.prints) });

  // Top up each coin from its first missing day, within the page budget.
  let pages = 0, filling = false;
  const problems: string[] = [];
  for (const symbol of BASKET_COINS) {
    const have = funding.get(symbol)!;
    let first = from;
    while (first < due && have.has(first)) first += DAY;
    if (first >= due) continue;
    const need = Math.ceil((due - first) / 3_600_000 / PAGE_HOURS);
    if (pages + need > PAGE_BUDGET) { filling = true; continue; }
    pages += need;
    try {
      const days = dailyFunding(await retried(() => feed.fundingPrints(symbol, first, due - 1), pause), first, due).filter(row => !have.has(row.day));
      const saved = await db.from('forward_funding_daily').insert(days.map(row => ({ symbol, day: isoDay(row.day), funding_sum: row.sum, prints: row.prints })));
      if (saved.error && saved.error.code !== '23505') throw new Error(saved.error.message);
      for (const row of days) have.set(row.day, row);
    } catch (error) {
      filling = true;
      problems.push(`${symbol}: ${error instanceof Error ? error.message : error}`);
    }
  }
  // The data for a Monday does not change afterwards, so anything still missing is fetched on the next run.
  if (filling) return { status: 'filling' as const, problems };

  const prices: Record<string, number> = {}, rates: Record<string, number> = {}, carried: Record<string, number> = {};
  const notes: string[] = [];
  let unreachable = false;
  for (let i = 0; i < BASKET_COINS.length; i += 4) {
    await Promise.all(BASKET_COINS.slice(i, i + 4).map(async symbol => {
      let bars;
      try { bars = await retried(() => feed.dailyBars(symbol, due, due), pause); } catch (error) {
        unreachable = true; problems.push(`${symbol}: ${error instanceof Error ? error.message : error}`); return;
      }
      const open = bars.find(bar => bar.t === due)?.o;
      if (!open) { notes.push(`${symbol}: no opening price`); return; }
      prices[symbol] = open;
      const days = [...funding.get(symbol)!.values()];
      const week = weekFunding(days, due);
      if (week != null) carried[symbol] = week;
      const ranked = rankingRate(days, due);
      if (ranked.mean != null && ranked.days >= MIN_DAYS) rates[symbol] = ranked.mean;
    }));
  }
  if (unreachable) return { status: 'retry' as const, problems };

  const basket = pickBasket(Object.entries(rates).map(([symbol, mean]) => ({ symbol, mean })));
  // A week is only scored when every leg has a price at both ends and its funding.
  const week = previous?.basket ? weekResult(previous.basket, previous.prices, prices, carried) : null;
  const missing = (!basket && 'too few coins could be ranked') || (previous?.basket && !week && 'a held coin has no price or funding for the week') || null;
  // A missing opening price may just be late. Six hours past the open the Monday is logged as it stands, so the chain moves on.
  if (missing && now - due < 6 * 3_600_000) return { status: 'retry' as const, problems: [missing, ...notes] };
  const { traded, cost } = rebalanceCost(previous?.basket ?? null, basket);
  const detail: BasketWeek = { basket, prices, rates, week, traded, cost, ...(missing || notes.length ? { note: [missing, ...notes].filter(Boolean).join('; ') } : {}) };
  const saved = await db.from('forward_test_days').insert({ strategy: BASKET_STRATEGY, day: isoDay(due), checked_at: new Date(now).toISOString(), detail });
  if (saved.error && saved.error.code !== '23505') throw new Error(`Could not log the funding basket: ${saved.error.message}`);
  return { status: 'logged' as const, day: isoDay(due), basket, week };
}

export async function readFundingBasket(db: Db) {
  const rows = await db.from('forward_test_days').select('day,detail').eq('strategy', BASKET_STRATEGY).order('day', { ascending: true }).limit(520);
  if (rows.error) throw new Error(rows.error.message);
  const logged = (rows.data ?? []).map(row => ({ day: row.day as string, ...(row.detail as BasketWeek) }));
  const last = logged[logged.length - 1];
  const leg = (symbol: string) => ({ symbol, rate: last.rates[symbol] ?? null });
  return {
    strategy: BASKET_STRATEGY, started: isoDay(BASKET_START), lastRebalance: last?.day ?? null,
    summary: summariseBasket(logged),
    current: last?.basket ? { longs: last.basket.longs.map(leg), shorts: last.basket.shorts.map(leg) } : null,
    // Each held week with the fee that was paid to set its basket, newest first.
    weeks: logged.flatMap((row, i) => row.week ? [{ ended: row.day, price: row.week.price, funding: row.week.funding, cost: logged[i - 1]?.cost ?? 0 }] : []).reverse().slice(0, 52),
    note: last?.note ?? null,
  };
}
