import { calculateAnalytics, buildMonthlyPnL, executionStats } from './analytics';
import { resultsByTag } from './journal';
import type { Trade } from '@/types';

export async function analyticsReport(page: (afterId: string | null) => Promise<Trade[]>) {
  const trades: Trade[] = [];
  let cursor: string | null = null;
  for (;;) {
    const batch = await page(cursor);
    if (!batch.length) break;
    const last = batch[batch.length - 1].id;
    if (cursor && last <= cursor) throw new Error('Trade history cursor did not advance');
    trades.push(...batch);
    cursor = last;
  }
  const stats = calculateAnalytics(trades);
  const ratios = {
    profitFactor: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null,
    avgWinLossRatio: Number.isFinite(stats.avgWinLossRatio) ? stats.avgWinLossRatio : null,
  };
  return { stats: { ...stats, ...ratios }, monthly: buildMonthlyPnL(trades), tags: resultsByTag(trades), execution: executionStats(trades) };
}
export type AnalyticsReport = Awaited<ReturnType<typeof analyticsReport>>;
