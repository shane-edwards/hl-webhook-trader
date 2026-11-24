import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { test } from 'node:test';
import { EtoroError, type EtoroClient } from '../lib/stocks/etoro';
import { manageStockOrder } from '../lib/stocks/autopilot';
import { readPaperResults } from '../lib/automation/policy';
import { withWalletChange } from '../lib/wallet/change';
import { analyticsReport } from '../lib/analytics-report';
import type { Trade } from '../types';
import { memoryDb } from './helpers';

const start = Date.parse('2026-11-24T19:00:00Z');
type Managed = Parameters<typeof manageStockOrder>[3];

function exitFixture(firstFailure: Error) {
  let clock = start, status = 1, portfolioOpen = true, fresh = true;
  const sent: string[] = [];
  const order: Managed = {
    id: 'order', environment: 'demo', connection_version: 'version', state: 'filled', position_ids: [123],
    request: { action: 'open', transaction: 'buy', instrumentId: 456, orderType: 'mkt', amount: 100, orderCurrency: 'usd', settlementType: 'real', leverage: 1 },
    strategy: 'breakout', signal_day: null, strategy_exit_at: new Date(start - 1).toISOString(), updated_at: new Date(start - 100).toISOString(),
    close_requests: {}, protection_state: null,
  };
  const { db, tables } = memoryDb({ etoro_stock_orders: [{ ...order, user_id: 'user' }] });
  const broker = {
    portfolio: async () => ({ positions: portfolioOpen ? [{ id: 123, instrumentId: 456, side: 'Long' }] : [] }),
    quotes: async () => fresh ? [{ instrumentId: 456, date: new Date(clock).toISOString(), quoteType: 'realtime', bid: 49, ask: 50 }] : [],
    closeStock: async (_id: number, _instrument: number, ref: string) => {
      sent.push(ref);
      if (sent.length === 1) throw firstFailure;
      return { orderForClose: { orderID: 55 } };
    },
    stockOrderStatus: async (ref: string) => { assert.equal(ref, sent.at(-1)); return { orderId: 55 }; },
    stockCloseStatus: async () => ({ orderID: 55, instrumentID: 456, statusID: status, proceeds: 90,
      positions: [{ positionID: 123, rate: 49, units: 2 }] }),
  } as unknown as EtoroClient;
  const snapshot = () => structuredClone(tables.etoro_stock_orders[0]) as unknown as Managed;
  return { sent, clock: () => clock, snapshot, tables, advance: (ms: number) => { clock += ms; },
    confirmed: () => { status = 3; }, flat: () => { portfolioOpen = false; }, stale: () => { fresh = false; },
    scan: () => manageStockOrder(db, broker, 'user', snapshot(), 'version', '2026-11-23', clock) };
}

test('a definitive eToro close rejection survives restart, backs off, then retries once with a fresh reference', async t => {
  const f = exitFixture(new EtoroError(429));
  t.mock.method(Date, 'now', f.clock);
  await f.scan();
  assert.equal(f.snapshot().close_attempts?.[123].state, 'rejected');
  f.advance(60_000);
  await f.scan();
  assert.equal(f.sent.length, 1);
  f.advance(60_001);
  await f.scan();
  assert.equal(new Set(f.sent).size, 2);
  assert.equal(f.snapshot().close_attempts?.[123].state, 'submitted');
  await f.scan();
  assert.equal(f.sent.length, 2);
  f.confirmed();
  await f.scan();
  assert.equal(f.snapshot().close_attempts?.[123].state, 'filled');
  f.flat();
  f.advance(601_000);
  await f.scan();
  assert.ok(f.tables.etoro_stock_orders[0].closed_at);
  assert.equal(f.snapshot().close_execution?.[123].rate, 49);
});

test('a timeout or legacy eToro reference is reconciled even without a fresh quote', async t => {
  const f = exitFixture(new Error('Connection lost before acknowledgement'));
  t.mock.method(Date, 'now', f.clock);
  await f.scan();
  assert.equal(f.snapshot().close_attempts?.[123].state, 'uncertain');
  f.tables.etoro_stock_orders[0].close_attempts = {};
  f.stale();
  f.advance(600_000);
  await f.scan();
  f.confirmed();
  await f.scan();
  assert.equal(f.snapshot().close_attempts?.[123].state, 'filled');
  assert.equal(f.sent.length, 1);
});

