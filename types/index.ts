export type TradeSide = 'long' | 'short';
export type TradeStatus = 'open' | 'closed' | 'cancelled';
export type SignalSource = 'webhook' | 'manual' | 'autopilot';
export type StrategyRunStatus = 'held' | 'traded' | 'dry_run' | 'error';

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
  /** Realised P&L, and the result after fees and funding, as the exchange booked them (migration 006). */
  exchange_pnl?: number | null;
  net_pnl?: number | null;
  fills_synced_at?: string | null;
  /** Mid price when the order was sent, the fill's distance from it in basis points, and how it was sent (migration 007). */
  decision_price?: number | null;
  slippage_bps?: number | null;
  order_type?: string | null;
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
  // Default stop/target for webhook entries, percent from entry (migration 003)
  default_stop_loss_percent?: number | null;
  default_take_profit_percent?: number | null;
  // Built-in strategy (present once migration 002 has been applied)
  strategy_enabled?: boolean;
  strategy_dry_run?: boolean;
  strategy_symbol?: string;
  strategy_target_vol?: number;
  strategy_max_leverage?: number;
  strategy_capital_usd?: number | null;
  // Account-wide limits and the daily summary (migration 006)
  max_gross_exposure_x?: number;
  portfolio_daily_loss_limit_pct?: number;
  daily_summary_enabled?: boolean;
  created_at: string;
  updated_at: string;
}

export interface StrategyRun {
  id: string;
  symbol: string;
  status: StrategyRunStatus;
  signal_date: string | null;
  trend_score: number | null;
  realized_vol: number | null;
  target_exposure: number | null;
  current_exposure: number | null;
  equity_usd: number | null;
  traded_size: number | null;
  fill_price: number | null;
  message: string | null;
  created_at: string;
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
  strategy_enabled?: boolean;
  strategy_dry_run?: boolean;
  strategy_target_vol?: number;
  strategy_max_leverage?: number;
  strategy_capital_usd?: number | null;
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
  /** Order direction. In TradingView "sell" can mean exit or short, so prefer `position`. */
  action?: 'buy' | 'sell' | 'long' | 'short' | 'close';
  /** The strategy's position after the order: TradingView {{strategy.market_position}}. */
  position?: 'long' | 'short' | 'flat';
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
