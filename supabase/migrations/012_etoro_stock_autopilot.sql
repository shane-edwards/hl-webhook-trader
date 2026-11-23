CREATE TABLE public.stock_autopilot (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  strategy text NOT NULL CHECK (strategy IN ('breakout', 'pullback')),
  amount numeric NOT NULL CHECK (amount BETWEEN 1 AND 10000),
  active_environment text CHECK (active_environment IN ('demo', 'real')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_message text
);
ALTER TABLE public.stock_autopilot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_autopilot FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stock_autopilot TO service_role;

ALTER TABLE public.etoro_stock_orders
  ADD COLUMN signal_day date,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN close_requests jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX etoro_stock_auto_daily_idx ON public.etoro_stock_orders (user_id, environment, signal_day) WHERE signal_day IS NOT NULL;
CREATE INDEX etoro_stock_auto_open_idx ON public.etoro_stock_orders (user_id, environment) WHERE signal_day IS NOT NULL AND closed_at IS NULL;

CREATE FUNCTION public.reserve_stock_autopilot_order(
  account uuid, mode text, config_version timestamptz, key_version timestamptz,
  session_day date, instrument integer, price numeric
) RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  config public.stock_autopilot%ROWTYPE;
  order_id uuid;
BEGIN
  SELECT * INTO config FROM public.stock_autopilot WHERE user_id = account FOR UPDATE;
  IF NOT FOUND OR config.active_environment IS DISTINCT FROM mode OR config.updated_at <> config_version THEN RETURN NULL; END IF;
  PERFORM 1 FROM public.etoro_connections WHERE user_id = account AND environment = mode AND updated_at = key_version FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.etoro_stock_orders WHERE user_id = account AND environment = mode AND signal_day IS NOT NULL AND closed_at IS NULL AND state <> 'rejected') THEN RETURN NULL; END IF;
  INSERT INTO public.etoro_stock_orders (user_id, environment, connection_version, symbol, strategy, request, state, reference_price, signal_day)
  VALUES (account, mode, key_version, config.symbol, config.strategy, jsonb_build_object('action', 'open', 'transaction', 'buy', 'instrumentId', instrument,
    'settlementType', 'real', 'orderType', 'mkt', 'leverage', 1, 'amount', config.amount, 'orderCurrency', 'usd'), 'sending', price, session_day)
  ON CONFLICT DO NOTHING RETURNING id INTO order_id;
  RETURN order_id;
END $$;
REVOKE ALL ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock_autopilot_order(uuid, text, timestamptz, timestamptz, date, integer, numeric) TO service_role;

DO $$ DECLARE base text; BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stock-autopilot', '*/5 13-21 * * 1-5',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/stock-autopilot'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.stock_autopilot WHERE active_environment IS NOT NULL)'
      || ' OR EXISTS (SELECT 1 FROM public.etoro_stock_orders WHERE signal_day IS NOT NULL AND closed_at IS NULL AND state <> ''rejected'');');
  END IF;
END $$;
