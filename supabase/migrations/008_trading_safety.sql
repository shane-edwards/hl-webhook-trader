-- Apply after 007. Trading writes require these coordination functions.
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS flatten_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trading_halted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notification_ntfy_topic text,
  ADD COLUMN IF NOT EXISTS notification_telegram_chat_id text,
  ADD COLUMN IF NOT EXISTS notification_email_to text;

CREATE TABLE public.trading_accounts (
  resource text PRIMARY KEY,
  owner uuid,
  lease_until timestamptz,
  halted boolean NOT NULL DEFAULT false
);
CREATE TABLE public.signer_nonces (signer text PRIMARY KEY, nonce bigint NOT NULL);
CREATE TABLE public.exchange_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource text NOT NULL,
  action jsonb NOT NULL,
  nonce bigint NOT NULL,
  expires_after bigint NOT NULL,
  status text NOT NULL DEFAULT 'submitting' CHECK (status IN ('submitting', 'confirmed', 'uncertain')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.webhook_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  signal_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'done', 'error')),
  result jsonb,
  started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, signal_id)
);
CREATE INDEX webhook_jobs_queue ON public.webhook_jobs(created_at) WHERE status = 'queued';
ALTER TABLE public.trading_accounts ADD COLUMN IF NOT EXISTS halted boolean NOT NULL DEFAULT false;
ALTER TABLE public.pending_orders ADD COLUMN IF NOT EXISTS fallback_started boolean NOT NULL DEFAULT false;
ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS fallback_size numeric,
  ADD COLUMN IF NOT EXISTS fallback_notional numeric;
ALTER TABLE public.trades ADD COLUMN IF NOT EXISTS execution_key text;
CREATE UNIQUE INDEX trades_execution_unique ON public.trades(user_id, execution_key) WHERE execution_key IS NOT NULL;

ALTER TABLE public.alerts ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
DROP POLICY IF EXISTS "Signed-in users can read alerts" ON public.alerts;
CREATE POLICY "Users can read own alerts" ON public.alerts FOR SELECT USING (auth.uid() = user_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['trading_accounts','signer_nonces','exchange_actions','webhook_jobs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "Service role manages safety state" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.acquire_trading_lock(resource_key text, lease_owner uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO trading_accounts(resource, owner, lease_until)
    VALUES(resource_key, lease_owner, clock_timestamp() + interval '90 seconds')
  ON CONFLICT(resource) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until
    WHERE trading_accounts.lease_until < clock_timestamp() OR trading_accounts.owner IS NULL;
  RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.release_trading_lock(resource_key text, lease_owner uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE trading_accounts SET owner = NULL, lease_until = NULL WHERE resource = resource_key AND owner = lease_owner;
$$;
CREATE OR REPLACE FUNCTION public.next_trading_nonce(resource_key text, lease_owner uuid, signer_key text, account_user uuid, increases_exposure boolean)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE a trading_accounts; n bigint;
BEGIN
  SELECT * INTO a FROM trading_accounts WHERE resource = resource_key FOR UPDATE;
  IF a.owner IS DISTINCT FROM lease_owner OR a.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'Trading lease expired';
  END IF;
  IF increases_exposure AND (a.halted OR NOT EXISTS (SELECT 1 FROM settings WHERE user_id = account_user AND NOT trading_halted)) THEN
    RAISE EXCEPTION 'Trading is halted. Use Settings to resume after checking the account.';
  END IF;
  INSERT INTO signer_nonces(signer, nonce) VALUES(signer_key, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT(signer) DO UPDATE SET nonce = greatest(signer_nonces.nonce + 1, EXCLUDED.nonce) RETURNING nonce INTO n;
  RETURN n;
END $$;
CREATE OR REPLACE FUNCTION public.halt_trading_account(resource_key text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO trading_accounts(resource, halted) VALUES(resource_key, true)
    ON CONFLICT(resource) DO UPDATE SET halted = true;
$$;
REVOKE ALL ON FUNCTION public.acquire_trading_lock(text, uuid), public.release_trading_lock(text, uuid),
  public.next_trading_nonce(text, uuid, text, uuid, boolean), public.halt_trading_account(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_trading_lock(text, uuid), public.release_trading_lock(text, uuid),
  public.next_trading_nonce(text, uuid, text, uuid, boolean), public.halt_trading_account(text) TO service_role;

-- Wake the worker for queued signals even when there are no open positions.
DO $$ DECLARE base text; BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('hl-fast', '10 seconds',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/fast'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.trades WHERE status = ''open'')'
      || ' OR EXISTS (SELECT 1 FROM public.position_plans WHERE status = ''active'')'
      || ' OR EXISTS (SELECT 1 FROM public.pending_orders WHERE status = ''resting'')'
      || ' OR EXISTS (SELECT 1 FROM public.settings WHERE flatten_pending)'
      || ' OR EXISTS (SELECT 1 FROM public.webhook_jobs WHERE status IN (''queued'', ''processing''));');
  END IF;
END $$;

ALTER TABLE public.autopilot_positions ADD COLUMN IF NOT EXISTS funding_paid numeric NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS last_funding_time bigint;

ALTER TABLE public.autopilot_state ADD COLUMN IF NOT EXISTS cash_flow_baseline numeric;
