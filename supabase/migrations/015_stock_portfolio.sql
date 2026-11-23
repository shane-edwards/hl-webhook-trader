ALTER TABLE public.stock_autopilot
  ADD COLUMN portfolio jsonb CHECK (portfolio IS NULL OR jsonb_typeof(portfolio) = 'object'),
  ADD COLUMN scan_until timestamptz;
ALTER TABLE public.etoro_connections ADD COLUMN setup_scan_attempted_at timestamptz;

CREATE TABLE public.stock_portfolio_sessions (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('real', 'demo')),
  session_day date NOT NULL,
  opening_equity numeric NOT NULL CHECK (opening_equity > 0),
  loss_locked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, environment, session_day)
);
ALTER TABLE public.stock_portfolio_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_portfolio_sessions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.stock_portfolio_sessions TO service_role;

DROP INDEX public.etoro_stock_auto_daily_idx;
CREATE UNIQUE INDEX etoro_stock_auto_ticker_daily_idx
  ON public.etoro_stock_orders (user_id, environment, signal_day, symbol) WHERE signal_day IS NOT NULL;

-- Preserve the existing single-rule reservation for the currently deployed application.
DO $$
DECLARE previous text;
BEGIN
  SELECT pg_get_functiondef('public.reserve_stock_autopilot_order(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric)'::regprocedure)
    INTO previous;
  previous := replace(previous, 'OR config.updated_at <> config_version', 'OR config.portfolio IS NOT NULL OR config.updated_at <> config_version');
  EXECUTE replace(previous, 'payload := jsonb_build_object',
    'IF EXISTS (SELECT 1 FROM public.etoro_stock_orders o WHERE o.user_id = account AND o.environment = mode AND o.signal_day = session_day) THEN RETURN NULL; END IF; payload := jsonb_build_object');
END $$;

CREATE FUNCTION public.reserve_stock_portfolio_order(
  account uuid, mode text, config_version timestamptz, key_version timestamptz,
  session_day date, scan_version timestamptz, ticker text, trade_rule text,
  payload jsonb, price numeric, signal_expiry timestamptz, timed_exit timestamptz
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  config public.stock_autopilot%ROWTYPE;
  order_id uuid;
  stop_rate numeric;
BEGIN
  IF signal_expiry <= now() THEN RETURN NULL; END IF;
  SELECT * INTO config FROM public.stock_autopilot WHERE user_id = account FOR UPDATE;
  IF NOT FOUND OR config.portfolio IS NULL OR config.active_environment IS DISTINCT FROM mode
    OR config.updated_at <> config_version OR config.scan_until IS DISTINCT FROM scan_version OR scan_version <= now()
    OR NOT (config.portfolio->'symbols' ? ticker) OR NOT (config.portfolio->'strategies' ? trade_rule)
    OR (payload->>'amount')::numeric IS DISTINCT FROM config.amount
    OR (payload->>'leverage')::integer IS DISTINCT FROM config.leverage THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.etoro_connections WHERE user_id = account AND environment = mode AND updated_at = key_version FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.stock_portfolio_sessions s WHERE s.user_id = account AND s.environment = mode
    AND s.session_day = reserve_stock_portfolio_order.session_day AND NOT s.loss_locked FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.etoro_stock_orders WHERE user_id = account AND environment = mode AND closed_at IS NULL
    AND (state IN ('sending', 'submitted', 'review') OR (symbol = ticker AND state = 'filled'
      AND (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL OR protection_state IN ('unverified', 'exit_required'))))
  ) THEN RETURN NULL; END IF;
  IF config.leverage > 1 THEN
    stop_rate := (payload->>'stopLossRate')::numeric;
    IF price <= 0 OR stop_rate IS NULL OR stop_rate <= 0 OR stop_rate >= price
      OR stop_rate < price * (1 - config.stop_margin_pct / (100 * config.leverage)) THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.etoro_stock_orders (
    user_id, environment, connection_version, symbol, strategy, request, state, reference_price,
    signal_day, signal_expires_at, strategy_exit_at, stop_margin_pct, protection_state
  ) VALUES (
    account, mode, key_version, ticker, trade_rule, payload, 'sending', price,
    session_day, signal_expiry, timed_exit, config.stop_margin_pct, CASE WHEN config.leverage > 1 THEN 'unverified' END
  ) ON CONFLICT DO NOTHING RETURNING id INTO order_id;
  RETURN order_id;
END $$;
REVOKE ALL ON FUNCTION public.reserve_stock_portfolio_order(uuid, text, timestamptz, timestamptz, date, timestamptz, text, text, jsonb, numeric, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock_portfolio_order(uuid, text, timestamptz, timestamptz, date, timestamptz, text, text, jsonb, numeric, timestamptz, timestamptz) TO service_role;
