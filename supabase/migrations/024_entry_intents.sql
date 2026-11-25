-- What a manual market entry is about to send, written before the order goes out.
--
-- The trade ticket sends its order first and records the trade and places the
-- stop afterwards. If the request dies in between (a timeout, a crash, a deploy)
-- the exchange holds a position with no record and no stop, and nothing can tell
-- it from one the owner opened on Hyperliquid directly. A row here that is still
-- 'sending' long after its request must have ended is what lets the scan find
-- that position, record it from the exchange fills and put its stop on.
--
-- Written by the server only. Safe to run more than once. The app works without
-- it (the entry then goes out as before), so it can be applied before or after
-- the matching app version.

CREATE TABLE IF NOT EXISTS public.entry_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The wallet and network the order went to: recovery only ever looks at that account.
  account_resource text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('long', 'short')),
  size_usd numeric NOT NULL,
  leverage int NOT NULL,
  stop_loss_pct numeric,
  take_profit_pct numeric,
  exit jsonb,
  payload jsonb,
  slippage_percent numeric NOT NULL,
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'done', 'failed', 'recovered')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entry_intents_sending ON public.entry_intents(user_id, created_at) WHERE status = 'sending';
ALTER TABLE public.entry_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.entry_intents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entry_intents TO service_role;

-- Wake the fast scan for an entry that never got as far as its trade record.
-- Nothing happens when the job is not scheduled, or already has the clause.
DO $$ DECLARE fast text; BEGIN
  SELECT command INTO fast FROM cron.job WHERE jobname = 'hl-fast';
  IF fast IS NOT NULL AND position('public.entry_intents' IN fast) = 0 THEN
    PERFORM cron.schedule('hl-fast', '10 seconds', regexp_replace(fast, ';\s*$', '') ||
      ' OR EXISTS (SELECT 1 FROM public.entry_intents WHERE status=''sending'');');
  END IF;
END $$;
