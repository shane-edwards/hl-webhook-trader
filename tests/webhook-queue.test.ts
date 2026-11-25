import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/webhook/route';
import { requireEntryStop } from '../lib/webhook';
import { executeWebhookJob } from '../lib/webhook-worker';
import { SimExchange } from './helpers';

test('webhook acknowledges durable acceptance and deduplicates retry delivery without contacting the exchange', async t => {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://queue-test.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const jobs = new Map<string, Record<string, unknown>>();
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://queue-test.supabase.co/rest/v1/'), 'acceptance only uses the database');
    if (url.includes('/settings')) return Response.json({ user_id: '00000000-0000-4000-8000-000000000001', webhook_enabled: true, trading_halted: false });
    assert.ok(url.includes('/webhook_jobs'));
    if (init?.method === 'POST') {
      const row = JSON.parse(String(init.body));
      assert.equal(row.payload.secret, undefined);
      if (jobs.has(row.signal_id)) return Response.json({ code: '23505', message: 'duplicate' }, { status: 409 });
      const stored = { ...row, id: 'job-id', status: 'queued' };
      jobs.set(row.signal_id, stored);
      return Response.json(stored, { status: 201 });
    }
    return Response.json([...jobs.values()][0]);
  });
  const payload = { secret: 'a-valid-webhook-secret', signal_id: 'Long Entry-2026-11-23T00:00:00Z', action: 'buy', symbol: 'BTC' };
  const deliver = () => POST(new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify(payload) }));
  const first = await deliver();
  assert.equal(first.status, 202);
  const retry = await deliver();
  assert.equal(retry.status, 200);
  assert.equal(jobs.size, 1);
  const invalid = await POST(new Request('https://app.test/api/webhook', { method: 'POST', body: JSON.stringify({ ...payload, signal_id: undefined }) }));
  assert.equal(invalid.status, 400);
});

test('a webhook entry needs a stop from the alert or from Settings', () => {
  const open = { type: 'open', side: 'long' } as const;
  assert.deepEqual(requireEntryStop(open, 2), { plan: open, refused: null });
  const refusedOpen = requireEntryStop(open, null);
  assert.equal(refusedOpen.plan.type, 'none');
  assert.match(refusedOpen.refused!, /No stop-loss.*No long was opened/);
  // A reversal still closes the position the signal no longer wants, and opens nothing.
  const refusedReverse = requireEntryStop({ type: 'reverse', side: 'short' }, null);
  assert.deepEqual(refusedReverse.plan, { type: 'close' });
  assert.match(refusedReverse.refused!, /closed and no short was opened/);
  // Closing and doing nothing never need a stop.
  assert.deepEqual(requireEntryStop({ type: 'close' }, null), { plan: { type: 'close' }, refused: null });
  const none = { type: 'none', reason: 'Already long' } as const;
  assert.deepEqual(requireEntryStop(none, null), { plan: none, refused: null });
});

// The worker against a simulated exchange, with the database answered over a mocked connection.
async function runWebhook(t: TestContext, settings: Record<string, unknown>, payload: Record<string, unknown>, sim: SimExchange) {
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: 'https://worker-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key' });
  for (const name of ['NTFY_TOPIC', 'TELEGRAM_BOT_TOKEN', 'RESEND_API_KEY']) delete process.env[name];
  const logs: Array<Record<string, unknown>> = [];
  const alerts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith('https://worker-test.supabase.co/rest/v1/'), `only the database is contacted: ${url}`);
    if (url.includes('/rpc/')) return Response.json(true);
    if (url.includes('/settings')) return Response.json({ user_id: USER, webhook_enabled: true, webhook_secret: 'a-valid-webhook-secret', strategy_enabled: false,
      default_leverage: 2, default_order_size_usd: 100, max_position_size_usd: 1000, slippage_percent: 1, ...settings });
    if (init?.method === 'POST' && url.includes('/webhook_logs')) logs.push(JSON.parse(String(init.body)));
    if (init?.method === 'POST' && url.includes('/alerts')) alerts.push(JSON.parse(String(init.body)).message);
    return Response.json([], { status: init?.method === 'POST' ? 201 : 200 });
  });
  const response = await executeWebhookJob(USER, payload, sim as never);
  return { body: await response.json(), status: response.status, logs, alerts };
}
const USER = '00000000-0000-4000-8000-000000000001';

test('a webhook entry with no stop on the alert and none in Settings is refused and nothing is sent', async t => {
  const sim = new SimExchange({ BTC: 50_000 });
  const run = await runWebhook(t, { default_stop_loss_percent: null }, { action: 'buy', symbol: 'BTC', signal_id: 'no-stop' }, sim);
  assert.equal(run.body.success, false);
  assert.match(run.body.message, /No stop-loss/);
  assert.equal(sim.positions.size, 0, 'no order reached the exchange');
  assert.equal(run.logs.length, 1);
  assert.equal(run.logs[0].status, 'rejected');
  assert.ok(run.alerts.some(message => /signal refused/.test(message)), 'the owner is told');
});

test('a reversal with no stop closes the old position and opens nothing', async t => {
  const sim = new SimExchange({ BTC: 50_000 });
  sim.positions.set('BTC', { side: 'long', size: 0.002, entryPrice: 50_000 });
  const run = await runWebhook(t, { default_stop_loss_percent: null }, { position: 'short', symbol: 'BTC', signal_id: 'flip' }, sim);
  assert.equal(run.body.action, 'close');
  assert.match(run.body.message, /no short was opened/);
  assert.equal(sim.positions.size, 0, 'the long is closed and no short replaces it');
});

test('a webhook entry with a stop on the alert or a default in Settings opens with that stop resting', async t => {
  for (const [settings, payload, stopPx] of [
    [{ default_stop_loss_percent: null }, { action: 'buy', symbol: 'BTC', signal_id: 'own-stop', stop_loss_pct: 2 }, 49_000],
    [{ default_stop_loss_percent: 4 }, { action: 'buy', symbol: 'BTC', signal_id: 'default-stop' }, 48_000],
  ] as const) {
    const sim = new SimExchange({ BTC: 50_000 });
    const run = await runWebhook(t, settings, payload, sim);
    assert.equal(run.body.success, true, JSON.stringify(run.body));
    assert.equal(sim.positions.get('BTC')?.side, 'long');
    assert.equal(sim.resting('BTC', 'sl').length, 1);
    assert.ok(Math.abs(sim.resting('BTC', 'sl')[0].px - stopPx) < 1);
    t.mock.restoreAll();
  }
});
