import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { buildScanRows, KEEP_DAYS, SCAN_MS, summariseGaps, type ScanRow, type SummaryRow } from './model';

type Db = ReturnType<typeof createServiceClient>;
type Feed = Pick<ReturnType<typeof marketDataClient>, 'getPredictedFundings' | 'getAssetContexts'>;

/** Records one five-minute reading per market. Reads public market data only and places no order. */
export async function scanFundingGaps(db: Db, now: number, feed: Feed = marketDataClient()) {
  const bucket = Math.floor(now / SCAN_MS) * SCAN_MS;
  const [predicted, contexts] = await Promise.all([feed.getPredictedFundings(), feed.getAssetContexts()]);
  const rows = buildScanRows(predicted, contexts);
  if (!rows.length) throw new Error('The funding feed returned no comparable markets.');
  const scanned_at = new Date(bucket).toISOString();
  const saved = await db.from('funding_gap_scans').insert(rows.map(row => ({ scanned_at, ...row })));
  // 23505: this five-minute reading is already recorded.
  if (saved.error && saved.error.code !== '23505') throw new Error(`Could not record the funding scan: ${saved.error.message}`);
  if (new Date(bucket).getUTCMinutes() < 5) {
    const pruned = await db.from('funding_gap_scans').delete().lt('scanned_at', new Date(bucket - KEEP_DAYS * 86_400_000).toISOString());
    if (pruned.error) throw new Error(`Could not prune old funding scans: ${pruned.error.message}`);
  }
  return saved.error ? 0 : rows.length;
}

export async function readFundingGaps(db: Db, days: number, now = Date.now()) {
  const since = new Date(now - days * 86_400_000).toISOString();
  const [summary, last] = await Promise.all([
    db.rpc('funding_gap_summary', { since }),
    db.from('funding_gap_scans').select('scanned_at').order('scanned_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (summary.error) throw new Error(summary.error.message);
  if (last.error) throw new Error(last.error.message);
  const latestAt: string | null = last.data?.scanned_at ?? null;
  let latest: ScanRow[] = [];
  if (latestAt) {
    const rows = await db.from('funding_gap_scans').select('symbol,hl_rate,binance_rate,bybit_rate,hl_spread,hl_volume').eq('scanned_at', latestAt);
    if (rows.error) throw new Error(rows.error.message);
    latest = rows.data as ScanRow[];
  }
  const rows = (summary.data ?? []) as SummaryRow[];
  return { latestAt, markets: rows.length, scans: rows.reduce((most, row) => Math.max(most, Number(row.scans)), 0), gaps: summariseGaps(rows, latest) };
}
