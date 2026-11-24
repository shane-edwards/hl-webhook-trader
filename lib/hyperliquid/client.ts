import { liveEntryReservation } from '@/lib/trading-lock';
import { ledgerCashflow } from '@/lib/risk/cashflows';
import { ethers } from 'ethers';
import type {
  AssetMeta,
  MetaResponse,
  HyperliquidPosition,
  OrderParams,
  OrderResult,
  AccountSummary,
  HyperliquidConfig,
  ExchangeResponse,
} from './types';
import { limitOrderWire, orderAction, triggerOrderWire, type Grouping, type OrderWire } from './orders';
import { signL1Action } from './signing';
import { assertWithinPortfolioLimits, portfolioLimitsFromSettings } from '@/lib/risk/portfolio';
import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';
const REQUEST_TIMEOUT_MS = 10_000;

/** Hyperliquid rejects orders below this notional. */
export const MIN_ORDER_USD = 10;

export class HyperliquidClient {
  private wallet: ethers.Wallet;
  private baseUrl: string;
  private isMainnet: boolean;
  private accountAddress: string;
  private lastNonce = 0;
  private requireCoordination: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private actionContext?: { db: SupabaseClient<any, any, any>; resource: string; owner: string; userId: string };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setActionContext(db: SupabaseClient<any, any, any>, resource: string, owner: string, userId: string): () => void {
    const previous = this.actionContext;
    this.actionContext = { db, resource, owner, userId };
    return () => { this.actionContext = previous; };
  }
  private assetCache: Map<string, { index: number; meta: AssetMeta }> = new Map();

  constructor(config: HyperliquidConfig) {
    this.wallet = new ethers.Wallet(config.privateKey);
    this.requireCoordination = config.requireCoordination === true;
    this.isMainnet = !config.isTestnet;
    this.baseUrl = config.isTestnet ? TESTNET_URL : MAINNET_URL;

    // With an API (agent) wallet the key signs orders but the funds and
    // positions live on the main account, so state is read from that address.
    const account = config.accountAddress?.trim();
    if (account && !ethers.isAddress(account)) throw new Error('Invalid Hyperliquid account address');
    this.accountAddress = account ? ethers.getAddress(account) : this.wallet.address;
  }

  /** The account whose balance and positions are traded. */
  get address(): string {
    return this.accountAddress;
  }

  get isTestnet(): boolean {
    return !this.isMainnet;
  }

