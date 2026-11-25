import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { accountAllowed, safeRedirectPath } from '../lib/access';
import { decrypt, encrypt } from '../lib/encryption';
import { envKeyFor, hlClientFromSettings } from '../lib/hyperliquid/from-settings';
import { processWebhookQueue } from '../lib/webhook-queue';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const KEY_A = '0x' + '11'.repeat(32);
const KEY_B = '0x' + '22'.repeat(32);

function withEnv(t: { after(fn: () => void): void }, values: Record<string, string | undefined>) {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

test('sign-in redirect only ever goes to a path on this site', () => {
  const origin = 'https://app.test';
  assert.equal(safeRedirectPath('/autopilot?tab=live#top', origin), '/autopilot?tab=live#top');
  assert.equal(safeRedirectPath(null, origin), '/strategies');
  for (const hostile of ['@evil.com', '//evil.com', '/\\evil.com', 'https://evil.com/x', 'evil.com', '\\\\evil.com', '/%2F/evil.com/..//evil.com\\x'])
    assert.equal(safeRedirectPath(hostile, origin), '/strategies', hostile);
  // Whatever is returned, joining it to the origin stays on the origin.
  for (const next of ['/a', '/@evil.com', '/a/../b', '/.//evil.com'])
    assert.equal(new URL(safeRedirectPath(next, origin), origin).origin, origin, next);
});

test('with an allowed list only those accounts may use the app, and without one every account may', t => {
  withEnv(t, { ALLOWED_EMAILS: undefined });
  assert.equal(accountAllowed('anyone@example.com'), true);
  process.env.ALLOWED_EMAILS = ' Owner@Example.com , second@example.com,';
  assert.equal(accountAllowed('owner@example.com'), true);
  assert.equal(accountAllowed('SECOND@example.com'), true);
  assert.equal(accountAllowed('stranger@example.com'), false);
  assert.equal(accountAllowed(''), false);
  assert.equal(accountAllowed(undefined), false);
});

test('the deployment-wide trading key is used only for the named owner account', t => {
  withEnv(t, { ENCRYPTION_KEY: 'a'.repeat(64), HL_PRIVATE_KEY: KEY_A, HL_OWNER_USER_ID: OWNER, HL_WALLET_ADDRESS: undefined, HL_TESTNET: 'true' });
  assert.equal(envKeyFor(OWNER), KEY_A);
  assert.equal(envKeyFor(OTHER), undefined);
  assert.equal(envKeyFor(undefined), undefined);

  const stored = encrypt(KEY_B);
  const owner = hlClientFromSettings({ user_id: OWNER, hl_private_key_encrypted: stored });
  const other = hlClientFromSettings({ user_id: OTHER, hl_private_key_encrypted: stored });
  assert.ok(owner && other);
  assert.notEqual(owner.address, other.address, 'another account signs with its own stored key, never the deployment key');
  assert.equal(hlClientFromSettings({ user_id: OTHER, hl_private_key_encrypted: null }), null, 'an account with no key of its own gets no client');

  // Without an owner named, the documented single-user behaviour is unchanged.
  delete process.env.HL_OWNER_USER_ID;
  assert.equal(envKeyFor(OTHER), KEY_A);
});

test('a shortened authentication tag is refused', t => {
  withEnv(t, { ENCRYPTION_KEY: 'b'.repeat(64) });
  const [salt, iv, tag, body] = encrypt('secret').split(':');
  assert.equal(decrypt([salt, iv, tag, body].join(':')), 'secret');
  assert.throws(() => decrypt([salt, iv, tag.slice(0, 8), body].join(':')), /Invalid ciphertext format/);
});

test('an unreadable stored key fails its own webhook job and leaves the queue running', async t => {
  withEnv(t, { NEXT_PUBLIC_SUPABASE_URL: 'https://queue-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    ENCRYPTION_KEY: 'c'.repeat(64), HL_PRIVATE_KEY: undefined, HL_OWNER_USER_ID: undefined });
  const job = { id: 'job-1', user_id: OWNER, status: 'queued', created_at: new Date().toISOString(), payload: {} };
  const updates: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://queue-test.supabase.co/rest/v1/'), 'only the database is contacted');
    const method = init?.method ?? 'GET';
    if (url.includes('/settings')) return Response.json({ user_id: OWNER, hl_private_key_encrypted: 'not:a:valid:ciphertext', is_testnet: true });
    assert.ok(url.includes('/webhook_jobs'));
    if (method === 'PATCH') {
      const patch = JSON.parse(String(init?.body));
      updates.push(patch);
      if (job.status === 'queued') Object.assign(job, patch);
      return Response.json([]);
    }
    if (url.includes('status=eq.processing')) return Response.json([]);
    return Response.json(job.status === 'queued' ? [job] : []);
  });

  assert.equal(await processWebhookQueue(), 0);
  assert.equal(job.status, 'error');
  assert.deepEqual(updates, [{ status: 'error', result: { error: 'Wallet unavailable' } }]);
  // The next scan finds nothing queued instead of failing on the same job again.
  assert.equal(await processWebhookQueue(), 0);
  assert.equal(updates.length, 1);
});

test('migrations 023 and 025 leave settings and trade records writable by the server only', async () => {
  const pg = new PGlite({ extensions: { uuid_ossp } });
  try {
    await pg.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
    `);
    await pg.exec(readFileSync('supabase/migrations/001_initial.sql', 'utf8'));
    // Supabase grants these roles full table access by default; row level security is the only gate.
    await pg.exec('GRANT ALL ON public.settings, public.trades TO anon, authenticated;');
    const policies = async () => (await pg.query<{ tablename: string; policyname: string }>(
      "SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('settings','trades') ORDER BY 1,2")).rows.map(row => `${row.tablename}: ${row.policyname}`);
    assert.ok((await policies()).includes('settings: Users can update own settings'), 'the starting point has the policy this migration removes');

    await pg.exec(readFileSync('supabase/migrations/023_server_only_writes.sql', 'utf8'));
    // Running it twice is harmless.
    await pg.exec(readFileSync('supabase/migrations/023_server_only_writes.sql', 'utf8'));

    assert.deepEqual(await policies(), [
      'settings: Service role has full access to settings',
      'trades: Service role has full access to trades',
      'trades: Users can view own trades',
    ]);
    const can = async (role: string, table: string, privilege: string) => (await pg.query<{ ok: boolean }>(
      'SELECT has_table_privilege($1, $2, $3) AS ok', [role, `public.${table}`, privilege])).rows[0].ok;
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await can(role, 'settings', privilege), false, `${role} ${privilege} settings`);
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(await can(role, 'trades', privilege), false, `${role} ${privilege} trades`);
    }
    assert.equal(await can('authenticated', 'trades', 'SELECT'), true, 'a signed-in session can still read its own trades');

    // Migration 025: a visitor who is not signed in loses the table privilege as well.
    assert.equal(await can('anon', 'trades', 'SELECT'), true);
    await pg.exec(readFileSync('supabase/migrations/025_revoke_anon_trades.sql', 'utf8'));
    await pg.exec(readFileSync('supabase/migrations/025_revoke_anon_trades.sql', 'utf8'));
    assert.equal(await can('anon', 'trades', 'SELECT'), false);
    assert.equal(await can('authenticated', 'trades', 'SELECT'), true);
  } finally {
    await pg.close();
  }
});
