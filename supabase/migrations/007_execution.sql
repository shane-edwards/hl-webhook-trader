-- HL Webhook Trader — execution: fast scan, entry-cost measurement, chase entries, alert log
-- Run this in your Supabase SQL editor after 006_trading_upgrades.sql
--
-- Additive. The app keeps working before it is run.

-- ============================================================
-- ENTRY COST PER FILL
-- ============================================================
ALTER TABLE public.trades
  -- Mid price at the moment the order was sent.
  ADD COLUMN IF NOT EXISTS decision_price NUMERIC(20,8),
  -- How much worse than decision_price the fill was, in basis points (negative = better).
  ADD COLUMN IF NOT EXISTS slippage_bps   NUMERIC(10,3),
  -- 'market', 'sliced', 'limit' or 'chase'.
  ADD COLUMN IF NOT EXISTS order_type     TEXT;

-- ============================================================
-- CHASE ENTRIES (rest at the best price, re-price, then fall back to market)
-- ============================================================
ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS mode                  TEXT NOT NULL DEFAULT 'limit' CHECK (mode IN ('limit', 'chase')),
  -- When a chase gives up resting and takes the rest at market.
  ADD COLUMN IF NOT EXISTS chase_until           TIMESTAMPTZ,
  -- Filled by earlier orders of the same chase (each re-price is a new order on the exchange).
  ADD COLUMN IF NOT EXISTS prior_filled_size     NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prior_filled_notional NUMERIC(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS decision_price        NUMERIC(20,8);

-- ============================================================
-- ALERT LOG (every alert is kept here, whether or not a phone channel is set up)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.alerts (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message    TEXT NOT NULL,
  -- Which channels accepted it, e.g. '{Telegram}'. Empty = shown in the app only.
  delivered  TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alerts_created_idx ON public.alerts (created_at DESC);
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in users can read alerts" ON public.alerts;
CREATE POLICY "Signed-in users can read alerts" ON public.alerts FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Service role manages alerts" ON public.alerts;
CREATE POLICY "Service role manages alerts" ON public.alerts FOR ALL USING (auth.role() = 'service_role');

-- ============================================================
-- SCHEDULING, ALL ON SUPABASE (no Vercel cron jobs)
-- ============================================================
-- Every job is derived from the existing hl-autopilot job, so the site URL and
-- CRON_SECRET never have to be typed again. Safe to run more than once.
--
--   hl-fast      every 10 seconds, but ONLY while there is something to look
--                after (an open trade, a managed exit plan or a resting entry).
--                With nothing open it makes no request at all.
--   hl-market    every 5 minutes: trade ideas across the market, scorecard.
--   hl-strategy  daily at 00:10 UTC: the BTC trend strategy (was a Vercel cron).
DO $$
DECLARE base TEXT;
BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NULL THEN
    RAISE NOTICE 'hl-autopilot is not scheduled yet (see 004_autopilot.sql); schedule it, then run this block again.';
    RETURN;
  END IF;

  PERFORM cron.schedule('hl-fast', '10 seconds',
    regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/fast'), ';\s*$', '')
    || ' WHERE EXISTS (SELECT 1 FROM public.trades WHERE status = ''open'')'
    || ' OR EXISTS (SELECT 1 FROM public.position_plans WHERE status = ''active'')'
    || ' OR EXISTS (SELECT 1 FROM public.pending_orders WHERE status = ''resting'');');
  PERFORM cron.schedule('hl-market', '2-59/5 * * * *', replace(base, '/api/cron/autopilot', '/api/cron/market'));
  PERFORM cron.schedule('hl-strategy', '10 0 * * *', replace(base, '/api/cron/autopilot', '/api/cron/strategy'));
END $$;

-- pg_cron keeps a row for every run; at one run every 10 seconds that adds up.
SELECT cron.schedule('hl-cron-cleanup', '17 3 * * *',
  $$ DELETE FROM cron.job_run_details WHERE end_time < now() - interval '2 days'; $$);

-- To stop the fast scan:  SELECT cron.unschedule('hl-fast');
