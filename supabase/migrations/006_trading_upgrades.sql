-- HL Webhook Trader — exits, limit entries, scorecard, true P&L, portfolio limits, health
-- Run this in your Supabase SQL editor after 005_shorts_default.sql
--
-- Everything here is additive. The app keeps working before it is run: the
-- features that need these tables say so instead of failing.

-- ============================================================
-- PORTFOLIO LIMITS (apply to manual, webhook and Autopilot entries alike)
-- ============================================================
ALTER TABLE public.settings
  -- Cap on the total size of all open positions, as a multiple of account value.
  ADD COLUMN IF NOT EXISTS max_gross_exposure_x           NUMERIC(5,2) NOT NULL DEFAULT 3
    CHECK (max_gross_exposure_x >= 0.1 AND max_gross_exposure_x <= 50),
  -- No new positions for the rest of the UTC day once the account is down this much.
  ADD COLUMN IF NOT EXISTS portfolio_daily_loss_limit_pct NUMERIC(5,2) NOT NULL DEFAULT 5
    CHECK (portfolio_daily_loss_limit_pct >= 0.5 AND portfolio_daily_loss_limit_pct <= 90),
  ADD COLUMN IF NOT EXISTS daily_summary_enabled          BOOLEAN      NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS public.portfolio_state (
  user_id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  day_key          DATE,
  day_start_equity NUMERIC(20,2),
  -- UTC day the last daily summary was sent for.
  last_summary_day DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRUE PROFIT PER TRADE (fees, funding and realised P&L from the exchange)
-- ============================================================
ALTER TABLE public.trades
  -- Realised P&L as the exchange booked it (before fees and funding).
  ADD COLUMN IF NOT EXISTS exchange_pnl    NUMERIC(20,8),
  -- exchange_pnl - fees - funding_paid. NULL until the fills have been synced.
  ADD COLUMN IF NOT EXISTS net_pnl         NUMERIC(20,8),
  ADD COLUMN IF NOT EXISTS fills_synced_at TIMESTAMPTZ;

-- ============================================================
-- MANAGED EXITS (split targets, break-even, trailing stop)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.position_plans (
  id                   UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol               TEXT NOT NULL,
  side                 TEXT NOT NULL CHECK (side IN ('long', 'short')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  entry_price          NUMERIC(20,8) NOT NULL,
  initial_size         NUMERIC(20,8) NOT NULL,
  stop_px              NUMERIC(20,8),
  stop_oid             TEXT,
  tp1_px               NUMERIC(20,8),
  -- Share of the position closed at target 1 (0-1).
  tp1_fraction         NUMERIC(5,4),
  tp1_done             BOOLEAN NOT NULL DEFAULT false,
  tp2_px               NUMERIC(20,8),
  breakeven_after_tp1  BOOLEAN NOT NULL DEFAULT false,
  -- Trailing distance in percent. NULL = no trailing.
  trail_pct            NUMERIC(6,2),
  -- Best price seen since the trail became active.
  high_water           NUMERIC(20,8),
  last_note            TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS position_plans_one_active
  ON public.position_plans (user_id, symbol) WHERE status = 'active';

-- ============================================================
-- LIMIT-ORDER ENTRIES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pending_orders (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('long', 'short')),
  limit_px         NUMERIC(20,8) NOT NULL,
  size             NUMERIC(20,8) NOT NULL,
  size_usd         NUMERIC(20,2) NOT NULL,
  leverage         NUMERIC(5,2)  NOT NULL DEFAULT 1,
  stop_loss_pct    NUMERIC(6,2),
  take_profit_pct  NUMERIC(6,2),
  oid              TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'resting'
    CHECK (status IN ('resting', 'filled', 'cancelled', 'expired', 'error')),
  filled_size      NUMERIC(20,8) NOT NULL DEFAULT 0,
  trade_id         UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  journal          JSONB,
  note             TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pending_orders_user_idx ON public.pending_orders (user_id, status);

-- ============================================================
-- TRADE IDEAS ACROSS THE MARKET, AND THEIR SCORECARD
-- ============================================================
-- Public market data, the same for every user: one row per liquid market.
CREATE TABLE IF NOT EXISTS public.suggestions_cache (
  symbol          TEXT PRIMARY KEY,
  bias            TEXT NOT NULL,
  score           INTEGER NOT NULL,
  -- Open time (ms) of the last completed hourly bar the read was computed from.
  bar_t           BIGINT NOT NULL,
  volume_24h_usd  NUMERIC(20,2),
  payload         JSONB NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row each time a market's read turns long or short.
CREATE TABLE IF NOT EXISTS public.suggestion_log (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  symbol       TEXT NOT NULL,
  bar_t        BIGINT NOT NULL,
  price        NUMERIC(20,8) NOT NULL,
  bias         TEXT NOT NULL CHECK (bias IN ('long', 'short')),
  score        INTEGER NOT NULL,
  strength     TEXT NOT NULL,
  stop_pct     NUMERIC(6,2) NOT NULL,
  target_pct   NUMERIC(6,2) NOT NULL,
  -- Where the stop came from: a support/resistance level, or volatility only.
  stop_kind    TEXT NOT NULL CHECK (stop_kind IN ('level', 'volatility')),
  -- Which was touched first. NULL = neither yet.
  outcome      TEXT CHECK (outcome IN ('target', 'stop', 'neither')),
  outcome_at   TIMESTAMPTZ,
  -- Return in the direction of the read, in percent, after 1, 3 and 7 days.
  ret_1d       NUMERIC(8,3),
  ret_3d       NUMERIC(8,3),
  ret_7d       NUMERIC(8,3),
  resolved     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, bar_t)
);
CREATE INDEX IF NOT EXISTS suggestion_log_open_idx ON public.suggestion_log (resolved, created_at);

-- ============================================================
-- HEALTH (heartbeats written by the scheduled scans)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.system_health (
  key         TEXT PRIMARY KEY,
  ok          BOOLEAN NOT NULL,
  detail      TEXT,
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_ok_at  TIMESTAMPTZ,
  -- When an alert was last sent for this check, so a long outage is not an alert every five minutes.
  alerted_at  TIMESTAMPTZ
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE public.portfolio_state   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.position_plans    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestions_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggestion_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_health     ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  -- Per-user tables: owners read their rows.
  FOREACH t IN ARRAY ARRAY['portfolio_state', 'position_plans', 'pending_orders'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Users can view own %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Users can view own %1$s" ON public.%1$I FOR SELECT USING (auth.uid() = user_id)', t);
  END LOOP;
  -- Shared, non-sensitive tables: any signed-in user may read.
  FOREACH t IN ARRAY ARRAY['suggestions_cache', 'suggestion_log', 'system_health'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Signed-in users can read %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Signed-in users can read %1$s" ON public.%1$I FOR SELECT USING (auth.role() = ''authenticated'')', t);
  END LOOP;
  -- Writes come from the server only.
  FOREACH t IN ARRAY ARRAY['portfolio_state', 'position_plans', 'pending_orders', 'suggestions_cache', 'suggestion_log', 'system_health'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Service role manages %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Service role manages %1$s" ON public.%1$I FOR ALL USING (auth.role() = ''service_role'')', t);
  END LOOP;
END $$;

-- ============================================================
-- SCHEDULING (run separately)
-- ============================================================
-- The whole-market ideas scan has its own endpoint so it never slows the
-- trading scan. Schedule it the same way as hl-autopilot (see 004):
--
--   SELECT cron.schedule(
--     'hl-market',
--     '2-59/5 * * * *',
--     $$ SELECT net.http_get(
--          url     := 'https://YOUR-APP.vercel.app/api/cron/market',
--          headers := '{"Authorization": "Bearer YOUR_CRON_SECRET"}'::jsonb
--        ); $$
--   );
