-- HL Webhook Trader — built-in strategy + hardening
-- Run this in your Supabase SQL editor after 001_initial.sql

-- ============================================================
-- WEBHOOK SECRETS MUST BE UNIQUE
-- ============================================================
-- The webhook finds the user by secret, so two users sharing one would lock
-- both out. Empty secrets (the column default) are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS settings_webhook_secret_unique
  ON public.settings (webhook_secret)
  WHERE webhook_secret <> '';

-- ============================================================
-- BUILT-IN STRATEGY SETTINGS
-- ============================================================
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS strategy_enabled      BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS strategy_dry_run      BOOLEAN       NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS strategy_symbol       TEXT          NOT NULL DEFAULT 'BTC',
  ADD COLUMN IF NOT EXISTS strategy_target_vol   NUMERIC(5,2)  NOT NULL DEFAULT 0.40
    CHECK (strategy_target_vol > 0 AND strategy_target_vol <= 1.5),
  ADD COLUMN IF NOT EXISTS strategy_max_leverage NUMERIC(5,2)  NOT NULL DEFAULT 2
    CHECK (strategy_max_leverage >= 0.1 AND strategy_max_leverage <= 5),
  -- Capital the strategy sizes against. NULL = the whole account value.
  ADD COLUMN IF NOT EXISTS strategy_capital_usd  NUMERIC(20,2)
    CHECK (strategy_capital_usd IS NULL OR strategy_capital_usd > 0);

-- ============================================================
-- STRATEGY RUN LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS public.strategy_runs (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('held', 'traded', 'dry_run', 'error')),
  -- Date (UTC) of the last completed daily candle the signal was computed from.
  signal_date      DATE,
  trend_score      NUMERIC(6,4),
  realized_vol     NUMERIC(10,4),
  target_exposure  NUMERIC(10,4),
  current_exposure NUMERIC(10,4),
  equity_usd       NUMERIC(20,2),
  -- Signed coin quantity traded (positive = bought); what actually filled.
  traded_size      NUMERIC(20,8),
  fill_price       NUMERIC(20,8),
  message          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS strategy_runs_user_created_idx
  ON public.strategy_runs (user_id, created_at DESC);

ALTER TABLE public.strategy_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own strategy runs"
  ON public.strategy_runs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to strategy_runs"
  ON public.strategy_runs FOR ALL
  USING (auth.role() = 'service_role');