test('an unacknowledged eToro close that fills between scans preserves its broker execution', async t => {
  const f = exitFixture(new Error('Lost receipt'));
  t.mock.method(Date, 'now', f.clock);
  await f.scan();
  f.flat();
  f.stale();
  f.advance(601_000);
  await f.scan();
  assert.equal(f.tables.etoro_stock_orders[0].closed_at, undefined);
  f.confirmed();
  await f.scan();
  assert.ok(f.tables.etoro_stock_orders[0].closed_at);
  assert.equal(f.snapshot().close_execution?.[123].units, 2);
  assert.equal(f.sent.length, 1);
});

test('legacy paper fills stay in history and only quote-backed fills qualify a version for Live', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    user_id: 'u', mode: 'paper', status: 'closed', automation_version: 'v', pnl: 2,
    exit_time: new Date(start - i * 86_400_000).toISOString(), paper_book_fill: i === 0,
  }));
  const { db, tables } = memoryDb({ autopilot_positions: rows });
  const candidate = { market: 'crypto', version: 'v' } as Parameters<typeof readPaperResults>[2];
  const results = await readPaperResults(db, 'u', candidate);
  assert.equal(results.closed, 1);
  assert.equal(results.passed, false);
  assert.equal(tables.autopilot_positions.length, 11);
  rows.forEach(row => { row.paper_book_fill = true; });
  assert.equal((await readPaperResults(db, 'u', candidate)).passed, true);
});

test('wallet routes share the same checks for open positions, active Live automation and concurrent settings updates', async () => {
  const { db, tables } = memoryDb({ settings: [{ user_id: 'u', updated_at: 'initial' }],
    autopilot_positions: [{ user_id: 'u', mode: 'live', status: 'open' }] });
  let writes = 0;
  const mutate = () => withWalletChange(db, 'u', { updated_at: 'initial' }, async () => ++writes);
  await assert.rejects(mutate(), /Finish managed positions/);
  tables.autopilot_positions[0].status = 'closed';
  tables.automation_profiles.push({ user_id: 'u', market: 'crypto', enabled: true, mode: 'live', entries_paused: false });
  await assert.rejects(mutate(), /Pause Live Autopilot/);
  tables.automation_profiles[0].entries_paused = true;
  assert.equal(await mutate(), 1);
  tables.settings[0].updated_at = 'changed';
  await assert.rejects(mutate(), /Settings changed/);
  assert.equal(writes, 1);
});

test('analytics includes three pages of trades and rejects an incomplete history', async () => {
  const trades = Array.from({ length: 1103 }, (_, i) => ({
    id: String(i).padStart(5, '0'), status: 'closed', pnl: 2, fees: 0, funding_paid: 0,
    entry_time: new Date(start).toISOString(), exit_time: new Date(start + i).toISOString(),
  } as Trade));
  const report = await analyticsReport(async cursor => trades.filter(t => !cursor || t.id > cursor).slice(0, 500));
  assert.equal(report.stats.totalTrades, 1103);
  assert.equal(report.stats.totalPnl, 2206);
  assert.equal(report.monthly[0].trades, 1103);
  await assert.rejects(analyticsReport(async cursor => {
    if (cursor) throw new Error('Page unavailable');
    return trades.slice(0, 500);
  }), /Page unavailable/);
});

