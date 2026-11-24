CREATE TABLE public.automation_profiles (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('stocks', 'crypto')),
  enabled boolean NOT NULL DEFAULT true,
  mode text NOT NULL DEFAULT 'research' CHECK (mode IN ('research', 'paper', 'live')),
  entries_paused boolean NOT NULL DEFAULT false,
  live_version text,
  loss_budget_usd numeric CHECK (loss_budget_usd BETWEEN 1 AND 10000),
  max_order_usd numeric CHECK (max_order_usd BETWEEN 10 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, market),
  CHECK (mode <> 'live' OR (live_version IS NOT NULL AND loss_budget_usd IS NOT NULL AND max_order_usd IS NOT NULL))
);

CREATE TABLE public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  market text NOT NULL CHECK (market IN ('stocks', 'crypto')),
  kind text NOT NULL CHECK (kind IN ('daily', 'weekly')),
  schedule_key text,
  source text NOT NULL CHECK (source IN ('schedule', 'manual')),
  as_of timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  cursor integer NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  work jsonb NOT NULL DEFAULT '[]'::jsonb,
  report jsonb,
  detail text,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, market, kind, schedule_key)
);

CREATE UNIQUE INDEX automation_one_pending_run
  ON public.automation_runs (user_id, market, kind) WHERE status IN ('queued', 'running');
