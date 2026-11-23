import { createServiceClient } from './supabase/server';
import { hlClientFromSettings } from './hyperliquid/from-settings';
import { withTradingLock } from './trading-lock';
import { executeWebhookJob } from './webhook-worker';

export async function processWebhookQueue(): Promise<number> {
  const db = createServiceClient();
  // A worker that vanished mid-operation must be investigated before a new signal
  // is sent. Processing jobs are never automatically executed for a second time.
  const stale = await db.from('webhook_jobs').select('id, user_id').eq('status', 'processing').lt('started_at', new Date(Date.now() - 180_000).toISOString());
  for (const job of stale.data ?? []) {
    await db.from('settings').update({ trading_halted: true, flatten_pending: true }).eq('user_id', job.user_id);
    await db.from('webhook_jobs').update({ status: 'error', result: { error: 'Worker interrupted. Reconcile the account before resuming.' } }).eq('id', job.id).eq('status', 'processing');
  }
  const jobs = await db.from('webhook_jobs').select('*').eq('status', 'queued').order('created_at').limit(1);
  if (jobs.error) throw new Error(jobs.error.message);
  let processed = 0;
  for (const job of jobs.data ?? []) {
    const { data: settings } = await db.from('settings').select('*').eq('user_id', job.user_id).single();
    const hl = hlClientFromSettings(settings);
    if (!hl) {
      await db.from('webhook_jobs').update({ status: 'error', result: { error: 'Wallet unavailable' } }).eq('id', job.id);
      continue;
    }
    try {
      await withTradingLock(hl, db, job.user_id, async () => {
        const claim = await db.from('webhook_jobs').update({ status: 'processing', started_at: new Date().toISOString() }).eq('id', job.id).eq('status', 'queued').select('id').maybeSingle();
        if (claim.error) throw new Error(claim.error.message);
        if (!claim.data) return;
        if (Date.now() - new Date(job.created_at).getTime() > 180_000) {
          await db.from('webhook_jobs').update({ status: 'error', result: { error: 'Signal expired before execution' } }).eq('id', job.id);
          return;
        }
        // Use the leased client for the entire execution, including reversals.
        const response = await executeWebhookJob(job.user_id, job.payload, hl);
        const result = await response.json();
        const saved = await db.from('webhook_jobs').update({ status: response.ok ? 'done' : 'error', result }).eq('id', job.id);
        if (saved.error) throw new Error(saved.error.message);
        processed++;
      });
    } catch (err) {
      if (/already processing/.test(String(err))) continue;
      await db.from('webhook_jobs').update({ status: 'error', result: { error: String(err) } }).eq('id', job.id);
    }
  }
  return processed;
}