test('migration 022 restores verified wallet origins, guards wallet changes and fairly claims overdue stock exits', async () => {
  const pg = new PGlite({ extensions: { uuid_ossp } });
  const users = [1, 2, 3].map(n => '00000000-0000-4000-8000-00000000000' + n);
  const wallet = '0x' + '1'.repeat(40);
  try {
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
      CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text PRIMARY KEY, command text);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
        INSERT INTO cron.job VALUES ($1,$3) ON CONFLICT(jobname) DO UPDATE SET command=excluded.command RETURNING 1::bigint $$;
      INSERT INTO cron.job VALUES ('hl-autopilot', 'SELECT 1;');
    `);
    const migrations = readdirSync('supabase/migrations').filter(file => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of migrations.filter(file => file < '022')) await pg.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
    for (const id of users) await pg.query('INSERT INTO auth.users VALUES ($1)', [id]);
    await pg.query('INSERT INTO settings(user_id) VALUES ($1)', [users[0]]);
    await pg.query(`INSERT INTO autopilot_positions(user_id, mode,symbol,strategy_id,side,entry_price,size,notional_usd,stop_price,entry_bar_t)
      VALUES ($1,'live','BTC','trend_breakout','long',100,1,100,98,1)`, [users[0]]);
    await pg.query(`INSERT INTO trades(user_id,symbol,side,entry_price,size,size_usd,entry_time,signal_source,webhook_payload,hyperliquid_order_id)
      VALUES ($1,'BTC','long',100,1,100,now(),'autopilot','{"strategy":"trend_breakout"}','77')`, [users[0]]);
    await pg.query(`INSERT INTO exchange_actions(user_id,resource,action,nonce,expires_after,status,response)
      VALUES ($1,$2,'{}',1,1,'confirmed','{"response":{"data":{"statuses":[{"filled":{"oid":77}}]}}}')`, [users[0], 'testnet:' + wallet]);
    for (const file of migrations.filter(file => file >= '022')) await pg.exec(readFileSync('supabase/migrations/' + file, 'utf8'));
    assert.equal((await pg.query<{ account_resource: string }>('SELECT account_resource FROM autopilot_positions')).rows[0].account_resource, 'testnet:' + wallet);
    const change = (address: string | null, key: string | null) => pg.query(
      'UPDATE settings SET hl_wallet_address=$1, hl_private_key_encrypted=$2 WHERE user_id=$3', [address, key, users[0]]);
    await assert.rejects(change('0x' + '2'.repeat(40), 'key'), /Finish managed positions/);
    await change(wallet, 'key');
    await assert.rejects(change(null, null), /Finish managed positions/);
    await assert.rejects(pg.query('UPDATE settings SET is_testnet=false'), /Finish managed positions/);
    await pg.exec("UPDATE autopilot_positions SET status='closed'; UPDATE trades SET status='closed';");
    await change(null, null);
    const fast = (await pg.query<{ command: string }>("SELECT command FROM cron.job WHERE jobname='hl-fast'")).rows[0].command;
    assert.ok(fast.includes('recovery_pending'));
    await pg.exec(fast);
    for (const id of users.slice(0, 2)) await pg.query(`INSERT INTO stock_autopilot(user_id,symbol,strategy,amount,active_environment)
      VALUES ($1,'AAPL','breakout',100,'demo')`, [id]);
    await pg.query(`INSERT INTO etoro_stock_orders(user_id,environment,connection_version,symbol,request,state,reference_price,strategy_exit_at)
      VALUES ($1,'demo',now(),'AAPL','{}','filled',100,now()-interval '1 minute')`, [users[2]]);
    const claim = async () => (await pg.query<{ id: string }>('SELECT claim_stock_scan_accounts() AS id')).rows.map(r => r.id);
    const first = await claim();
    assert.equal(first.length, 2);
    assert.ok(first.includes(users[2]));
    const second = await claim();
    assert.deepEqual([...first, ...second].sort(), users);
    assert.deepEqual(await claim(), []);
    await pg.exec("UPDATE stock_scan_claims SET checked_at=now()-interval '3 minutes'");
    await pg.query("UPDATE stock_scan_claims SET checked_at=now()-interval '10 minutes' WHERE user_id=$1", [users[1]]);
    assert.deepEqual((await claim()).sort(), [users[1], users[2]]);
    // A never-scanned account keeps its actual waiting time even in a backlog lasting many intervals.
    await pg.query('DELETE FROM stock_scan_claims WHERE user_id=$1', [users[0]]);
    await pg.query("UPDATE stock_autopilot SET updated_at=now()-interval '2 hours' WHERE user_id=$1", [users[0]]);
    await pg.exec("UPDATE stock_scan_claims SET checked_at=now()-interval '10 minutes'");
    assert.ok((await claim()).includes(users[0]));
    const privilege = await pg.query<{ allowed: boolean }>("SELECT has_function_privilege('authenticated','claim_stock_scan_accounts()','execute') AS allowed");
    assert.equal(privilege.rows[0].allowed, false);
  } finally { await pg.close(); }
});
