// Test doubles: an in-memory database with the slice of the Supabase query
// builder the app uses, and a simulated exchange that fills resting orders and
// fires stop / target triggers as the price is moved.
import type { HyperliquidClient, TriggerLeg } from '../lib/hyperliquid/client';

type Row = Record<string, unknown>;

export function memoryDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = { ...seed };
  let seq = 0;
  const from = (name: string) => {
    tables[name] ??= [];
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'delete' = 'select';
    let patch: Row = {};
    let inserted: Row[] | null = null;
    let limit = Infinity;
    let order: { key: string; asc: boolean } | null = null;
    const exec = () => {
      if (inserted) return { data: inserted, error: null };
      let rows = tables[name].filter(r => filters.every(f => f(r)));
      if (op === 'update') rows.forEach(r => Object.assign(r, patch));
      if (op === 'delete') tables[name] = tables[name].filter(r => !rows.includes(r));
      if (order) { const { key, asc } = order; rows = [...rows].sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1) * (asc ? 1 : -1)); }
      return { data: rows.slice(0, limit), error: null };
    };
    const add = (f: (r: Row) => boolean) => { filters.push(f); return q; };
    const q: Record<string, unknown> = {
      select: () => { if (op === 'update') { const r = exec(); inserted = r.data; op = 'select'; } return q; },
      eq: (k: string, v: unknown) => add(r => r[k] === v),
      is: (k: string, v: unknown) => add(r => (r[k] ?? null) === v),
      in: (k: string, v: unknown[]) => add(r => v.includes(r[k])),
      gte: (k: string, v: string) => add(r => String(r[k]) >= v),
      lt: (k: string, v: string) => add(r => String(r[k]) < v),
      order: (key: string, o?: { ascending?: boolean }) => { order = { key, asc: o?.ascending !== false }; return q; },
      limit: (n: number) => { limit = n; return q; },
      update: (p: Row) => { op = 'update'; patch = p; return q; },
      delete: () => { op = 'delete'; return q; },
      insert: (rows: Row | Row[]) => {
        inserted = (Array.isArray(rows) ? rows : [rows]).map(r => ({ id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, created_at: new Date().toISOString(), ...r }));
        tables[name].push(...inserted);
        return q;
      },
      upsert: (r: Row) => {
        const key = 'user_id' in r ? 'user_id' : 'symbol' in r ? 'symbol' : 'key';
        const i = tables[name].findIndex(x => x[key] === r[key]);
        if (i >= 0) Object.assign(tables[name][i], r); else tables[name].push({ ...r });
        return Promise.resolve({ data: null, error: null });
      },
      single: async () => ({ data: exec().data[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: exec().data[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(exec()).then(ok, bad),
    };
    return q;
  };
  return { db: { from, rpc: memoryRpc() } as never, tables };
}

interface SimOrder {
  oid: number; coin: string; isBuy: boolean; size: number; origSize: number; px: number;
  kind: 'limit' | 'sl' | 'tp'; reduceOnly: boolean;
  /** Children of a limit entry wait for it to fill. */
  parent: number | null; active: boolean;
  status: 'open' | 'filled' | 'canceled' | 'triggered';
}

export class SimExchange {
  prices = new Map<string, number>();
  positions = new Map<string, { side: 'long' | 'short'; size: number; entryPrice: number }>();
  orders: SimOrder[] = [];
  equity = 10_000;
  /** When true, children of a limit entry are silently dropped (to test the scan's backstop). */
  dropChildren = false;
  readonly address = '0x0000000000000000000000000000000000000001';
  readonly isTestnet = true;
  private seq = 1000;

  constructor(prices: Record<string, number>) { for (const [k, v] of Object.entries(prices)) this.prices.set(k, v); }

  get client(): HyperliquidClient { return this as unknown as HyperliquidClient; }
  private open() { return this.orders.filter(o => o.status === 'open'); }

  async getAsset(coin: string) { return { index: 0, meta: { name: coin, szDecimals: 3, maxLeverage: 50 } }; }
  async getMarkPrice(coin: string) { return this.prices.get(coin)!; }
  /** A one-level book around the price: `spread` wide, `depthUsd` deep on each side. */
  spread = 0; depthUsd = 1e9;
  async getBook(coin: string) {
    const px = this.prices.get(coin)!, sz = this.depthUsd / px;
    return { bids: [{ px: px - this.spread / 2, sz }], asks: [{ px: px + this.spread / 2, sz }] };
  }
  /** When set, the next stop-loss placement is rejected (to test what happens to an unprotected position). */
  rejectStops = false;
  async setLeverage() {}
  async getAccountSummary() { return { totalValue: this.equity, unrealizedPnl: 0, marginUsed: 0, withdrawable: this.equity }; }
  async getPositions() {
    return [...this.positions].map(([symbol, p]) => ({ symbol, ...p, markPrice: this.prices.get(symbol)!, unrealizedPnl: 0, unrealizedPnlPercent: 0, leverage: 1, liquidationPrice: 0, marginUsed: 0 }));
  }
  async getPosition(coin: string) { return (await this.getPositions()).find(p => p.symbol === coin) ?? null; }

  private fill(coin: string, isBuy: boolean, size: number, px: number, reduceOnly: boolean): number {
    const pos = this.positions.get(coin);
    const closing = pos && (pos.side === 'long') !== isBuy;
    if (closing) {
      const done = Math.min(size, pos.size);
      pos.size = Math.round((pos.size - done) * 1e6) / 1e6;
      if (pos.size <= 0) this.positions.delete(coin);
      return done;
    }
    if (reduceOnly) return 0;
    if (pos) { pos.entryPrice = (pos.entryPrice * pos.size + px * size) / (pos.size + size); pos.size += size; }
    else this.positions.set(coin, { side: isBuy ? 'long' : 'short', size, entryPrice: px });
    return size;
  }

  async placeMarketOrder(p: { coin: string; isBuy: boolean; sizeUsd: number }) {
    // A market order crosses half the spread.
    const mid = this.prices.get(p.coin)!, px = mid + (p.isBuy ? 1 : -1) * this.spread / 2, size = Math.floor((p.sizeUsd / px) * 1000) / 1000;
    this.fill(p.coin, p.isBuy, size, px, false);
    return { orderId: String(++this.seq), fillPrice: px, sizeInContracts: size, decisionPrice: mid };
  }
  async closePosition(coin: string) {
    const pos = this.positions.get(coin);
    if (!pos) throw new Error(`No open position for ${coin}`);
    this.positions.delete(coin);
    return { fillPrice: this.prices.get(coin)!, filledSize: pos.size, side: pos.side, fullyClosed: true };
  }

  async placeTriggerOrders(p: { coin: string; side: 'long' | 'short'; legs: TriggerLeg[] }) {
    if (this.rejectStops && p.legs.some(l => l.kind === 'sl')) throw new Error('Stop-loss rejected: simulated');
    return p.legs.map(l => {
      const oid = ++this.seq;
      this.orders.push({ oid, coin: p.coin, isBuy: p.side === 'short', size: l.size, origSize: l.size, px: l.triggerPx, kind: l.kind, reduceOnly: true, parent: null, active: true, status: 'open' });
      return String(oid);
    });
  }
  async placeProtectiveOrders(p: { coin: string; side: 'long' | 'short'; size: number; stopLossPx?: number; takeProfitPx?: number }) {
    const legs: TriggerLeg[] = [];
    if (p.stopLossPx != null) legs.push({ kind: 'sl', triggerPx: p.stopLossPx, size: p.size });
    if (p.takeProfitPx != null) legs.push({ kind: 'tp', triggerPx: p.takeProfitPx, size: p.size });
    const oids = await this.placeTriggerOrders({ coin: p.coin, side: p.side, legs });
    return { stopLossOid: p.stopLossPx != null ? oids[0] : null, takeProfitOid: p.takeProfitPx != null ? oids[oids.length - 1] : null };
  }
  async placeLimitEntry(p: { coin: string; isBuy: boolean; size: number; price: number; stopLossPx?: number; takeProfitPx?: number }) {
    const oid = ++this.seq, size = Math.floor(p.size * 1000) / 1000;
    this.orders.push({ oid, coin: p.coin, isBuy: p.isBuy, size, origSize: size, px: p.price, kind: 'limit', reduceOnly: false, parent: null, active: true, status: 'open' });
    if (!this.dropChildren) {
      for (const [kind, px] of [['sl', p.stopLossPx], ['tp', p.takeProfitPx]] as const) {
        if (px != null) this.orders.push({ oid: ++this.seq, coin: p.coin, isBuy: !p.isBuy, size, origSize: size, px, kind, reduceOnly: true, parent: oid, active: false, status: 'open' });
      }
    }
    return { oid: String(oid), size, price: p.price };
  }
  async getOrderStatus(oid: string) {
    const o = this.orders.find(x => x.oid === Number(oid));
    return o ? { status: o.status, filledSize: o.origSize - o.size, originalSize: o.origSize, limitPx: o.px } : null;
  }
  async getOpenOrders(coin?: string) {
    return this.open().filter(o => o.active && (!coin || o.coin === coin)).map(o => ({
      coin: o.coin, oid: o.oid, limitPx: o.px, isTrigger: o.kind !== 'limit', reduceOnly: o.reduceOnly, triggerPx: o.kind === 'limit' ? 0 : o.px,
      side: o.isBuy ? 'buy' as const : 'sell' as const, size: o.size, orderType: o.kind === 'sl' ? 'Stop Market' : o.kind === 'tp' ? 'Take Profit Market' : 'Limit',
    }));
  }
  async cancelOrders(_coin: string, oids: Array<string | number>) {
    for (const o of this.open()) {
      if (oids.map(Number).includes(o.oid) || (o.parent != null && !o.active && oids.map(Number).includes(o.parent))) o.status = 'canceled';
    }
  }
  async cancelProtectiveOrders(coin: string) {
    const mine = this.open().filter(o => o.coin === coin && o.kind !== 'limit' && o.active);
    mine.forEach(o => { o.status = 'canceled'; });
    return mine.length;
  }

  /** Moves the price and lets the book react: resting entries fill, then stops and targets fire. */
  move(coin: string, price: number, fillFraction = 1) {
    this.prices.set(coin, price);
    for (const o of this.open().filter(x => x.coin === coin && x.kind === 'limit')) {
      if (o.isBuy ? price <= o.px : price >= o.px) {
        const size = Math.round(o.size * fillFraction * 1000) / 1000;
        this.fill(coin, o.isBuy, size, o.px, false);
        o.size = Math.round((o.size - size) * 1e6) / 1e6;
        if (o.size <= 0) o.status = 'filled';
        this.orders.filter(c => c.parent === o.oid).forEach(c => { c.active = true; });
      }
    }
    for (const o of this.open().filter(x => x.coin === coin && x.kind !== 'limit' && x.active)) {
      const pos = this.positions.get(coin);
      const long = !o.isBuy; // a sell order protects a long
      const hit = o.kind === 'sl' ? (long ? price <= o.px : price >= o.px) : (long ? price >= o.px : price <= o.px);
      if (hit) { if (pos) this.fill(coin, o.isBuy, o.size, price, true); o.status = 'triggered'; }
    }
  }
  resting(coin: string, kind?: SimOrder['kind']) { return this.open().filter(o => o.coin === coin && o.active && (!kind || o.kind === kind)); }
}

/** Lease/nonce behavior shared by isolated database doubles. */
export function memoryRpc() {
  const leases = new Map<string, string>();
  let nonce = Date.now();
  return async (name: string, args: Record<string, string>) => {
    if (name === 'acquire_trading_lock') {
      if (leases.has(args.resource_key)) return { data: false, error: null };
      leases.set(args.resource_key, args.lease_owner);
      return { data: true, error: null };
    }
    if (name === 'release_trading_lock') leases.delete(args.resource_key);
    return { data: name === 'next_trading_nonce' ? ++nonce : true, error: null };
  };
}
