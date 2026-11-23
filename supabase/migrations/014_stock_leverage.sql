ALTER TABLE public.stock_autopilot
  ADD COLUMN leverage smallint NOT NULL DEFAULT 1 CHECK (leverage IN (1, 2, 5)),
  ADD COLUMN stop_margin_pct numeric,
  ADD CONSTRAINT stock_autopilot_leverage_stop CHECK (
    (leverage = 1 AND stop_margin_pct IS NULL)
    OR (leverage IN (2, 5) AND stop_margin_pct IS NOT NULL AND stop_margin_pct > 0 AND stop_margin_pct <= 50)
  );

ALTER TABLE public.etoro_stock_orders
  ADD COLUMN stop_margin_pct numeric CHECK (stop_margin_pct > 0 AND stop_margin_pct <= 50),
  ADD COLUMN protection_state text CHECK (protection_state IN ('unverified', 'protected', 'exit_required'));
CREATE INDEX etoro_stock_pending_protection_idx ON public.etoro_stock_orders (user_id)
  WHERE protection_state IN ('unverified', 'exit_required') AND closed_at IS NULL AND state NOT IN ('draft', 'rejected');

DROP FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric, timestamptz, timestamptz);
CREATE FUNCTION public.reserve_stock_autopilot_order(
  account uuid, mode text, config_version timestamptz, key_version timestamptz,
  session_day date, instrument integer, price numeric, signal_expiry timestamptz DEFAULT NULL,
  timed_exit timestamptz DEFAULT NULL, stop_rate numeric DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  config public.stock_autopilot%ROWTYPE;
  order_id uuid;
  payload jsonb;
  protection text;
BEGIN
  IF signal_expiry IS NOT NULL AND signal_expiry <= now() THEN RETURN NULL; END IF;
  SELECT * INTO config FROM public.stock_autopilot WHERE user_id = account FOR UPDATE;
  IF NOT FOUND OR config.active_environment IS DISTINCT FROM mode OR config.updated_at <> config_version THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.etoro_connections WHERE user_id = account AND environment = mode AND updated_at = key_version FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.etoro_stock_orders WHERE user_id = account AND environment = mode
    AND (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL OR protection_state IN ('unverified', 'exit_required'))
    AND closed_at IS NULL AND state NOT IN ('draft', 'rejected')
  ) THEN RETURN NULL; END IF;
  payload := jsonb_build_object('action', 'open', 'transaction', 'buy', 'instrumentId', instrument,
    'settlementType', CASE WHEN config.leverage = 1 THEN 'real' ELSE 'cfd' END,
    'orderType', 'mkt', 'leverage', config.leverage, 'amount', config.amount, 'orderCurrency', 'usd');
  IF config.leverage > 1 THEN
    IF price <= 0 OR stop_rate IS NULL OR stop_rate <= 0 OR stop_rate >= price
      OR stop_rate < price * (1 - config.stop_margin_pct / (100 * config.leverage)) THEN RETURN NULL; END IF;
    payload := payload || jsonb_build_object('stopLossRate', stop_rate, 'stopLossType', 'fixed');
    protection := 'unverified';
  ELSIF stop_rate IS NOT NULL THEN RETURN NULL;
  END IF;
  INSERT INTO public.etoro_stock_orders (
    user_id, environment, connection_version, symbol, strategy, request, state, reference_price,
    signal_day, signal_expires_at, strategy_exit_at, stop_margin_pct, protection_state
  ) VALUES (
    account, mode, key_version, config.symbol, config.strategy, payload, 'sending', price,
    session_day, signal_expiry, timed_exit, config.stop_margin_pct, protection
  ) ON CONFLICT DO NOTHING RETURNING id INTO order_id;
  RETURN order_id;
END $$;
REVOKE ALL ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric, timestamptz, timestamptz, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric, timestamptz, timestamptz, numeric) TO service_role;

DO $$
DECLARE base text;
BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stock-autopilot', '*/2 13-21 * * 1-5',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/stock-autopilot'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.stock_autopilot WHERE active_environment IS NOT NULL)'
      || ' OR EXISTS (SELECT 1 FROM public.etoro_stock_orders'
      || ' WHERE (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL OR protection_state IN (''unverified'', ''exit_required''))'
      || ' AND closed_at IS NULL AND state NOT IN (''draft'', ''rejected''));');
  END IF;
END $$;
