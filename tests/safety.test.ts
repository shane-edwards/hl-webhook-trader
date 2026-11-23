import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { memoryDb, SimExchange } from './helpers';
import { openPosition } from '../lib/execution';
import { manageExits } from '../lib/exits';
import { placeLimitEntry, managePending } from '../lib/pending';
import { simulate, COST } from '../lib/autopilot/simulate';
import { WARMUP_BARS, type StrategyDef } from '../lib/autopilot/strategies';
import { withTradingLock } from '../lib/trading-lock';
import { haltAndFlatten } from '../lib/risk/flatten';
import { ledgerCashflow } from '../lib/risk/cashflows';
import { actionHash } from '../lib/hyperliquid/signing';
import { ethers } from 'ethers';
import { encode } from '@msgpack/msgpack';
import type { SupabaseClient } from '@supabase/supabase-js';

const userId = '00000000-0000-4000-8000-000000000001';
const limits = { maxGrossExposureX: 3, dailyLossLimitPct: 5 };

test('kill switch disables Autopilot and cancels entries before closing positions', async () => {
  const ex = new SimExchange({ BTC: 100, ETH: 100 });
  const { db, tables } = memoryDb({ settings: [{ user_id: userId, autopilot_enabled: true, webhook_enabled: true, strategy_enabled: true }] });
  await placeLimitEntry(ex.client, db, { userId, symbol: 'BTC', side: 'long', limitPx: 95, sizeUsd: 100, leverage: 2, stopLossPct: 2, takeProfitPct: null, expiryHours: 1, limits });
  ex.positions.set('ETH', { side: 'long', size: 1, entryPrice: 100 });
  const close = ex.closePosition.bind(ex);
  ex.closePosition = async coin => {
    assert.equal(tables.settings[0].autopilot_enabled, false);
    assert.equal(tables.settings[0].trading_halted, true);
    assert.equal(ex.resting('BTC', 'limit').length, 0);
    return close(coin);
  };
  await haltAndFlatten(ex.client, db, userId, 1);
  assert.equal(ex.positions.size, 0);
  assert.equal(tables.pending_orders[0].status, 'cancelled');
  assert.equal(tables.settings[0].flatten_pending, false);
  assert.equal(tables.settings[0].trading_halted, true);
});

test('resting entries reserve gross exposure before they fill', async () => {
  const ex = new SimExchange({ BTC: 100 });
  ex.equity = 1000;
  const { db } = memoryDb();
  const params = { userId, symbol: 'BTC', side: 'long' as const, limitPx: 95, sizeUsd: 2000, leverage: 2, stopLossPct: 2, takeProfitPct: null, expiryHours: 1, limits };
  await placeLimitEntry(ex.client, db, params);
  await assert.rejects(placeLimitEntry(ex.client, db, params), /Total exposure/);
  assert.equal(ex.resting('BTC', 'limit').length, 1);
});

test('deposits and withdrawals are principal movements while liquidation remains a loss', () => {
  assert.equal(ledgerCashflow({ type: 'deposit', usdc: '500' }, 'me'), 500);
  assert.equal(ledgerCashflow({ type: 'withdraw', usdc: '300' }, 'me'), -300);
  assert.equal(ledgerCashflow({ type: 'internalTransfer', destination: 'me', usdc: '25' }, 'me'), 25);
  assert.equal(ledgerCashflow({ type: 'accountClassTransfer', toPerp: false, usdc: '20' }, 'me'), -20);
  assert.equal(ledgerCashflow({ type: 'liquidation', accountValue: '1000' }, 'me'), 0);
  assert.throws(() => ledgerCashflow({ type: 'newUnknownMovement' }, 'me'), /Unrecognized/);
});

