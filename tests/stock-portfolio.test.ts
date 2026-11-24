import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { EtoroClient } from '../lib/stocks/etoro';
import { stockPortfolioEntry, stockPortfolioRisk } from '../lib/stocks/portfolio';
import { replayEntry, replayExit, replayNights, replayStop, stockReplayCosts } from '../lib/stocks/replay';
import { scanStockSetups } from '../lib/stocks/setups';

test('leveraged replay pays both fees, charges Friday financing and fills through a gapped stop', () => {
  const cost = { amount: 1000, leverage: 5 as const, stopMarginPct: 10, slipBps: 0, commission: 0, cfdFeeBps: 15, annualFinancingPct: 10.95 };
  const position = replayEntry(10_000, 100, 99.9, cost)!;
  assert.equal(position.stop, 98);
  assert.equal(position.nightlyFee * replayNights('2026-11-20'), 4.5);
  position.cash -= position.nightlyFee * replayNights('2026-11-20');
  assert.equal(replayStop(position.stop, 95, 93), 95);
  assert.equal(replayExit(position, 95, cost), 9730.875);
  assert.equal(replayEntry(10_000, 100, 97, cost), null);
  assert.equal(stockReplayCosts(cost).slipBps, 3);
  assert.equal(stockReplayCosts(cost).cfdFeeBps, 30);
});

test('scanner checks eligible rule pairs, shares the daily read, and ranks estimated costs', async t => {
  const now = Date.parse('2026-11-23T14:45:00Z');
  t.mock.method(Date, 'now', () => now);
  const bars = Array.from({ length: 102 }, (_, i) => ({
    day: i === 101 ? '2026-11-20' : String(i), bidOpen: 100, askOpen: 100.03, bidClose: i === 101 ? 103 : 100, high: 102, low: 98,
  }));
  const calls: number[] = [];
  const broker = {
    candles: async (id: number) => { calls.push(id); return bars; },
    quotes: async (ids: number[]) => ids.map(instrumentId => ({
      instrumentId, bid: 102.9, ask: 103, date: new Date(now).toISOString(), quoteType: 'realtime',
    })),
    stockOrderOptionsFor: async (ids: number[]) => new Map(ids.map(id => [id, [{ leverage: 1, minimum: 1, stopMargin: null }]])),
    stockOrderCosts: async (order: { instrumentId: number }) => [{ value: order.instrumentId === 1004 ? 1 : 2, currency: 'USD', costType: 'transactionFee' }],
  } as unknown as EtoroClient;
  const result = await scanStockSetups(broker, { amount: 1000, leverage: 1 }, {
    symbols: ['AAPL', 'MSFT'], rules: ['breakout', 'pullback', 'earnings-rebound'], automatic: true,
  }, now);
  assert.equal(result.evaluated, 4);
  assert.equal(result.outsideWindow, 2);
  assert.deepEqual(calls, [1001, 1004]);
  assert.equal(result.rows[0].symbol, 'MSFT');
  assert.equal(result.rows[0].costs[0].value, 1);
  assert.equal(await scanStockSetups(broker, { amount: 1000, leverage: 1 }, {}, Date.parse('2026-11-22T15:00Z')).then(result => result.evaluated), 0);
});

test('portfolio checks other eToro holdings and fails closed when exposure cannot be read', () => {
  const settings = { symbols: ['NVDA', 'AMD'] as const, strategies: ['breakout'] as const,
    maxExposure: 6000, maxGroup: 2600, maxPositions: 3, maxCostBps: 60, dailyLoss: 100 };
  const position = { id: 1, instrumentId: 1137, amount: 1000, entry: 100, units: 20, leverage: 2, pnl: 50, side: 'Long', opened: '' };
  const book = { pending: 0, mirrors: 0, availableCash: 2500, credit: 2500, positions: [position] };
  const risk = stockPortfolioRisk(book)!;
  assert.equal(risk.equity, 3550);
  assert.equal(risk.gross, 2050);
  const config = { ...settings, symbols: [...settings.symbols], strategies: [...settings.strategies] };
  assert.equal(stockPortfolioEntry(config, risk, 1832, 600), 'Concentration limit');
  assert.equal(stockPortfolioEntry(config, risk, 1001, 600), null);
  assert.equal(stockPortfolioEntry(config, risk, 1137, 20), 'Ticker already held');
  assert.equal(stockPortfolioRisk({ ...book, pending: 1 }), null);
  assert.equal(stockPortfolioRisk({ ...book, positions: [{ ...position, pnl: null }] }), null);
});

