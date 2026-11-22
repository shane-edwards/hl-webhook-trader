// Keeps this app's trade log in step with the exchange:
//   1. Rows still "open" whose position is gone (stop hit, liquidated, closed
//      on Hyperliquid directly) are settled from the exchange's own fills.
//   2. Closed rows get their true fees, funding and realised P&L.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HyperliquidClient } from '@/lib/hyperliquid/client';
import { getUserFills, getUserFunding, type Fill, type FundingPayment } from '@/lib/hyperliquid/public';
import { closeOpenTrades } from '@/lib/trade-records';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** Note written on rows cancelled because the exchange shows neither a position nor a closing fill. */
export const NO_FILL_NOTE = 'No position and no closing fill found on the exchange; cancelled without a profit or loss';

const isClosing = (f: Fill) => /^Close|>/.test(f.dir) || f.closedPnl !== 0;

/**
 * Average exit price and time for a position that closed after `entryTime`,
 * from the fills that reduced it. Null when the exchange shows none.
 */
export function exitFromFills(fills: Fill[], symbol: string, entryTime: number): { price: number; time: number } | null {
  const closes = fills.filter(f => f.coin === symbol && f.time > entryTime && isClosing(f));
  const size = closes.reduce((a, f) => a + f.sz, 0);
  if (!(size > 0)) return null;
  return { price: closes.reduce((a, f) => a + f.px * f.sz, 0) / size, time: Math.max(...closes.map(f => f.time)) };
}

export interface TradeWindow { id: string; symbol: string; size: number; entryTime: number; exitTime: number }
export interface TrueCosts { fees: number; fundingPaid: number; exchangePnl: number; netPnl: number }

/**
 * Fees, funding and realised P&L for closed trades, from the exchange's
 * records. Rows of one symbol whose holding periods overlap were one position
 * on the exchange, so they share its fills in proportion to size.
 */
export function attributeCosts(trades: TradeWindow[], fills: Fill[], funding: FundingPayment[]): Map<string, TrueCosts> {
  const out = new Map<string, TrueCosts>();
  const SLACK = 5_000; // fills are stamped a moment before or after our own record
  const bySymbol = new Map<string, TradeWindow[]>();
  for (const t of trades) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) ?? []), t]);

  for (const [symbol, list] of bySymbol) {
    // Merge overlapping holding periods into one position episode.
    const sorted = [...list].sort((a, b) => a.entryTime - b.entryTime);
    const groups: TradeWindow[][] = [];
    let end = -Infinity;
    for (const t of sorted) {
      if (groups.length && t.entryTime <= end) groups[groups.length - 1].push(t); else groups.push([t]);
      end = Math.max(end, t.exitTime);
    }
    for (const group of groups) {
      const from = Math.min(...group.map(t => t.entryTime)) - SLACK, to = Math.max(...group.map(t => t.exitTime)) + SLACK;
      const fs = fills.filter(f => f.coin === symbol && f.time >= from && f.time <= to);
      const fees = fs.reduce((a, f) => a + f.fee, 0);
      const pnl = fs.reduce((a, f) => a + f.closedPnl, 0);
      const fundingNet = funding.filter(f => f.coin === symbol && f.time >= from && f.time <= to).reduce((a, f) => a + f.usdc, 0);
      const total = group.reduce((a, t) => a + t.size, 0);
      for (const t of group) {
        const share = total > 0 ? t.size / total : 1 / group.length;
        const c = { fees: fees * share, fundingPaid: -fundingNet * share, exchangePnl: pnl * share };
        out.set(t.id, { ...c, netPnl: c.exchangePnl - c.fees - c.fundingPaid });
      }
    }
  }
  return out;
}

export interface SyncResult { settled: string[]; costed: number; notes: string[] }

