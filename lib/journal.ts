// Trade journal: each manual trade is tagged with how it related to the
// built-in rules' read at the time, so results can be compared by habit
// ("followed the read" versus "went against it"). Tags travel in the trade
// row's webhook_payload.journal, so no schema change is needed.
import type { Trade } from '@/types';

export type ReadTag = 'followed' | 'against' | 'no_read';
export type StopTag = 'suggested' | 'changed' | 'none';

export interface Journal { read: ReadTag; stop: StopTag; note?: string }

export const READ_LABEL: Record<ReadTag, string> = { followed: 'Followed the read', against: 'Against the read', no_read: 'No read' };
export const STOP_LABEL: Record<StopTag, string> = { suggested: 'Suggested stop', changed: 'Changed the stop', none: 'No stop' };

/**
 * `context` is what the ticket showed when the order was sent: the rules' bias
 * and the stop they suggested for the chosen side.
 */
export function journalTags(p: { side: 'long' | 'short'; stopLossPct: number | null; context: unknown; note?: unknown }): Journal {
  const c = (p.context && typeof p.context === 'object' ? p.context : {}) as { bias?: unknown; suggestedStopPct?: unknown };
  const read: ReadTag = c.bias === 'long' || c.bias === 'short' ? (c.bias === p.side ? 'followed' : 'against') : 'no_read';
  const suggested = Number(c.suggestedStopPct);
  const stop: StopTag = p.stopLossPct == null ? 'none' : Number.isFinite(suggested) && Math.abs(suggested - p.stopLossPct) < 0.051 ? 'suggested' : 'changed';
  const note = typeof p.note === 'string' ? p.note.trim().slice(0, 500) : '';
  return { read, stop, ...(note ? { note } : {}) };
}

export function journalOf(trade: Pick<Trade, 'webhook_payload' | 'signal_source'>): Journal | null {
  const j = (trade.webhook_payload as { journal?: Partial<Journal> } | null | undefined)?.journal;
  if (!j || !j.read || !j.stop) return null;
  return { read: j.read, stop: j.stop, note: j.note };
}

/** Net result of a trade: the exchange's figure once synced, otherwise price move less any recorded costs. */
export function netPnl(t: Pick<Trade, 'pnl' | 'fees' | 'funding_paid'> & { net_pnl?: number | null }): number {
  if (t.net_pnl != null) return Number(t.net_pnl);
  return Number(t.pnl ?? 0) - Number(t.fees ?? 0) - Number(t.funding_paid ?? 0);
}

export interface TagResult { tag: string; trades: number; wins: number; winRate: number; total: number; average: number }

/** Results of closed manual trades grouped by journal tag. */
export function resultsByTag(trades: Trade[]): { read: TagResult[]; stop: TagResult[] } {
  const closed = trades.filter(t => t.status === 'closed' && t.pnl != null && t.signal_source === 'manual');
  const group = <K extends string>(labels: Record<K, string>, key: (j: Journal) => K): TagResult[] =>
    (Object.keys(labels) as K[]).map(k => {
      const rows = closed.filter(t => { const j = journalOf(t); return j != null && key(j) === k; });
      const nets = rows.map(netPnl);
      const total = nets.reduce((a, b) => a + b, 0), wins = nets.filter(x => x > 0).length;
      return { tag: labels[k], trades: rows.length, wins, winRate: rows.length ? (wins / rows.length) * 100 : 0, total, average: rows.length ? total / rows.length : 0 };
    });
  return { read: group(READ_LABEL, j => j.read), stop: group(STOP_LABEL, j => j.stop) };
}
