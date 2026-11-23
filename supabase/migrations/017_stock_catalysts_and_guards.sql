CREATE TABLE public.stock_catalyst_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  enabled boolean NOT NULL DEFAULT false,
  last_checked_at timestamptz
);

CREATE TABLE public.stock_catalyst_sessions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  session_day date NOT NULL,
  lease_until timestamptz,
  completed_at timestamptz,
  summary jsonb,
  PRIMARY KEY (user_id, environment, session_day)
);

CREATE TABLE public.stock_shadow_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  session_day date NOT NULL,
  version text NOT NULL,
  symbol text NOT NULL,
  for_symbol text NOT NULL,
  sector text NOT NULL,
  instrument_id integer NOT NULL CHECK (instrument_id > 0),
  lane text NOT NULL CHECK (lane IN ('catalyst', 'control')),
  filing jsonb,
  observed_at timestamptz NOT NULL,
  eligible_at timestamptz NOT NULL,
  settle_after timestamptz NOT NULL,
  quote jsonb,
  decision jsonb NOT NULL,
  outcomes jsonb,
  UNIQUE (user_id, environment, session_day, version, for_symbol, lane),
  CHECK (eligible_at > observed_at AND settle_after > eligible_at)
);
CREATE INDEX stock_shadow_due_idx ON public.stock_shadow_observations (user_id, environment, settle_after) WHERE outcomes IS NULL;
CREATE INDEX stock_shadow_account_idx ON public.stock_shadow_observations (user_id, environment, session_day DESC);

ALTER TABLE public.etoro_stock_orders
  ADD COLUMN statement_result jsonb,
  ADD COLUMN planned_slippage_bps numeric CHECK (planned_slippage_bps >= 0),
  ADD COLUMN planned_net_bps numeric;

CREATE TABLE public.stock_guard_settings (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  enabled boolean NOT NULL DEFAULT false,
  minimum_trades integer NOT NULL DEFAULT 10 CHECK (minimum_trades BETWEEN 5 AND 30),
  max_slippage_bps numeric NOT NULL DEFAULT 15 CHECK (max_slippage_bps > 0 AND max_slippage_bps <= 300),
  max_net_loss_usd numeric NOT NULL DEFAULT 100 CHECK (max_net_loss_usd > 0 AND max_net_loss_usd <= 100000),
  PRIMARY KEY (user_id, environment)
);

CREATE TABLE public.stock_guard_state (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  strategy text NOT NULL CHECK (strategy IN ('breakout', 'pullback', 'inside-day', 'earnings-rebound')),
  reset_at timestamptz NOT NULL DEFAULT '-infinity',
  halted_at timestamptz,
  reason text,
  PRIMARY KEY (user_id, environment, strategy),
  CHECK ((halted_at IS NULL) = (reason IS NULL))
);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['stock_catalyst_settings', 'stock_catalyst_sessions', 'stock_shadow_observations', 'stock_guard_settings', 'stock_guard_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', relation);
  END LOOP;
END $$;

CREATE FUNCTION public.stock_entry_guard_blocked(account uuid, mode text, rule text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.stock_guard_settings s JOIN public.stock_guard_state h USING (user_id, environment)
    WHERE s.user_id = account AND s.environment = mode AND s.enabled AND h.strategy = rule AND h.halted_at IS NOT NULL);
$$;
REVOKE ALL ON FUNCTION public.stock_entry_guard_blocked(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_entry_guard_blocked(uuid,text,text) TO service_role;

DO $$
DECLARE source text;
DECLARE anchor constant text := 'PERFORM 1 FROM public.etoro_connections';
BEGIN
  SELECT pg_get_functiondef('public.reserve_stock_autopilot_order(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric)'::regprocedure) INTO source;
  IF strpos(source, anchor) = 0 THEN RAISE EXCEPTION 'Unexpected single-strategy reservation'; END IF;
  EXECUTE replace(source, anchor, 'IF public.stock_entry_guard_blocked(account, mode, config.strategy) THEN RETURN NULL; END IF; ' || anchor);
  SELECT pg_get_functiondef('public.reserve_stock_portfolio_order(uuid,text,timestamptz,timestamptz,date,timestamptz,text,text,jsonb,numeric,timestamptz,timestamptz)'::regprocedure) INTO source;
  IF strpos(source, anchor) = 0 THEN RAISE EXCEPTION 'Unexpected portfolio reservation'; END IF;
  EXECUTE replace(source, anchor, 'IF public.stock_entry_guard_blocked(account, mode, trade_rule) THEN RETURN NULL; END IF; ' || anchor);
END $$;

DO $$
DECLARE base text;
BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stock-shadow', '2,12,22,32,42,52,54 13-21 * * 1-5',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/stock-catalysts'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.stock_catalyst_settings WHERE enabled)'
      || ' OR EXISTS (SELECT 1 FROM public.stock_shadow_observations WHERE outcomes IS NULL AND settle_after <= now());');
  END IF;
END $$;