test('expiring action hashes include the SDK expiry marker and unsigned 64-bit timestamp', () => {
  const action = { type: 'cancel', cancels: [{ a: 0, o: 1 }] };
  const nonce = Buffer.alloc(8), expiry = Buffer.alloc(8);
  nonce.writeBigUInt64BE(BigInt(123)); expiry.writeBigUInt64BE(BigInt(456));
  const expected = ethers.keccak256(Buffer.concat([Buffer.from(encode(action)), nonce, Buffer.from([0, 0]), expiry]));
  assert.equal(actionHash(action, null, 123, 456), expected);
  assert.notEqual(actionHash(action, null, 123), expected);
});

test('a failed trade write closes its acknowledged fill despite closeIfUnprotected being enabled', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db } = memoryDb();
  const source = db as SupabaseClient;
  const failing = {
    rpc: source.rpc,
    from(table: string) {
      const query = source.from(table);
      if (table !== 'trades') return query;
      return { ...query, select: query.select.bind(query), insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'write unavailable' } }) }) }) };
    },
  } as unknown as SupabaseClient;
  await assert.rejects(openPosition(ex.client, failing, {
    userId, symbol: 'BTC', side: 'long', sizeUsd: 1000, leverage: 2, slippagePercent: 1,
    stopLossPct: 2, takeProfitPct: null, source: 'manual', closeIfUnprotected: true,
  }), /closed immediately/);
  assert.equal(ex.positions.size, 0);
});

test('a partial emergency exit keeps its plan active', async () => {
  const ex = new SimExchange({ BTC: 97 });
  ex.positions.set('BTC', { side: 'long', size: 10, entryPrice: 100 });
  const { db, tables } = memoryDb({ position_plans: [{ id: 'plan', user_id: userId, symbol: 'BTC', side: 'long', status: 'active', entry_price: 100, initial_size: 10, stop_px: 98, tp1_px: null, tp1_fraction: null, tp2_px: null, trail_pct: null }] });
  ex.closePosition = async () => {
    ex.positions.get('BTC')!.size = 8;
    return { fillPrice: 97, filledSize: 2, side: 'long', fullyClosed: false };
  };
  const events = await manageExits(ex.client, db, userId, 1);
  assert.match(events[0].message, /remains active/);
  assert.equal(tables.position_plans[0].status, 'active');
  assert.equal(ex.positions.get('BTC')!.size, 8);
});

test('retrying a chase after stop rejection never purchases its fallback again', async () => {
  const ex = new SimExchange({ BTC: 100 });
  const { db, tables } = memoryDb();
  await placeLimitEntry(ex.client, db, { userId, symbol: 'BTC', side: 'long', limitPx: null, sizeUsd: 1000, leverage: 2, stopLossPct: 2, takeProfitPct: null, expiryHours: 1, chaseSeconds: 30, limits });
  ex.prices.set('BTC', 101);
  ex.rejectStops = true;
  let purchases = 0;
  const buy = ex.placeMarketOrder.bind(ex);
  ex.placeMarketOrder = async params => { purchases++; return buy(params); };
  const now = Date.now() + 31_000;
  await managePending(ex.client, db, userId, now);
  await managePending(ex.client, db, userId, now + 10_000);
  assert.equal(purchases, 1);
  assert.equal(tables.pending_orders[0].fallback_started, true);
  assert.equal(ex.positions.size, 0);
});

test('a round trip back to entry loses exactly its costs and hourly equity reconciles', () => {
  const n = WARMUP_BARS;
  const bars = Array.from({ length: n + 3 }, (_, i) => ({ t: Date.UTC(2026, 0, 1) + i * 3_600_000, o: 100, h: 100, l: 100, c: 100 }));
  bars[n] = { ...bars[n], h: 110, c: 110 };
  bars[n + 1] = { ...bars[n + 1], o: 110, h: 110 };
  const strategy: StrategyDef = { id: 'probe', name: 'Probe', style: 'Breakout', description: 'Fixed quantity regression', horizon: 'hourly', maxHoldHours: 0, evaluate: (_ind: unknown, _bars: unknown, i: number) => ({ target: i >= n + 1 ? 0 : 1, stopPct: 0.2, reason: 'round trip' }) };
  const funding = new Map(bars.map(b => [new Date(b.t).toISOString().slice(0, 10), 0]));
  const result = simulate(bars, strategy, false, funding);
  assert.equal(result.trades[0].gross, 0);
  assert.ok(Math.abs(result.trades[0].net + 2 * COST) < 1e-12);
  const equity = result.hourly.reduce((value, h) => value * (1 + h.r), 1);
  assert.ok(Math.abs(equity - (1 + result.trades[0].net)) < 1e-12);
});

