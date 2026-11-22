-- HL Webhook Trader — the Autopilot may go short by default
-- Run this in your Supabase SQL editor after 004_autopilot.sql
--
-- With real money a strategy still shorts only if its long-and-short version
-- passed the backtest gate; otherwise it trades long-only. See lib/autopilot/run.ts.
ALTER TABLE public.settings ALTER COLUMN autopilot_allow_short SET DEFAULT true;