/** One reconcile pass for a user. Never throws; problems are returned as notes. */
export async function syncAccount(hl: HyperliquidClient, db: Db, userId: string, now = Date.now(), minAgeMs = 90_000): Promise<SyncResult> {
  const result: SyncResult = { settled: [], costed: 0, notes: [] };
  try {
    const [{ data: open }, { data: unsynced, error: unsyncedError }] = await Promise.all([
      db.from('trades').select('id, symbol, side, size, entry_time').eq('user_id', userId).eq('status', 'open'),
      db.from('trades').select('id, symbol, size, entry_time, exit_time').eq('user_id', userId).eq('status', 'closed')
        .is('fills_synced_at', null).order('exit_time', { ascending: false }).limit(40),
    ]);
    // Leave very recent rows alone: the fill may not be in the exchange's history yet.
    const openRows = (open ?? []).filter(t => now - new Date(t.entry_time).getTime() > minAgeMs);
    const toCost = unsyncedError ? [] : (unsynced ?? []).filter(t => t.exit_time && now - new Date(t.exit_time).getTime() > 90_000);
    if (!openRows.length && !toCost.length) return result;

    const earliest = Math.min(...[...openRows, ...toCost].map(t => new Date(t.entry_time).getTime()));
    const start = Math.max(earliest - 60_000, now - 90 * 86_400_000);
    const [{ fills, truncated }, funding, positions] = await Promise.all([
      getUserFills(hl.address, start, hl.isTestnet),
      toCost.length ? getUserFunding(hl.address, start, hl.isTestnet) : Promise.resolve([]),
      hl.getPositions(),
    ]);
    // With a truncated list only the oldest 2,000 fills came back; anything after the last one is unknown.
    const knownUntil = truncated && fills.length ? fills[fills.length - 1].time : Infinity;

    // ---- 1. open rows with no position behind them ----
    const held = new Map(positions.map(p => [p.symbol, p.side]));
    for (const symbol of new Set(openRows.map(t => t.symbol))) {
      const rows = openRows.filter(t => t.symbol === symbol);
      if (held.get(symbol) === rows[0].side) continue;
      const entry = Math.min(...rows.map(t => new Date(t.entry_time).getTime()));
      const exit = exitFromFills(fills, symbol, entry);
      if (exit) {
        const ids = await closeOpenTrades(db, userId, symbol, exit.price, 'Closed on the exchange (stop, target, liquidation or by hand); exit price from the exchange fills', new Date(exit.time));
        result.settled.push(...ids);
        result.notes.push(`${symbol}: position closed on the exchange at about ${exit.price.toPrecision(6)}; ${ids.length} trade record${ids.length === 1 ? '' : 's'} settled`);
      } else if (!truncated) {
        // No position and no closing fill in the exchange's history: there is no honest exit price, so
        // the rows are cancelled without a profit or loss rather than closed at a price nobody traded at.
        const stamp = new Date(now).toISOString();
        const { data: cancelled } = await db.from('trades')
          .update({ status: 'cancelled', exit_time: stamp, notes: NO_FILL_NOTE, updated_at: stamp })
          .eq('user_id', userId).eq('symbol', symbol).eq('status', 'open').select('id');
        const n = cancelled?.length ?? rows.length;
        result.notes.push(`${symbol}: ${n} open trade record${n === 1 ? '' : 's'} had no position and no closing fill on the exchange; marked cancelled with no profit or loss`);
      }
    }

    // ---- 2. true costs for closed rows ----
    const windows: TradeWindow[] = toCost
      .map(t => ({ id: t.id, symbol: t.symbol, size: Number(t.size), entryTime: new Date(t.entry_time).getTime(), exitTime: new Date(t.exit_time).getTime() }))
      .filter(w => w.entryTime >= start && w.exitTime + 5_000 < knownUntil);
    const costs = attributeCosts(windows, fills, funding);
    for (const [id, c] of costs) {
      const { error } = await db.from('trades').update({
        fees: c.fees, funding_paid: c.fundingPaid, exchange_pnl: c.exchangePnl, net_pnl: c.netPnl,
        fills_synced_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      }).eq('id', id);
      if (!error) result.costed += 1;
    }
  } catch (err) {
    result.notes.push(`Reconcile failed: ${err instanceof Error ? err.message : err}`);
  }
  return result;
}