test('overlapping account operations cannot enter the same lease', async () => {
  const { db } = memoryDb();
  const ex = new SimExchange({ BTC: 100 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = withTradingLock(ex.client, db, userId, async () => { entered(); await gate; });
  await ready;
  await assert.rejects(withTradingLock(ex.client, db, userId, async () => {}), /already processing/);
  release(); await first;
  await withTradingLock(ex.client, db, userId, async () => {});
});

test('migration 008 executes in PostgreSQL and enforces leases, halts, nonces and alert isolation', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id', true), '')::uuid $$;
      CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text, command text);
      CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
      CREATE TABLE settings(user_id uuid PRIMARY KEY, webhook_enabled boolean);
      CREATE TABLE pending_orders(id uuid, status text);
      CREATE TABLE trades(id uuid, user_id uuid, hyperliquid_order_id text, status text);
      CREATE TABLE alerts(id uuid, message text); ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
      CREATE TABLE autopilot_positions(id uuid); CREATE TABLE autopilot_state(user_id uuid);
      CREATE TABLE position_plans(status text);
      GRANT SELECT ON alerts TO authenticated;
    `);
    await pg.exec(readFileSync('supabase/migrations/008_trading_safety.sql', 'utf8'));
    await pg.query('INSERT INTO auth.users VALUES ($1)', [userId]);
    await pg.query('INSERT INTO settings(user_id) VALUES ($1)', [userId]);
    const owner = '00000000-0000-4000-8000-000000000002';
    const acquire = await pg.query<{ ok: boolean }>('SELECT acquire_trading_lock($1,$2) AS ok', ['account', owner]);
    assert.equal(acquire.rows[0].ok, true);
    const other = await pg.query<{ ok: boolean }>('SELECT acquire_trading_lock($1,$2) AS ok', ['account', userId]);
    assert.equal(other.rows[0].ok, false);
    const allocate = () => pg.query<{ n: number }>('SELECT next_trading_nonce($1,$2,$3,$4,true) AS n', ['account', owner, 'signer', userId]);
    const first = await allocate(), second = await allocate();
    assert.ok(Number(second.rows[0].n) > Number(first.rows[0].n));
    await pg.exec("UPDATE trading_accounts SET halted = true WHERE resource = 'account'");
    await assert.rejects(allocate(), /halted/);
    await pg.query('SELECT next_trading_nonce($1,$2,$3,$4,false)', ['account', owner, 'signer', userId]);
    await pg.exec("UPDATE trading_accounts SET lease_until = now() - interval '1 second'");
    await assert.rejects(pg.query('SELECT next_trading_nonce($1,$2,$3,$4,false)', ['account', owner, 'signer', userId]), /expired/);
    await pg.query('INSERT INTO alerts(user_id,message) VALUES($1,$2),(NULL,$3)', [userId, 'own account', 'operator only']);
    await pg.exec(`SET ROLE authenticated; SET test.user_id = '${userId}'`);
    const alerts = await pg.query('SELECT message FROM alerts');
    assert.deepEqual(alerts.rows, [{ message: 'own account' }]);
    await assert.rejects(pg.query('SELECT acquire_trading_lock($1,$2)', ['other', owner]), /permission denied/);
  } finally { await pg.close(); }
});
