ALTER TABLE public.stock_autopilot DROP CONSTRAINT stock_autopilot_strategy_check;
ALTER TABLE public.stock_autopilot ADD CONSTRAINT stock_autopilot_strategy_check
  CHECK (strategy IN ('breakout', 'pullback', 'inside-day', 'earnings-rebound'));

ALTER TABLE public.etoro_stock_orders DROP CONSTRAINT etoro_stock_orders_strategy_check;
ALTER TABLE public.etoro_stock_orders ADD CONSTRAINT etoro_stock_orders_strategy_check
  CHECK (strategy IN ('breakout', 'pullback', 'inside-day', 'earnings-rebound'));
ALTER TABLE public.etoro_stock_orders
  ADD COLUMN signal_expires_at timestamptz,
  ADD COLUMN strategy_exit_at timestamptz,
  ADD CONSTRAINT etoro_stock_earnings_exit CHECK (
    strategy IS DISTINCT FROM 'earnings-rebound' OR
    (signal_expires_at IS NOT NULL AND strategy_exit_at IS NOT NULL AND strategy_exit_at > signal_expires_at)
  );
CREATE INDEX etoro_stock_timed_exit_idx ON public.etoro_stock_orders (user_id)
  WHERE strategy_exit_at IS NOT NULL AND closed_at IS NULL AND state NOT IN ('draft', 'rejected');
CREATE UNIQUE INDEX etoro_stock_earnings_once_idx ON public.etoro_stock_orders (user_id, environment, symbol, signal_expires_at)
  WHERE strategy = 'earnings-rebound' AND state NOT IN ('draft', 'rejected');

DROP FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric);
CREATE FUNCTION public.reserve_stock_autopilot_order(
  account uuid, mode text, config_version timestamptz, key_version timestamptz,
  session_day date, instrument integer, price numeric, signal_expiry timestamptz DEFAULT NULL,
  timed_exit timestamptz DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  config public.stock_autopilot%ROWTYPE;
  order_id uuid;
BEGIN
  IF signal_expiry IS NOT NULL AND signal_expiry <= now() THEN RETURN NULL; END IF;
  SELECT * INTO config FROM public.stock_autopilot WHERE user_id = account FOR UPDATE;
  IF NOT FOUND OR config.active_environment IS DISTINCT FROM mode OR config.updated_at <> config_version THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.etoro_connections WHERE user_id = account AND environment = mode AND updated_at = key_version FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.etoro_stock_orders WHERE user_id = account AND environment = mode
    AND (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL)
    AND closed_at IS NULL AND state NOT IN ('draft', 'rejected')
  ) THEN RETURN NULL; END IF;
  INSERT INTO public.etoro_stock_orders (
    user_id, environment, connection_version, symbol, strategy, request, state, reference_price,
    signal_day, signal_expires_at, strategy_exit_at
  ) VALUES (
    account, mode, key_version, config.symbol, config.strategy,
    jsonb_build_object('action', 'open', 'transaction', 'buy', 'instrumentId', instrument,
      'settlementType', 'real', 'orderType', 'mkt', 'leverage', 1, 'amount', config.amount, 'orderCurrency', 'usd'),
    'sending', price, session_day, signal_expiry, timed_exit
  ) ON CONFLICT DO NOTHING RETURNING id INTO order_id;
  RETURN order_id;
END $$;
REVOKE ALL ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric, timestamptz, timestamptz) TO service_role;

DO $$
DECLARE base text;
BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stock-autopilot', '*/2 13-21 * * 1-5',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/stock-autopilot'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.stock_autopilot WHERE active_environment IS NOT NULL)'
      || ' OR EXISTS (SELECT 1 FROM public.etoro_stock_orders'
      || ' WHERE (signal_day IS NOT NULL OR strategy_exit_at IS NOT NULL) AND closed_at IS NULL AND state NOT IN (''draft'', ''rejected''));');
  END IF;
END $$;
