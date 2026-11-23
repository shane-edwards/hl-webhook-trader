import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/webhook/route';

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
