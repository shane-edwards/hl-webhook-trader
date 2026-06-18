-- HL Webhook Trader — Initial Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- SETTINGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.settings (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  default_leverage        NUMERIC(5,2) NOT NULL DEFAULT 5,
  default_order_size_usd  NUMERIC(20,2) NOT NULL DEFAULT 100,
  max_position_size_usd   NUMERIC(20,2) NOT NULL DEFAULT 1000,
  risk_per_trade_percent  NUMERIC(5,2)  NOT NULL DEFAULT 2,
  webhook_secret          TEXT          NOT NULL DEFAULT '',
  webhook_enabled         BOOLEAN       NOT NULL DEFAULT false,
  hl_wallet_address       TEXT,
  hl_private_key_encrypted TEXT,
  is_testnet              BOOLEAN       NOT NULL DEFAULT true,
  slippage_percent        NUMERIC(5,2)  NOT NULL DEFAULT 2,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- ============================================================
-- TRADES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.trades (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol                  TEXT NOT NULL,
  side                    TEXT NOT NULL CHECK (side IN ('long', 'short')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  entry_price             NUMERIC(20,8) NOT NULL,
  exit_price              NUMERIC(20,8),
  size                    NUMERIC(20,8) NOT NULL,
  size_usd                NUMERIC(20,2) NOT NULL,
  leverage                NUMERIC(5,2)  NOT NULL DEFAULT 1,
  pnl                     NUMERIC(20,8),
  pnl_percentage          NUMERIC(10,4),
  fees                    NUMERIC(20,8) DEFAULT 0,
  funding_paid            NUMERIC(20,8) DEFAULT 0,
  entry_time              TIMESTAMPTZ   NOT NULL,
  exit_time               TIMESTAMPTZ,
  duration_seconds        INTEGER,
  signal_source           TEXT NOT NULL DEFAULT 'webhook' CHECK (signal_source IN ('webhook', 'manual')),
  webhook_payload         JSONB,
  hyperliquid_order_id    TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trades_user_id_idx ON public.trades(user_id);
CREATE INDEX IF NOT EXISTS trades_status_idx ON public.trades(status);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON public.trades(symbol);
CREATE INDEX IF NOT EXISTS trades_entry_time_idx ON public.trades(entry_time DESC);

-- ============================================================
-- WEBHOOK LOGS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS public.webhook_logs (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL CHECK (status IN ('processed', 'rejected', 'error')),
  error_message TEXT,
  trade_id      UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_logs_user_id_idx ON public.webhook_logs(user_id);
CREATE INDEX IF NOT EXISTS webhook_logs_created_at_idx ON public.webhook_logs(created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_logs ENABLE ROW LEVEL SECURITY;

-- Settings policies
CREATE POLICY "Users can view own settings"
  ON public.settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings"
  ON public.settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
  ON public.settings FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role can access all settings (for webhook processing)
CREATE POLICY "Service role has full access to settings"
  ON public.settings FOR ALL
  USING (auth.role() = 'service_role');

-- Trades policies
CREATE POLICY "Users can view own trades"
  ON public.trades FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own trades"
  ON public.trades FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own trades"
  ON public.trades FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to trades"
  ON public.trades FOR ALL
  USING (auth.role() = 'service_role');

-- Webhook logs policies
CREATE POLICY "Users can view own webhook logs"
  ON public.webhook_logs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to webhook_logs"
  ON public.webhook_logs FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER handle_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER handle_trades_updated_at
  BEFORE UPDATE ON public.trades
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
