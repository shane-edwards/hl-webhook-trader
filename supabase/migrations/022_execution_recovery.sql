ALTER TABLE public.autopilot_positions
  ADD COLUMN account_resource text,
  ADD COLUMN entry_order_id text,
  ADD COLUMN recovery_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN paper_book_fill boolean NOT NULL DEFAULT false;

-- Recover the original account of legacy positions only from acknowledged order IDs.
WITH origins AS (
  SELECT p.id, min(a.resource) AS resource FROM public.autopilot_positions p
  JOIN public.trades t ON t.user_id=p.user_id AND t.symbol=p.symbol AND t.side=p.side
    AND t.signal_source='autopilot' AND t.webhook_payload->>'strategy'=p.strategy_id
    AND t.entry_time BETWEEN p.entry_time - interval '5 seconds' AND p.entry_time + interval '2 minutes'
  JOIN public.exchange_actions a ON a.user_id=t.user_id AND a.status='confirmed'
    AND a.created_at BETWEEN t.entry_time - interval '2 minutes' AND t.entry_time + interval '5 seconds'
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.response #> '{response,data,statuses}')='array'
    THEN a.response #> '{response,data,statuses}' ELSE '[]'::jsonb END) receipt
  WHERE p.mode='live' AND p.status='open' AND receipt->'filled'->>'oid'=t.hyperliquid_order_id
  GROUP BY p.id HAVING count(DISTINCT a.resource)=1 AND count(DISTINCT t.id)=1
)
UPDATE public.autopilot_positions p SET account_resource=o.resource FROM origins o WHERE p.id=o.id;

CREATE INDEX autopilot_recovery_account ON public.autopilot_positions(account_resource)
  WHERE mode = 'live' AND status = 'open' AND recovery_pending;

-- Serialize the small set of wallet-changing writes against live reservations.
CREATE FUNCTION public.guard_managed_wallet() RETURNS trigger LANGUAGE plpgsql
SET search_path = public AS $$
BEGIN
  IF OLD.hl_private_key_encrypted IS NULL AND NEW.hl_private_key_encrypted IS NOT NULL
     AND EXISTS (SELECT 1 FROM autopilot_positions WHERE user_id=OLD.user_id AND mode='live' AND status='open')
     AND NOT EXISTS (SELECT 1 FROM autopilot_positions WHERE user_id=OLD.user_id AND mode='live' AND status='open'
       AND account_resource IS DISTINCT FROM (CASE WHEN NEW.is_testnet THEN 'testnet:' ELSE 'mainnet:' END || lower(NEW.hl_wallet_address)))
     AND NEW.hl_wallet_address IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM autopilot_positions WHERE user_id=OLD.user_id AND mode='live' AND status='open' AND account_resource IS NULL)
  THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM trades WHERE user_id=OLD.user_id AND status='open')
     OR EXISTS (SELECT 1 FROM autopilot_positions WHERE user_id = OLD.user_id AND mode = 'live' AND status = 'open')
     OR OLD.flatten_pending
     OR EXISTS (SELECT 1 FROM pending_orders WHERE user_id = OLD.user_id AND status = 'resting')
     OR EXISTS (SELECT 1 FROM position_plans WHERE user_id = OLD.user_id AND status = 'active') THEN
    RAISE EXCEPTION 'Finish managed positions, resting entries and recovery before changing the wallet';
  END IF;
  IF OLD.autopilot_mode = 'live' AND OLD.autopilot_enabled OR EXISTS (
    SELECT 1 FROM automation_profiles WHERE user_id = OLD.user_id AND market = 'crypto' AND mode = 'live' AND enabled AND NOT entries_paused
  ) THEN RAISE EXCEPTION 'Pause Live Autopilot before changing the wallet'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_managed_wallet BEFORE UPDATE OF hl_wallet_address, hl_private_key_encrypted, is_testnet ON public.settings
  FOR EACH ROW WHEN (OLD.hl_wallet_address IS DISTINCT FROM NEW.hl_wallet_address OR
    OLD.hl_private_key_encrypted IS DISTINCT FROM NEW.hl_private_key_encrypted OR OLD.is_testnet IS DISTINCT FROM NEW.is_testnet)
  EXECUTE FUNCTION public.guard_managed_wallet();

ALTER TABLE public.etoro_stock_orders ADD COLUMN close_attempts jsonb NOT NULL DEFAULT '{}';

-- Accounts with managed manual orders may have no stock_autopilot settings row.
CREATE TABLE public.stock_scan_claims (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL
);
ALTER TABLE public.stock_scan_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_scan_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_scan_claims TO service_role;

CREATE FUNCTION public.claim_stock_scan_accounts() RETURNS SETOF uuid
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(734205113);
  RETURN QUERY
    WITH candidates AS (
      SELECT user_id, coalesce(strategy_exit_at <= now(), false) OR protection_state = 'exit_required' AS urgent, created_at AS eligible_since
      FROM etoro_stock_orders WHERE closed_at IS NULL AND state NOT IN ('draft','rejected') AND
        (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL OR protection_state IN ('unverified','exit_required'))
      UNION ALL SELECT user_id, false, updated_at FROM stock_autopilot WHERE active_environment IS NOT NULL
      UNION ALL SELECT user_id, false, updated_at FROM automation_profiles WHERE market = 'stocks' AND enabled AND mode <> 'research'
    ), due AS (
      SELECT c.user_id FROM candidates c LEFT JOIN stock_scan_claims s USING(user_id)
      WHERE s.checked_at IS NULL OR s.checked_at < now() - interval '65 seconds'
      GROUP BY c.user_id, s.checked_at
      ORDER BY coalesce(s.checked_at, least(min(c.eligible_since), now() - interval '65 seconds')) -
        CASE WHEN bool_or(c.urgent) THEN interval '2 minutes' ELSE interval '0' END, c.user_id LIMIT 2
    )
    INSERT INTO stock_scan_claims SELECT due.user_id, now() FROM due
    ON CONFLICT(user_id) DO UPDATE SET checked_at = excluded.checked_at RETURNING stock_scan_claims.user_id;
END $$;
REVOKE ALL ON FUNCTION public.claim_stock_scan_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stock_scan_accounts() TO service_role;

-- Wake recovery even if the worker stopped before it could journal the fill.
DO $$ DECLARE fast text; BEGIN
  SELECT command INTO fast FROM cron.job WHERE jobname = 'hl-fast';
  IF fast IS NOT NULL THEN
    PERFORM cron.schedule('hl-fast', '10 seconds', regexp_replace(fast, ';\s*$', '') ||
      ' OR EXISTS (SELECT 1 FROM public.autopilot_positions WHERE mode=''live'' AND status=''open'' AND recovery_pending);');
  END IF;
END $$;
