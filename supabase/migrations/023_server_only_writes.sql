-- Settings and trade records are written by the server only.
--
-- Migration 001 let a signed-in browser session insert and update its own
-- settings and trades rows directly through the public API key. That bypassed
-- every check the server makes: a session could clear trading_halted or
-- flatten_pending, switch Autopilot to live, set unchecked leverage or forge
-- trade records. It could also read its own settings row, which holds the
-- encrypted trading key and the webhook secret.
--
-- The app reads and writes settings only with the service role, and writes
-- trades only with the service role, so nothing here changes what the app does.
-- Deploy the matching app version BEFORE running this: older versions wrote
-- trade notes and stale-record cancellations with the user's own session.

DROP POLICY IF EXISTS "Users can view own settings" ON public.settings;
DROP POLICY IF EXISTS "Users can insert own settings" ON public.settings;
DROP POLICY IF EXISTS "Users can update own settings" ON public.settings;
DROP POLICY IF EXISTS "Users can insert own trades" ON public.trades;
DROP POLICY IF EXISTS "Users can update own trades" ON public.trades;

REVOKE ALL ON public.settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.trades FROM anon, authenticated;
