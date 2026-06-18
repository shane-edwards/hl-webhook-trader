export interface AssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
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
  fillPrice: number;
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
}

export interface ExchangeResponse {
  status: string;
  response?: {
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
