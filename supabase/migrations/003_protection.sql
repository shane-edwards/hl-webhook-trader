-- HL Webhook Trader — default stop-loss / take-profit for webhook entries
-- Run this in your Supabase SQL editor after 002_strategy_and_hardening.sql

ALTER TABLE public.settings
  -- Percent distance from entry. NULL = no automatic stop / target.
  ADD COLUMN IF NOT EXISTS default_stop_loss_percent   NUMERIC(6,2)
    CHECK (default_stop_loss_percent IS NULL OR (default_stop_loss_percent >= 0.05 AND default_stop_loss_percent <= 50)),
  ADD COLUMN IF NOT EXISTS default_take_profit_percent NUMERIC(6,2)
    CHECK (default_take_profit_percent IS NULL OR (default_take_profit_percent >= 0.05 AND default_take_profit_percent <= 50));