  private async infoRequest<T>(body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hyperliquid info error ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async sendAction(action: unknown): Promise<ExchangeResponse> {
    // Nonces must be unique per signer; keep them strictly increasing within this client.
    let nonce = Math.max(Date.now(), this.lastNonce + 1);
    const wireAction = action as { type: string; orders?: Array<OrderWire & { c?: string }> };
    if (wireAction.orders) wireAction.orders.forEach(o => { o.c ??= `0x${randomBytes(16).toString('hex')}`; });
    const ctx = this.actionContext;
    if (this.requireCoordination && !ctx) throw new Error('Trading requires an account execution lease');
    let actionId: string | undefined;
    let expiresAfter = Date.now() + 15_000;
    if (ctx) {
      const entries = wireAction.orders?.filter(o => !o.r) ?? [];
      if (entries.length) {
        const { data: settings, error } = await ctx.db.from('settings').select('*').eq('user_id', ctx.userId).single();
        if (error || !settings || settings.trading_halted) throw new Error('Trading is halted or account settings are unavailable');
        if (this.requireCoordination) {
          const { hlClientFromSettings } = await import('./from-settings');
          const current = hlClientFromSettings(settings);
          if (!current || current.address.toLowerCase() !== this.address.toLowerCase() || current.isTestnet !== this.isTestnet)
            throw new Error('The connected wallet or network changed. Refresh before placing an order.');
        }
        const recovery = await ctx.db.from('autopilot_positions').select('id').eq('account_resource', ctx.resource)
          .eq('mode', 'live').eq('status', 'open').eq('recovery_pending', true);
        if (recovery.error || recovery.data.some(row => row.id !== liveEntryReservation.getStore()))
          throw new Error('New exposure is blocked while Autopilot reconciles a live entry.');
        // IOC prices include the worst-price guard. Reserve against that bound.
        const notional = entries.reduce((sum, o) => sum + Number(o.s) * Number(o.p), 0);
        await assertWithinPortfolioLimits(this, ctx.db, ctx.userId, notional, portfolioLimitsFromSettings(settings));
        const positions = await this.getPositions();
        const { universe } = await this.getMeta();
        const orders = await this.getOpenOrders();
        for (const entry of entries) {
          const coin = universe[entry.a]?.name;
          const position = positions.find(p => p.symbol === coin);
          if (position && (position.side === 'long') !== entry.b) throw new Error(`Close the existing ${coin} position before reversing`);
          const pending = orders.filter(o => o.coin === coin && !o.reduceOnly).reduce((sum, o) => sum + o.size * o.limitPx, 0);
          if ((position ? position.size * position.markPrice : 0) + pending + Number(entry.s) * Number(entry.p) > Number(settings.max_position_size_usd)) {
            throw new Error(`${coin} would exceed the maximum position size`);
          }
        }
      }
      const allocated = await ctx.db.rpc('next_trading_nonce', {
        resource_key: ctx.resource, lease_owner: ctx.owner,
        signer_key: `${this.isTestnet ? 'testnet' : 'mainnet'}:${this.wallet.address.toLowerCase()}`,
        account_user: ctx.userId, increases_exposure: wireAction.orders?.some(o => !o.r) ?? false,
      });
      if (allocated.error) throw new Error(allocated.error.message);
      nonce = Number(allocated.data);
      expiresAfter = Date.now() + 15_000;
      const journal = await ctx.db.from('exchange_actions').insert({ user_id: ctx.userId, resource: ctx.resource, nonce, action, expires_after: expiresAfter }).select('id').single();
      if (journal.error && entries.length) throw new Error(`Could not record order intent: ${journal.error.message}`);
      actionId = journal.data?.id;
    }
    this.lastNonce = nonce;
    const signature = await signL1Action(this.wallet, action, nonce, this.isMainnet, expiresAfter);

    try {
      const res = await fetch(`${this.baseUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, nonce, signature, expiresAfter }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Hyperliquid exchange error ${res.status}: ${text}`);
      }
      const result = await res.json();
      if (ctx && actionId) {
        const saved = await ctx.db.from('exchange_actions').update({ status: 'confirmed', response: result }).eq('id', actionId);
        // Preserve an acknowledged fill so the caller can protect it, even if
        // the database fails immediately after the exchange responds.
        if (saved.error) await ctx.db.rpc('halt_trading_account', { resource_key: ctx.resource });
      }
      return result;
    } catch (err) {
      if (ctx) {
        await ctx.db.rpc('halt_trading_account', { resource_key: ctx.resource });
        await ctx.db.from('settings').update({ trading_halted: true, flatten_pending: true }).eq('user_id', ctx.userId);
        if (actionId) await ctx.db.from('exchange_actions').update({ status: 'uncertain' }).eq('id', actionId);
        // A delayed entry must expire before we verify the account and close
        // any fill. Otherwise it could arrive after recovery has gone flat.
        if (wireAction.orders?.some(o => !o.r)) await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAfter - Date.now()) + 250));
        // An entry may have filled despite a lost response. Risk-reducing
        // closure is safe to repeat and continues to be allowed while halted.
        for (const order of wireAction.orders?.filter(o => !o.r) ?? []) {
          const { universe } = await this.getMeta();
          const coin = universe[order.a]?.name;
          if (coin && await this.getPosition(coin)) await this.closePosition(coin);
        }
      }
      throw err;
    }
  }

  async getMeta(): Promise<MetaResponse> {
    return this.infoRequest({ type: 'meta' });
  }

  async getAsset(coin: string): Promise<{ index: number; meta: AssetMeta }> {
    const normalized = coin.toUpperCase();
    if (this.assetCache.has(normalized)) return this.assetCache.get(normalized)!;

    const { universe } = await this.getMeta();
    const index = universe.findIndex(a => a.name === normalized);
    if (index === -1) throw new Error(`Asset not found: ${coin}`);
    if (universe[index].isDelisted) throw new Error(`Asset is delisted: ${coin}`);

    const entry = { index, meta: universe[index] };
    this.assetCache.set(normalized, entry);
    return entry;
  }

  async getAllMids(): Promise<Record<string, string>> {
    return this.infoRequest({ type: 'allMids' });
  }

  /** The visible order book (20 levels a side): bids best first, asks best first. */
  async getBookSnapshot(coin: string) {
    const raw = await this.infoRequest<{ time?: number; levels?: Array<Array<{ px: string; sz: string }>> }>({ type: 'l2Book', coin: coin.toUpperCase() });
    const side = (rows?: Array<{ px: string; sz: string }>) => (rows ?? []).map(l => ({ px: parseFloat(l.px), sz: parseFloat(l.sz) }));
    return { time: raw.time ?? null, bids: side(raw.levels?.[0]), asks: side(raw.levels?.[1]) };
  }

  async getBook(coin: string) {
    const { bids, asks } = await this.getBookSnapshot(coin);
    return { bids, asks };
  }

  async getMarkPrice(coin: string): Promise<number> {
    const mids = await this.getAllMids();
    const price = mids[coin.toUpperCase()];
    if (!price) throw new Error(`No market price for ${coin}`);
    return parseFloat(price);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getRawUserState(): Promise<any> {
    return this.infoRequest({ type: 'clearinghouseState', user: this.address });
  }

  async getPositions(): Promise<HyperliquidPosition[]> {
    const [state, mids] = await Promise.all([this.getRawUserState(), this.getAllMids()]);
    const positions: HyperliquidPosition[] = [];

    for (const ap of (state.assetPositions ?? [])) {
      const pos = ap.position;
      if (!pos || parseFloat(pos.szi) === 0) continue;

      const size = parseFloat(pos.szi);
      const entryPx = parseFloat(pos.entryPx ?? '0');
      const markPrice = parseFloat(mids[pos.coin] ?? pos.entryPx ?? '0');
      const unrealizedPnl = parseFloat(pos.unrealizedPnl ?? '0');
      const leverage = parseFloat(pos.leverage?.value ?? '1');
      const positionValue = Math.abs(size) * entryPx;

      positions.push({
        symbol: pos.coin,
        side: size > 0 ? 'long' : 'short',
        size: Math.abs(size),
        entryPrice: entryPx,
        markPrice,
        unrealizedPnl,
        unrealizedPnlPercent: positionValue > 0 ? (unrealizedPnl / positionValue) * 100 * leverage : 0,
        leverage,
        liquidationPrice: parseFloat(pos.liquidationPx ?? '0'),
        marginUsed: parseFloat(pos.marginUsed ?? '0'),
      });
    }

    return positions;
  }

  async getPosition(coin: string): Promise<HyperliquidPosition | null> {
    const positions = await this.getPositions();
    return positions.find(p => p.symbol === coin.toUpperCase()) ?? null;
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const state = await this.getRawUserState();
    const ms = state.marginSummary ?? {};
    return {
      totalValue: parseFloat(ms.accountValue ?? '0'),
      unrealizedPnl: parseFloat(ms.totalUnrealizedPnl ?? '0'),
      marginUsed: parseFloat(ms.totalMarginUsed ?? '0'),
      withdrawable: parseFloat(state.withdrawable ?? '0'),
    };
  }

  /** Exchange P&L excludes cash movements. Use the latest observation at or
   * before UTC midnight, with at most one hour of sampling uncertainty. */
  async getDailyRisk(): Promise<{ startEquity: number; pnl: number; netDeposits: number }> {
    const rows = await this.infoRequest<Array<[string, { accountValueHistory: Array<[number, string]>; pnlHistory: Array<[number, string]> }]>>({ type: 'portfolio', user: this.address });
    const day = rows.find(([name]) => name === 'day')?.[1];
    const midnight = new Date().setUTCHours(0, 0, 0, 0);
    const start = day?.accountValueHistory.filter(([t]) => t <= midnight).at(-1);
    const pnlStart = day?.pnlHistory.filter(([t]) => t <= midnight).at(-1);
    const pnlEnd = day?.pnlHistory.at(-1);
    if (!start || !pnlStart || !pnlEnd || midnight - start[0] > 3_600_000 || !(Number(start[1]) > 0)) {
      throw new Error('Exchange daily risk history is unavailable. New exposure is blocked');
    }
    const last = day!.accountValueHistory.at(-1)!;
    const [account, ledger] = await Promise.all([
      this.getAccountSummary(),
      this.infoRequest<Array<{ time: number; delta: Record<string, unknown> }>>({ type: 'userNonFundingLedgerUpdates', user: this.address, startTime: start[0] + 1 }),
    ]);
    if (ledger.length >= 500) throw new Error('Cash movement history is incomplete. New exposure is blocked');
    const flows = ledger.reduce((sum, row) => sum + ledgerCashflow(row.delta, this.address), 0);
    const recentFlows = ledger.filter(row => row.time > last[0]).reduce((sum, row) => sum + ledgerCashflow(row.delta, this.address), 0);
    const allTime = rows.find(([name]) => name === 'allTime')?.[1];
    const cumulativePnl = Number(allTime?.pnlHistory.at(-1)?.[1] ?? pnlEnd[1]);
    return {
      startEquity: Number(start[1]),
      pnl: account.totalValue - Number(start[1]) - flows,
      netDeposits: Number(last[1]) - cumulativePnl + recentFlows,
    };
  }

  /** Completed daily candles, oldest first. The candle still forming today is dropped. */
  async getDailyCandles(coin: string, days: number): Promise<Array<{ time: number; close: number }>> {
    const endTime = Date.now();
    const startTime = endTime - (days + 2) * 86_400_000;
    const raw = await this.infoRequest<Array<{ t: number; T: number; c: string }>>({
      type: 'candleSnapshot',
      req: { coin: coin.toUpperCase(), interval: '1d', startTime, endTime },
    });
    return raw
      .filter(c => c.T < endTime)
      .sort((a, b) => a.t - b.t)
      .map(c => ({ time: c.t, close: parseFloat(c.c) }));
  }

  /** Completed hourly candles with volume (in coins), oldest first. The candle still forming is dropped. */
  async getHourlyCandles(coin: string, count: number): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>> {
    const endTime = Date.now();
    return this.getCandles(coin, '1h', endTime - (count + 2) * 3_600_000, endTime);
  }

  /** Completed candles between two times, oldest first. The exchange returns at most 5,000 per call. */
  async getCandles(coin: string, interval: '5m' | '15m' | '1h' | '4h' | '1d', startTime: number, endTime = Date.now()): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>> {
    const now = Date.now();
    const raw = await this.infoRequest<Array<{ t: number; T: number; o: string; h: string; l: string; c: string; v?: string }>>({
      type: 'candleSnapshot',
      req: { coin: coin.toUpperCase(), interval, startTime, endTime },
    });
    return (raw ?? [])
      .filter(c => c.T < now)
      .sort((x, y) => x.t - y.t)
      .map(c => ({ t: c.t, o: parseFloat(c.o), h: parseFloat(c.h), l: parseFloat(c.l), c: parseFloat(c.c), v: parseFloat(c.v ?? '0') }));
  }

  async getFundingRates(coin: string, startTime: number, endTime: number): Promise<Array<{ time: number; rate: number }>> {
    const out: Array<{ time: number; rate: number }> = [];
    let cursor = startTime;
    while (cursor <= endTime) {
      const page = await this.infoRequest<Array<{ time: number; fundingRate: string }>>({ type: 'fundingHistory', coin, startTime: cursor, endTime });
      if (!page.length) break;
      out.push(...page.map(r => ({ time: r.time, rate: Number(r.fundingRate) })));
      const next = Math.max(...page.map(r => r.time)) + 1;
      if (next <= cursor) throw new Error('Funding history pagination did not advance');
      cursor = next;
    }
    return out;
  }

  async setLeverage(coin: string, leverage: number, isCross = true): Promise<void> {
    const { index, meta } = await this.getAsset(coin);
    if (!Number.isInteger(leverage) || leverage < 1) {
      throw new Error(`Leverage must be a whole number of at least 1 (got ${leverage})`);
    }
    if (leverage > meta.maxLeverage) {
      throw new Error(`Leverage ${leverage}x exceeds the ${meta.maxLeverage}x maximum for ${meta.name}`);
    }
    const result = await this.sendAction({
      type: 'updateLeverage',
      asset: index,
      isCross,
      leverage,
    });
    if (result.status !== 'ok') {
      throw new Error(`Leverage update failed: ${JSON.stringify(result)}`);
    }
  }

  /**
   * Sends an immediate-or-cancel limit order priced through the book by
   * `slippagePercent` (a market order with a worst-price guard). Throws unless
   * the exchange confirms a fill; the returned size is what actually filled,
   * which can be less than requested.
   */
  async placeIocOrder(params: {
    coin: string;
    isBuy: boolean;
    /** Size in coins. */
    size: number;
    reduceOnly: boolean;
    slippagePercent?: number;
  }): Promise<OrderResult> {
    const { coin, isBuy, size, reduceOnly, slippagePercent = 2 } = params;
    const [{ index, meta }, markPrice] = await Promise.all([this.getAsset(coin), this.getMarkPrice(coin)]);

    const slipFactor = isBuy ? 1 + slippagePercent / 100 : 1 - slippagePercent / 100;
    const wire = limitOrderWire(index, meta.szDecimals, isBuy, markPrice * slipFactor, size, 'Ioc', reduceOnly);
    if (parseFloat(wire.s) === 0) throw new Error('Order size too small for this asset');

    const result = await this.sendAction(orderAction([wire], 'na'));

    if (result.status !== 'ok' || typeof result.response !== 'object') {
      throw new Error(`Order rejected: ${JSON.stringify(result.response ?? result)}`);
    }
    const status = result.response.data?.statuses?.[0];
    if (!status) throw new Error(`Order failed: ${JSON.stringify(result)}`);
    if (status.error) throw new Error(`Order error: ${status.error}`);
    if (!status.filled) throw new Error(`Order did not fill: ${JSON.stringify(status)}`);

    return {
      orderId: status.filled.oid.toString(),
      fillPrice: parseFloat(status.filled.avgPx),
      sizeInContracts: parseFloat(status.filled.totalSz),
      decisionPrice: markPrice,
    };
  }

  /** Opens or adds to a position sized in USD notional, setting leverage first. */
  async placeMarketOrder(params: OrderParams): Promise<OrderResult> {
    const { coin, isBuy, sizeUsd, leverage, reduceOnly = false, slippagePercent = 2 } = params;
    if (!(sizeUsd >= MIN_ORDER_USD)) throw new Error(`Order size must be at least $${MIN_ORDER_USD}`);

    const markPrice = await this.getMarkPrice(coin);
    if (!reduceOnly) await this.setLeverage(coin, leverage);

    return this.placeIocOrder({ coin, isBuy, size: sizeUsd / markPrice, reduceOnly, slippagePercent });
  }

  /**
   * Places exchange-side protective orders on the open position: a stop-loss
   * and/or take-profit that trigger a reduce-only market order. They live on
   * the exchange, so they still work if this app is down. `size` is in coins;
   * the orders shrink with the position (positionTpsl grouping).
   */
  async placeProtectiveOrders(params: {
    coin: string;
    /** Side of the position being protected. */
    side: 'long' | 'short';
    size: number;
    stopLossPx?: number;
    takeProfitPx?: number;
  }): Promise<{ stopLossOid: string | null; takeProfitOid: string | null }> {
    const { coin, side, size, stopLossPx, takeProfitPx } = params;
    const legs: TriggerLeg[] = [];
    if (stopLossPx != null) legs.push({ kind: 'sl', triggerPx: stopLossPx, size });
    if (takeProfitPx != null) legs.push({ kind: 'tp', triggerPx: takeProfitPx, size });
    if (legs.length === 0) return { stopLossOid: null, takeProfitOid: null };
    const oids = await this.placeTriggerOrders({ coin, side, legs, grouping: 'positionTpsl' });
    return {
      stopLossOid: stopLossPx != null ? oids[0] : null,
      takeProfitOid: takeProfitPx != null ? oids[legs.length - 1] : null,
    };
  }

  /**
   * Places reduce-only stop / target orders, each with its own size. With
   * grouping "na" the sizes are fixed (used for split targets); a reduce-only
   * order can never grow or flip the position, so a stop sized for the whole
   * position stays safe after part of it has been taken off.
   * Returns one order id per leg, in order (null if the exchange gave none).
   */
  async placeTriggerOrders(params: { coin: string; side: 'long' | 'short'; legs: TriggerLeg[]; grouping: Grouping }): Promise<Array<string | null>> {
    const { coin, side, legs, grouping } = params;
    const { index, meta } = await this.getAsset(coin);
    const wires = legs.map(l => {
      const w = triggerOrderWire(index, meta.szDecimals, side, l.triggerPx, l.size, l.kind);
      if (parseFloat(w.s) === 0) throw new Error('Protective order size too small for this asset');
      return w;
    });
    const statuses = await this.sendOrders(wires, grouping, 'Protective orders');
    return legs.map((l, i) => {
      const st = statuses[i];
      if (st && typeof st === 'object' && st.error) throw new Error(`${l.kind === 'sl' ? 'Stop-loss' : 'Take-profit'} rejected: ${st.error}`);
      return st && typeof st === 'object' && st.resting ? String(st.resting.oid) : null;
    });
  }

  private async sendOrders(orders: OrderWire[], grouping: Grouping, what: string) {
    const result = await this.sendAction(orderAction(orders, grouping));
    if (result.status !== 'ok' || typeof result.response !== 'object') {
      throw new Error(`${what} rejected: ${JSON.stringify(result.response ?? result)}`);
    }
    return (result.response.data?.statuses ?? []) as Array<{ error?: string; resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number } } | string | undefined>;
  }

  /**
   * Rests a post-only limit order (it is rejected rather than taking liquidity,
   * so it always pays the maker fee). When a stop or target is given they are
   * sent as children of the entry (normalTpsl): the exchange only activates
   * them once the entry fills and cancels them with it, so an unfilled entry
   * cannot leave a stop behind.
   */
  async placeLimitEntry(params: {
    coin: string; isBuy: boolean; size: number; price: number; leverage: number;
    stopLossPx?: number; takeProfitPx?: number;
  }): Promise<{ oid: string; size: number; price: number }> {
    const { coin, isBuy, size, price, leverage, stopLossPx, takeProfitPx } = params;
    const { index, meta } = await this.getAsset(coin);
    const entry = limitOrderWire(index, meta.szDecimals, isBuy, price, size, 'Alo');
    if (parseFloat(entry.s) === 0) throw new Error('Order size too small for this asset');
    if (parseFloat(entry.s) * parseFloat(entry.p) < MIN_ORDER_USD) throw new Error(`Order size must be at least $${MIN_ORDER_USD}`);
    await this.setLeverage(coin, leverage);

    const side = isBuy ? 'long' as const : 'short' as const;
    const orders = [entry];
    if (stopLossPx != null) orders.push(triggerOrderWire(index, meta.szDecimals, side, stopLossPx, parseFloat(entry.s), 'sl'));
    if (takeProfitPx != null) orders.push(triggerOrderWire(index, meta.szDecimals, side, takeProfitPx, parseFloat(entry.s), 'tp'));
    const statuses = await this.sendOrders(orders, orders.length > 1 ? 'normalTpsl' : 'na', 'Limit order');
    for (const st of statuses) if (st && typeof st === 'object' && st.error) throw new Error(`Limit order rejected: ${st.error}`);
    const first = statuses[0];
    const oid = first && typeof first === 'object' ? first.resting?.oid ?? first.filled?.oid : undefined;
    if (oid == null) throw new Error(`Limit order gave no order id: ${JSON.stringify(statuses)}`);
    return { oid: String(oid), size: parseFloat(entry.s), price: parseFloat(entry.p) };
  }

  /** Where an order stands. `filledSize` is what has filled so far, in coins. */
  async getOrderStatus(oid: string): Promise<{ status: string; filledSize: number; originalSize: number; limitPx: number } | null> {
    const raw = await this.infoRequest<{ status: string; order?: { status: string; order: { sz: string; origSz: string; limitPx: string } } }>({
      type: 'orderStatus', user: this.address, oid: Number(oid),
    });
    if (raw.status !== 'order' || !raw.order) return null;
    const o = raw.order.order;
    const originalSize = parseFloat(o.origSz), remaining = parseFloat(o.sz);
    // For a filled order `sz` is 0; for a cancelled one it is what never filled.
    return { status: raw.order.status, filledSize: Math.max(0, originalSize - remaining), originalSize, limitPx: parseFloat(o.limitPx) };
  }

  async cancelOrders(coin: string, oids: Array<string | number>): Promise<void> {
    if (oids.length === 0) return;
    const { index } = await this.getAsset(coin);
    const result = await this.sendAction({ type: 'cancel', cancels: oids.map(o => ({ a: index, o: Number(o) })) });
    if (result.status !== 'ok') throw new Error(`Cancel failed: ${JSON.stringify(result.response ?? result)}`);
  }

  /** Cancels the stop-loss / take-profit orders on a coin, leaving resting limit entries alone. */
  async cancelProtectiveOrders(coin: string): Promise<number> {
    const orders = (await this.getOpenOrders(coin)).filter(o => o.isTrigger && o.reduceOnly);
    await this.cancelOrders(coin, orders.map(o => o.oid));
    return orders.length;
  }

  /** Open orders for a coin, including untriggered stop-loss / take-profit orders. */
  async getOpenOrders(coin?: string): Promise<Array<{ coin: string; oid: number; isTrigger: boolean; reduceOnly: boolean; triggerPx: number; limitPx: number; side: 'buy' | 'sell'; size: number; orderType: string }>> {
    const raw = await this.infoRequest<Array<Record<string, unknown>>>({ type: 'frontendOpenOrders', user: this.address });
    return (raw ?? [])
      .filter(o => !coin || o.coin === coin.toUpperCase())
      .map(o => ({
        coin: String(o.coin),
        oid: Number(o.oid),
        isTrigger: o.isTrigger === true,
        reduceOnly: o.reduceOnly === true,
        triggerPx: parseFloat(String(o.triggerPx ?? '0')),
        limitPx: parseFloat(String(o.limitPx ?? '0')),
        side: o.side === 'B' ? 'buy' as const : 'sell' as const,
        size: parseFloat(String(o.sz ?? '0')),
        orderType: String(o.orderType ?? ''),
      }));
  }

  /** Cancels every open order on a coin (used to clear stale stops once a position is closed). */
  async cancelOpenOrders(coin: string): Promise<number> {
    const orders = await this.getOpenOrders(coin);
    if (orders.length === 0) return 0;
    const { index } = await this.getAsset(coin);
    const result = await this.sendAction({ type: 'cancel', cancels: orders.map(o => ({ a: index, o: o.oid })) });
    if (result.status !== 'ok') throw new Error(`Cancel failed: ${JSON.stringify(result.response ?? result)}`);
    return orders.length;
  }

  /**
   * Closes the whole position with reduce-only orders. An IOC order can fill
   * partially, so this retries on the remainder and reports whether the
   * position is actually flat. `fillPrice` is the size-weighted average.
   */
  async closePosition(
    coin: string,
    slippagePercent = 2
  ): Promise<{ fillPrice: number; filledSize: number; side: 'long' | 'short'; fullyClosed: boolean }> {
    const position = await this.getPosition(coin);
    if (!position) throw new Error(`No open position for ${coin}`);

    const { meta } = await this.getAsset(coin);
    const dust = 10 ** -meta.szDecimals / 2;
    let remaining = position.size;
    let filledSize = 0;
    let notional = 0;

    for (let attempt = 0; attempt < 3 && remaining > dust; attempt++) {
      let fill: OrderResult;
      try {
        fill = await this.placeIocOrder({
          coin,
          isBuy: position.side === 'short',
          size: remaining,
          reduceOnly: true,
          slippagePercent,
        });
      } catch (err) {
        if (filledSize === 0) throw err;
        break; // keep what already filled; the caller sees fullyClosed = false
      }
      filledSize += fill.sizeInContracts;
      notional += fill.sizeInContracts * fill.fillPrice;
      remaining -= fill.sizeInContracts;
    }

    return { fillPrice: notional / filledSize, filledSize, side: position.side, fullyClosed: remaining <= dust };
  }
}

export interface TriggerLeg { kind: 'sl' | 'tp'; triggerPx: number; /** Coins. */ size: number }

export function createHLClient(config: HyperliquidConfig): HyperliquidClient {
  return new HyperliquidClient(config);
}
