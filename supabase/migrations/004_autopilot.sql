-- HL Webhook Trader — Autopilot (scanner that opens and closes positions by rule)
-- Run this in your Supabase SQL editor after 003_protection.sql

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS autopilot_enabled              BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopilot_mode                 TEXT         NOT NULL DEFAULT 'paper'
    CHECK (autopilot_mode IN ('paper', 'live')),
  ADD COLUMN IF NOT EXISTS autopilot_symbols              TEXT[]       NOT NULL DEFAULT '{BTC,ETH,SOL}',
  ADD COLUMN IF NOT EXISTS autopilot_strategies           TEXT[]       NOT NULL DEFAULT '{trend_breakout}',
  ADD COLUMN IF NOT EXISTS autopilot_allow_short          BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autopilot_risk_per_trade_pct   NUMERIC(5,2) NOT NULL DEFAULT 0.5
    CHECK (autopilot_risk_per_trade_pct >= 0.05 AND autopilot_risk_per_trade_pct <= 5),
  ADD COLUMN IF NOT EXISTS autopilot_max_positions        INTEGER      NOT NULL DEFAULT 3
    CHECK (autopilot_max_positions BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS autopilot_max_leverage         NUMERIC(5,2) NOT NULL DEFAULT 2
    CHECK (autopilot_max_leverage >= 0.1 AND autopilot_max_leverage <= 10),
  ADD COLUMN IF NOT EXISTS autopilot_daily_loss_limit_pct NUMERIC(5,2) NOT NULL DEFAULT 3
    CHECK (autopilot_daily_loss_limit_pct >= 0.5 AND autopilot_daily_loss_limit_pct <= 50),
  ADD COLUMN IF NOT EXISTS autopilot_max_drawdown_pct     NUMERIC(5,2) NOT NULL DEFAULT 15
    CHECK (autopilot_max_drawdown_pct >= 1 AND autopilot_max_drawdown_pct <= 90);

-- Trades opened by the autopilot are recorded alongside webhook and manual ones.
ALTER TABLE public.trades DROP CONSTRAINT IF EXISTS trades_signal_source_check;
ALTER TABLE public.trades ADD CONSTRAINT trades_signal_source_check
  CHECK (signal_source IN ('webhook', 'manual', 'autopilot'));

-- One row per user and mode: the figures the risk limits are measured from.
CREATE TABLE IF NOT EXISTS public.autopilot_state (
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode             TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  day_key          DATE,
  day_start_equity NUMERIC(20,2),
  peak_equity      NUMERIC(20,2),
  halted_reason    TEXT,
  -- Paper account balance (paper mode only). Starts at 10,000.
  paper_equity     NUMERIC(20,2) NOT NULL DEFAULT 10000,
  last_run_at      TIMESTAMPTZ,
  PRIMARY KEY (user_id, mode)
);

CREATE TABLE IF NOT EXISTS public.autopilot_positions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  symbol        TEXT NOT NULL,
  strategy_id   TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('long', 'short')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  entry_price   NUMERIC(20,8) NOT NULL,
  size          NUMERIC(20,8) NOT NULL,
  notional_usd  NUMERIC(20,2) NOT NULL,
  stop_price    NUMERIC(20,8) NOT NULL,
  -- Open time (ms) of the hourly bar whose close produced the entry signal.
  entry_bar_t   BIGINT NOT NULL,
  entry_reason  TEXT,
  entry_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_price    NUMERIC(20,8),
  exit_time     TIMESTAMPTZ,
  exit_reason   TEXT,
  pnl           NUMERIC(20,8)
);

CREATE INDEX IF NOT EXISTS autopilot_positions_user_idx ON public.autopilot_positions (user_id, mode, status);
-- A strategy acts on a given signal bar at most once per symbol.
CREATE UNIQUE INDEX IF NOT EXISTS autopilot_positions_once_per_bar
  ON public.autopilot_positions (user_id, mode, symbol, strategy_id, entry_bar_t);

CREATE TABLE IF NOT EXISTS public.autopilot_events (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('info', 'trade', 'warn', 'error')),
  symbol      TEXT,
  strategy_id TEXT,
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS autopilot_events_user_idx ON public.autopilot_events (user_id, created_at DESC);

ALTER TABLE public.autopilot_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopilot_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.autopilot_events    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own autopilot state"     ON public.autopilot_state     FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own autopilot positions" ON public.autopilot_positions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own autopilot events"    ON public.autopilot_events    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role manages autopilot state"     ON public.autopilot_state     FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role manages autopilot positions" ON public.autopilot_positions FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "Service role manages autopilot events"    ON public.autopilot_events    FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- SCHEDULING (run separately, after filling in the two values)
-- ============================================================
-- The autopilot needs to be called every few minutes. Vercel's free plan only
-- allows daily cron jobs, so let Supabase do the calling. In the Supabase
-- dashboard enable the "pg_cron" and "pg_net" extensions (Database → Extensions),
-- then run this with your site URL and your CRON_SECRET:
--
--   SELECT cron.schedule(
--     'hl-autopilot',
--     '*/5 * * * *',
--     $$ SELECT net.http_get(
--          url     := 'https://YOUR-APP.vercel.app/api/cron/autopilot',
--          headers := '{"Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb
--        ); $$
--   );
--
-- To stop it:  SELECT cron.unschedule('hl-autopilot');
