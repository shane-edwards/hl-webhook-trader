export type TradeSide = 'long' | 'short';
export type TradeStatus = 'open' | 'closed' | 'cancelled';
export type SignalSource = 'webhook' | 'manual';

export interface Trade {
  id: string;
  user_id: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;
  entry_price: number;
  exit_price?: number | null;
  size: number;
  size_usd: number;
  leverage: number;
  pnl?: number | null;
  pnl_percentage?: number | null;
  fees?: number | null;
  funding_paid?: number | null;
  entry_time: string;
  exit_time?: string | null;
  duration_seconds?: number | null;
  signal_source: SignalSource;
  webhook_payload?: Record<string, unknown> | null;
  hyperliquid_order_id?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  id: string;
  user_id: string;
  default_leverage: number;
  default_order_size_usd: number;
  max_position_size_usd: number;
  risk_per_trade_percent: number;
  webhook_secret: string;
  webhook_enabled: boolean;
  hl_wallet_address?: string | null;
  hl_private_key_encrypted?: string | null;
  is_testnet: boolean;
  slippage_percent: number;
  created_at: string;
  updated_at: string;
}

export interface SettingsUpdate {
  default_leverage?: number;
  default_order_size_usd?: number;
  max_position_size_usd?: number;
  risk_per_trade_percent?: number;
  webhook_secret?: string;
  webhook_enabled?: boolean;
  hl_wallet_address?: string;
  hl_private_key?: string;
  is_testnet?: boolean;
  slippage_percent?: number;
}

export interface Position {
  symbol: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  liquidationPrice: number;
  marginUsed: number;
}

export interface WebhookLog {
  id: string;
  user_id: string;
  payload: Record<string, unknown>;
  status: 'processed' | 'rejected' | 'error';
  error_message?: string | null;
  trade_id?: string | null;
  ip_address?: string | null;
  created_at: string;
}

export interface AnalyticsMetrics {
  totalPnl: number;
  totalPnlPercent: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxDrawdown: number;
  maxDrawdownDollar: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgWinLossRatio: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgTradeDurationHours: number;
  largestWin: number;
  largestLoss: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  recoveryFactor: number;
  avgLeverage: number;
  totalFees: number;
  totalFunding: number;
  kellyPercentage: number;
  varNinetyFive: number;
}

export interface EquityPoint {
  date: string;
  equity: number;
  drawdown: number;
  pnl: number;
}

export interface MonthlyPnL {
  month: string;
  pnl: number;
  trades: number;
  winRate: number;
}

export interface WebhookPayload {
  secret: string;
  action: 'buy' | 'sell' | 'long' | 'short' | 'close';
  symbol: string;
  price?: number;
  comment?: string;
  leverage?: number;
  size_usd?: number;
}

export interface AccountSummary {
  totalValue: number;
  unrealizedPnl: number;
  marginUsed: number;
  withdrawable: number;
}