test('portfolio SQL reserves distinct tickers, preserves single-mode behavior and honors pause and daily loss', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobname text, command text);
      CREATE TABLE public.autopilot_positions (id uuid PRIMARY KEY);
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
    `);
    for (const path of ['009_etoro_connections', '011_etoro_stock_orders', '012_etoro_stock_autopilot', '013_stock_strategy_execution', '014_stock_leverage', '015_stock_portfolio', '016_stock_execution_research', '017_stock_catalysts_and_guards', '018_automation_center', '019_strategy_journey']) {
      await db.exec(readFileSync(`supabase/migrations/${path}.sql`, 'utf8'));
    }
    const user = '00000000-0000-4000-8000-000000000001';
    const version = '2026-11-23T14:30:00Z';
    const day = '2026-11-23';
    await db.exec(`
      INSERT INTO auth.users VALUES ('${user}');
      INSERT INTO etoro_connections (user_id, environment, credentials_encrypted, updated_at) VALUES ('${user}', 'demo', 'mock', '${version}');
      INSERT INTO stock_autopilot (user_id, symbol, strategy, amount, active_environment, updated_at, portfolio, scan_until)
        VALUES ('${user}', 'AAPL', 'breakout', 100, 'demo', '${version}',
          '{"symbols":["AAPL","MSFT","NVDA"],"strategies":["breakout"]}', '2099-01-01');
      INSERT INTO stock_portfolio_sessions VALUES ('${user}', 'demo', '${day}', 10000, false);
    `);
    const reserve = async (symbol: string, instrumentId: number) => (await db.query<{ id: string | null }>(`
      SELECT reserve_stock_portfolio_order($1, 'demo', $2, $2, $3, '2099-01-01', $4, 'breakout', $5, 100, now() + interval '1 minute', null) AS id
    `, [user, version, day, symbol, JSON.stringify({ amount: 100, leverage: 1, instrumentId })])).rows[0].id;
    const old = () => db.query<{ id: string | null }>(`SELECT reserve_stock_autopilot_order($1, 'demo', $2, $2, $3, 1001, 100) AS id`, [user, version, day]);
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','stock_research_runs','select') AS allowed")).rows[0].allowed, false);
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('service_role','stock_scan_journal','insert') AS allowed")).rows[0].allowed, true);
    assert.equal((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','stock_shadow_observations','select') AS allowed")).rows[0].allowed, false);
    await db.exec(`
      INSERT INTO stock_guard_settings (user_id, environment, enabled) VALUES ('${user}', 'demo', true);
      INSERT INTO stock_guard_state (user_id, environment, strategy, halted_at, reason) VALUES ('${user}', 'demo', 'breakout', now(), 'slippage');
    `);
    assert.equal(await reserve('AAPL', 1001), null);
    assert.equal((await db.query<{ blocked: boolean }>("SELECT stock_entry_guard_blocked($1, 'real', 'breakout') AS blocked", [user])).rows[0].blocked, false);
    await db.exec("UPDATE stock_guard_state SET halted_at=null, reason=null");
    assert.equal((await old()).rows[0].id, null);
    assert.ok(await reserve('AAPL', 1001));
    assert.equal(await reserve('MSFT', 1004), null);
    await db.exec(`UPDATE etoro_stock_orders SET state='filled' WHERE symbol='AAPL'`);
    assert.ok(await reserve('MSFT', 1004));
    await db.exec(`UPDATE etoro_stock_orders SET state='filled', closed_at=now()`);
    assert.equal(await reserve('AAPL', 1001), null);
    await db.exec(`UPDATE stock_portfolio_sessions SET loss_locked=true`);
    assert.equal(await reserve('NVDA', 1137), null);
    await db.exec(`UPDATE stock_portfolio_sessions SET loss_locked=false; UPDATE stock_autopilot SET active_environment=null`);
    assert.equal(await reserve('NVDA', 1137), null);
    await db.exec(`UPDATE stock_autopilot SET portfolio=null, symbol='NVDA', active_environment='demo'`);
    assert.equal((await old()).rows[0].id, null);
    const nextDay = () => db.query<{ id: string | null }>(`SELECT reserve_stock_autopilot_order($1, 'demo', $2, $2, '2026-11-24', 1137, 100) AS id`, [user, version]);
    await db.exec("UPDATE stock_guard_state SET halted_at=now(), reason='drawdown'");
    assert.equal((await nextDay()).rows[0].id, null);
    await db.exec("UPDATE stock_guard_state SET halted_at=null, reason=null");
    assert.ok((await nextDay()).rows[0].id);
    await db.exec(`
      INSERT INTO automation_profiles (user_id, market, mode, entries_paused) VALUES ('${user}', 'stocks', 'paper', false);
      INSERT INTO automation_runs (user_id, market, kind, source, schedule_key, as_of, plan)
        VALUES ('${user}', 'stocks', 'daily', 'schedule', '2026-11-23', now(), '["SPY"]');
    `);
    const claimed = await db.query<{ attempts: number; lease_token: string }>('SELECT attempts, lease_token FROM claim_automation_run()');
    assert.equal(claimed.rows[0].attempts, 1);
    assert.ok(claimed.rows[0].lease_token);
    assert.equal((await db.query('SELECT id FROM claim_automation_run()')).rows.length, 0);
    await db.exec("UPDATE automation_runs SET lease_until=now() - interval '1 second'");
    assert.equal((await db.query<{ attempts: number }>('SELECT attempts FROM claim_automation_run()')).rows[0].attempts, 2);
    const enqueue = (idea: string | null) => db.query(`INSERT INTO automation_runs(user_id,market,kind,source,as_of,idea_id)
      VALUES ($1,'stocks','focused','manual',now(),$2)`, [user, idea]);
    await enqueue('stocks:close:SPY');
    await enqueue('stocks:close-volume:SPY');
    await assert.rejects(enqueue('stocks:close-volume:SPY'), /duplicate key/);
    await assert.rejects(enqueue(null), /automation_runs_idea_check/);
  } finally {
    await db.close();
  }
});
