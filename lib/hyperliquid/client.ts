import { ethers } from 'ethers';
import * as msgpack from '@msgpack/msgpack';
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
import { formatPrice, formatSize } from './format';

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';
const REQUEST_TIMEOUT_MS = 10_000;

/** Hyperliquid rejects orders below this notional. */
export const MIN_ORDER_USD = 10;

const EIP712_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

export class HyperliquidClient {
  private wallet: ethers.Wallet;
  private baseUrl: string;
  private isMainnet: boolean;
  private accountAddress: string;
  private lastNonce = 0;
  private assetCache: Map<string, { index: number; meta: AssetMeta }> = new Map();

  constructor(config: HyperliquidConfig) {
    this.wallet = new ethers.Wallet(config.privateKey);
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

  private actionHash(action: unknown, vaultAddress: string | null, nonce: number): string {
    const msgPackBytes = msgpack.encode(action);
    const extra = vaultAddress ? 29 : 9;
    const data = new Uint8Array(msgPackBytes.length + extra);
    data.set(msgPackBytes);
    const view = new DataView(data.buffer);
    view.setBigUint64(msgPackBytes.length, BigInt(nonce), false);
    if (vaultAddress) {
      data[msgPackBytes.length + 8] = 1;
      data.set(ethers.getBytes(vaultAddress), msgPackBytes.length + 9);
    } else {
      data[msgPackBytes.length + 8] = 0;
    }
    return ethers.hexlify(ethers.keccak256(data));
  }

  private async signAction(action: unknown, nonce: number) {
    const connectionId = this.actionHash(action, null, nonce);
    const sig = await this.wallet.signTypedData(EIP712_DOMAIN, AGENT_TYPES, {
      source: this.isMainnet ? 'a' : 'b',
      connectionId,
    });
    const { r, s, v } = ethers.Signature.from(sig);
    return { r, s, v };
  }

  private async sendAction(action: unknown): Promise<ExchangeResponse> {
    // Nonces must be unique per signer; keep them strictly increasing within this client.
    const nonce = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = nonce;
    const signature = await this.signAction(action, nonce);

    const res = await fetch(`${this.baseUrl}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hyperliquid exchange error ${res.status}: ${text}`);
    }
    return res.json();
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

    const sizeStr = formatSize(size, meta.szDecimals);
    if (parseFloat(sizeStr) === 0) throw new Error('Order size too small for this asset');

    const slipFactor = isBuy ? 1 + slippagePercent / 100 : 1 - slippagePercent / 100;
    const limitPx = formatPrice(markPrice * slipFactor, meta.szDecimals);

    const result = await this.sendAction({
      type: 'order',
      orders: [{ a: index, b: isBuy, p: limitPx, s: sizeStr, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });

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

export function createHLClient(config: HyperliquidConfig): HyperliquidClient {
  return new HyperliquidClient(config);
}
