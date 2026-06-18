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

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

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
  private assetCache: Map<string, { index: number; meta: AssetMeta }> = new Map();

  constructor(config: HyperliquidConfig) {
    this.wallet = new ethers.Wallet(config.privateKey);
    this.isMainnet = !config.isTestnet;
    this.baseUrl = config.isTestnet ? TESTNET_URL : MAINNET_URL;
  }

  get address(): string {
    return this.wallet.address;
  }

  private async infoRequest<T>(body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    const nonce = Date.now();
    const signature = await this.signAction(action, nonce);

    const res = await fetch(`${this.baseUrl}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, nonce, signature }),
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

  async setLeverage(coin: string, leverage: number, isCross = true): Promise<void> {
    const { index } = await this.getAsset(coin);
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

  async placeMarketOrder(params: OrderParams): Promise<OrderResult> {
    const { coin, isBuy, sizeUsd, leverage, reduceOnly = false, slippagePercent = 2 } = params;

    const [{ index, meta }, markPrice] = await Promise.all([
      this.getAsset(coin),
      this.getMarkPrice(coin),
    ]);

    if (!reduceOnly) {
      await this.setLeverage(coin, leverage);
    }

    const sizeInContracts = sizeUsd / markPrice;
    const sizeRounded = parseFloat(sizeInContracts.toFixed(meta.szDecimals));

    if (sizeRounded === 0) throw new Error('Order size too small for this asset');

    const slipFactor = isBuy ? 1 + slippagePercent / 100 : 1 - slippagePercent / 100;
    const limitPx = parseFloat((markPrice * slipFactor).toPrecision(6));

    const action = {
      type: 'order',
      orders: [{ a: index, b: isBuy, p: limitPx.toString(), s: sizeRounded.toString(), r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    };

    const result = await this.sendAction(action);
    const statuses = result.response?.data?.statuses ?? [];
    const status = statuses[0];

    if (!status) throw new Error(`Order failed: ${JSON.stringify(result)}`);
    if (status.error) throw new Error(`Order error: ${status.error}`);

    const fillPrice = parseFloat(status.filled?.avgPx ?? limitPx.toString());
    const orderId = (status.filled?.oid ?? status.resting?.oid ?? 0).toString();

    return { orderId, fillPrice, sizeInContracts: sizeRounded };
  }

  async closePosition(coin: string, slippagePercent = 2): Promise<{ fillPrice: number }> {
    const positions = await this.getPositions();
    const position = positions.find(p => p.symbol === coin.toUpperCase());
    if (!position) throw new Error(`No open position for ${coin}`);

    const { index, meta } = await this.getAsset(coin);
    const markPrice = await this.getMarkPrice(coin);
    const isBuy = position.side === 'short';
    const slipFactor = isBuy ? 1 + slippagePercent / 100 : 1 - slippagePercent / 100;
    const limitPx = parseFloat((markPrice * slipFactor).toPrecision(6));
    const sizeRounded = parseFloat(position.size.toFixed(meta.szDecimals));

    const action = {
      type: 'order',
      orders: [{ a: index, b: isBuy, p: limitPx.toString(), s: sizeRounded.toString(), r: true, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    };

    const result = await this.sendAction(action);
    const status = result.response?.data?.statuses?.[0];
    if (status?.error) throw new Error(`Close error: ${status.error}`);

    return { fillPrice: parseFloat(status?.filled?.avgPx ?? limitPx.toString()) };
  }
}

export function createHLClient(config: HyperliquidConfig): HyperliquidClient {
  return new HyperliquidClient(config);
}
