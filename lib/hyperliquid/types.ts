export interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface MetaResponse {
  universe: AssetMeta[];
}

export interface HyperliquidPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  liquidationPrice: number;
  marginUsed: number;
}

export interface OrderParams {
  coin: string;
  isBuy: boolean;
  sizeUsd: number;
  leverage: number;
  reduceOnly?: boolean;
  slippagePercent?: number;
}

export interface OrderResult {
  orderId: string;
  /** Average price of what filled. */
  fillPrice: number;
  /** Size that actually filled, in coins. */
  sizeInContracts: number;
}

export interface AccountSummary {
  totalValue: number;
  unrealizedPnl: number;
  marginUsed: number;
  withdrawable: number;
}

export interface HyperliquidConfig {
  privateKey: string;
  isTestnet?: boolean;
  /**
   * Address of the account being traded. Set this when `privateKey` belongs to
   * an API (agent) wallet; leave empty when the key is the account's own key.
   */
  accountAddress?: string | null;
}

export interface ExchangeResponse {
  status: string;
  /** An object on success; a plain error string when status is "err". */
  response?:
    | string
    | {
        type: string;
        data?: {
          statuses?: Array<{
            filled?: { totalSz: string; avgPx: string; oid: number };
            resting?: { oid: number };
            error?: string;
          }>;
        };
      };
}
