// Gathers every forward test's records for the scoreboard (lib/automation/scoreboard.ts). Read-only. Each
// source is read on its own, so one that cannot be reached shows as unavailable instead of hiding the rest.
import type { createServiceClient } from '@/lib/supabase/server';
import { readPages } from '@/lib/supabase/pages';
import { MOMENTUM_ID } from '@/lib/autopilot/momentum';
import { SEARCH_ASSETS } from '@/lib/strategy-search/model';
import { readHlpVault } from '@/lib/income/hlp';
import { readFundingBasket } from '@/lib/forward-tests/basket-run';
import { BASKET_START } from '@/lib/forward-tests/funding-basket';
import { COINS as CROWDED_COINS, DAY, STRATEGY as CROWDED_BREAK } from '@/lib/forward-tests/crowded-break';
import { SEED_THROUGH } from '@/lib/forward-tests/run';
import { HEDGE_MARKETS, HEDGE_REVISION, SIMULATED_CAPITAL, type HedgeObservation } from '@/lib/hedge-research/model';
import { eventStudyReport } from '@/lib/event-studies/worker';
import { buildScoreboard, crowdedBreakTest, eventTests, fundingBasketTest, fundingHedgeTest, momentumTest, paperRuleTests,
  type Market, type PaperPosition, type TestInput, type Unit } from './scoreboard';

type Db = ReturnType<typeof createServiceClient>;

const unavailable = (id: string, name: string, market: Market, unit: Unit): TestInput =>
  ({ id, name, detail: '', market, unit, start: null, capitalUsd: null, closes: [], open: 0, unavailable: 'Could not load this test' });

async function readFundingHedge(db: Db) {
  const coins = Object.keys(HEDGE_MARKETS);
  const [closes, first, latest] = await Promise.all([
    readPages<{ symbol: string; observed_at: string; reading: HedgeObservation }>((from, to) => db.from('funding_hedge_observations')
      .select('symbol,observed_at,reading').eq('revision', HEDGE_REVISION).eq('reading->>status', 'closed').order('hour').range(from, to)),
    db.from('funding_hedge_observations').select('observed_at').eq('revision', HEDGE_REVISION).order('hour').limit(1).maybeSingle(),
    Promise.all(coins.map(symbol => db.from('funding_hedge_observations').select('reading').eq('revision', HEDGE_REVISION)
      .eq('symbol', symbol).order('hour', { ascending: false }).limit(1).maybeSingle())),
  ]);
  if (first.error || latest.some(row => row.error)) throw new Error('Could not read the funding hedge.');
  const holding = latest.filter(row => ['opened', 'holding'].includes((row.data?.reading as HedgeObservation | undefined)?.status ?? '')).length;
  return fundingHedgeTest(
    closes.flatMap(row => row.reading?.simulatedNet == null ? [] : [{ symbol: row.symbol, at: row.observed_at, net: row.reading.simulatedNet }]),
    first.data ? Date.parse(first.data.observed_at) : null, holding, SIMULATED_CAPITAL, coins);
}

export async function readScoreboard(db: Db, userId: string, now = Date.now()) {
  const [paper, basket, crowded, hedge, events, vault] = await Promise.allSettled([
    readPages<PaperPosition>((from, to) => db.from('autopilot_positions').select('strategy_id,symbol,side,status,entry_time,exit_time,pnl,notional_usd')
      .eq('user_id', userId).eq('mode', 'paper').order('id').range(from, to)),
    readFundingBasket(db),
    readPages<{ symbol: string; status: string; exit_day: string | null; net: number | null }>((from, to) => db.from('forward_trades')
      .select('symbol,status,exit_day,net').eq('strategy', CROWDED_BREAK).order('entry_day').range(from, to)),
    readFundingHedge(db),
    eventStudyReport(db, userId, now),
    readHlpVault(),
  ]);

  const tests: TestInput[] = [];
  if (paper.status === 'fulfilled') {
    tests.push(...paperRuleTests(paper.value, SEARCH_ASSETS.crypto.length));
    tests.push(momentumTest(paper.value.filter(row => row.strategy_id === MOMENTUM_ID)));
  } else tests.push(unavailable('paper', 'Paper rules', 'crypto', 'trades'));
  tests.push(basket.status === 'fulfilled' ? fundingBasketTest(basket.value.weeks, BASKET_START, !!basket.value.current)
    : unavailable('forward.funding_basket', 'Funding carry basket', 'crypto', 'weeks'));
  tests.push(crowded.status === 'fulfilled' ? crowdedBreakTest(crowded.value, SEED_THROUGH + DAY, CROWDED_COINS.length)
    : unavailable('forward.crowded_break', 'Crowded break', 'crypto', 'trades'));
  tests.push(hedge.status === 'fulfilled' ? hedge.value : unavailable('forward.funding_hedge', 'Funding hedge', 'crypto', 'trades'));
  if (events.status === 'fulfilled') tests.push(...eventTests(events.value.studies));
  else tests.push(unavailable('events', 'Event studies', 'stocks', 'events'));

  for (const result of [paper, basket, crowded, hedge, events, vault])
    if (result.status === 'rejected') console.error('[scoreboard]', result.reason instanceof Error ? result.reason.message : result.reason);
  const hlpAnnual = vault.status === 'fulfilled' ? vault.value.nowAnnual ?? vault.value.year : null;
  return buildScoreboard(tests, now, hlpAnnual);
}