CREATE INDEX automation_workers_due ON public.automation_runs (available_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX automation_history ON public.automation_runs (user_id, market, created_at DESC);

CREATE TABLE public.automation_crypto_shadow (
  version text NOT NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  signal_bar timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  entry_after timestamptz NOT NULL,
  settle_after timestamptz NOT NULL,
  decision text NOT NULL CHECK (decision IN ('quiet', 'qualified', 'skipped')),
  detail text NOT NULL,
  stop_pct numeric,
  assumed_slippage_bps numeric,
  outcome jsonb,
  PRIMARY KEY (version, symbol, strategy, signal_bar)
);
CREATE INDEX automation_crypto_shadow_due ON public.automation_crypto_shadow (settle_after)
  WHERE decision = 'qualified' AND outcome IS NULL;

ALTER TABLE public.stock_autopilot ADD COLUMN automation_version text;
ALTER TABLE public.etoro_stock_orders ADD COLUMN automation_version text;
ALTER TABLE public.autopilot_positions ADD COLUMN automation_version text;

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['automation_profiles', 'automation_runs', 'automation_crypto_shadow'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', relation);
  END LOOP;
END $$;

CREATE FUNCTION public.claim_automation_run() RETURNS SETOF public.automation_runs
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE public.automation_runs SET status='failed', completed_at=now(), lease_until=NULL, lease_token=NULL,
    detail='The worker did not finish after three attempts.'
    WHERE status='running' AND lease_until <= now() AND attempts >= 3;
  RETURN QUERY
  WITH next_item AS (
    SELECT r.id FROM public.automation_runs r JOIN public.automation_profiles p USING (user_id, market)
    WHERE (p.enabled OR r.source='manual') AND r.available_at <= now()
      AND (r.status='queued' OR (r.status='running' AND r.lease_until <= now()))
    ORDER BY CASE WHEN r.kind='daily' THEN 0 ELSE 1 END, r.available_at, r.created_at
    LIMIT 1 FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE public.automation_runs r
    SET status='running', attempts=r.attempts+1, lease_until=now()+interval '75 seconds',
      lease_token=gen_random_uuid(), started_at=COALESCE(r.started_at, now())
    FROM next_item WHERE r.id=next_item.id
    RETURNING r.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_automation_run() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_run() TO service_role;

-- The scheduled worker only proposes entries. Stock reservations verify the currently approved version again.
CREATE FUNCTION public.reserve_automated_stock_entry(
  account uuid, mode text, config_version timestamptz, key_version timestamptz,
  session_day date, instrument integer, price numeric, signal_expiry timestamptz,
  timed_exit timestamptz, order_amount numeric, approved_version text, approval_updated_at timestamptz
) RETURNS uuid LANGUAGE plpgsql SET search_path=public AS $$
DECLARE config public.stock_autopilot%ROWTYPE;
DECLARE approval public.automation_profiles%ROWTYPE;
DECLARE reserved uuid;
BEGIN
  SELECT * INTO approval FROM public.automation_profiles WHERE user_id=account AND market='stocks' FOR SHARE;
  IF NOT FOUND OR NOT approval.enabled OR approval.entries_paused OR approval.updated_at <> approval_updated_at OR
    (mode='real' AND (approval.mode <> 'live' OR approval.live_version IS DISTINCT FROM approved_version)) OR
    (mode='demo' AND approval.mode <> 'paper') THEN RETURN NULL; END IF;
  SELECT * INTO config FROM public.stock_autopilot WHERE user_id=account FOR UPDATE;
  IF NOT FOUND OR config.automation_version IS DISTINCT FROM approved_version OR config.leverage <> 1 OR
    order_amount IS NULL OR order_amount <= 0 OR order_amount > config.amount OR
    (mode='real' AND (order_amount > approval.loss_budget_usd OR order_amount > approval.max_order_usd)) THEN RETURN NULL; END IF;
  reserved := public.reserve_stock_autopilot_order(account, mode, config_version, key_version, session_day,
    instrument, price, signal_expiry, timed_exit, NULL);
  IF reserved IS NOT NULL THEN
    UPDATE public.etoro_stock_orders SET request=jsonb_set(request, '{amount}', to_jsonb(order_amount)), automation_version=approved_version
      WHERE user_id=account AND id=reserved;
  END IF;
  RETURN reserved;
END $$;
REVOKE ALL ON FUNCTION public.reserve_automated_stock_entry(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric,text,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_automated_stock_entry(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric,text,timestamptz) TO service_role;

DO $$
DECLARE source text;
DECLARE anchor constant text := 'PERFORM 1 FROM public.etoro_connections';
DECLARE gate constant text := 'IF EXISTS (SELECT 1 FROM public.automation_profiles p WHERE p.user_id=account AND p.market=''stocks'' AND p.entries_paused) THEN RETURN NULL; END IF; ';
BEGIN
  SELECT pg_get_functiondef('public.reserve_stock_autopilot_order(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric)'::regprocedure) INTO source;
  IF strpos(source, anchor) = 0 THEN RAISE EXCEPTION 'Unexpected stock reservation'; END IF;
  EXECUTE replace(source, anchor, gate || anchor);
  SELECT pg_get_functiondef('public.reserve_stock_portfolio_order(uuid,text,timestamptz,timestamptz,date,timestamptz,text,text,jsonb,numeric,timestamptz,timestamptz)'::regprocedure) INTO source;
  IF strpos(source, anchor) = 0 THEN RAISE EXCEPTION 'Unexpected stock portfolio reservation'; END IF;
  EXECUTE replace(source, anchor, gate || anchor);
END $$;

DO $$
DECLARE base text;
DECLARE stock text;
BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname='hl-autopilot';
  IF base IS NOT NULL THEN
    base := regexp_replace(base, 'timeout_milliseconds\s*(?::=|=>)\s*[0-9]+', 'timeout_milliseconds := 55000');
    PERFORM cron.schedule('tideframe-automation', '* * * * *',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/automation'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.automation_profiles WHERE enabled)'
      || ' OR EXISTS (SELECT 1 FROM public.automation_runs WHERE source=''manual'' AND status IN (''queued'', ''running''));');
  END IF;
  SELECT command INTO stock FROM cron.job WHERE jobname='tideframe-stock-autopilot';
  IF stock IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stock-autopilot', '*/2 13-21 * * 1-5',
      regexp_replace(stock, ';\s*$', '') ||
      ' OR EXISTS (SELECT 1 FROM public.automation_profiles WHERE market=''stocks'' AND mode IN (''paper'', ''live'') AND enabled AND NOT entries_paused);');
  END IF;
END $$;
