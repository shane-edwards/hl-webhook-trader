-- Keep broker references after a key is replaced so uncertain submissions can be reconciled.
CREATE TABLE public.etoro_stock_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  connection_version timestamptz NOT NULL,
  symbol text NOT NULL,
  strategy text CHECK (strategy IN ('breakout', 'pullback')),
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'sending', 'submitted', 'filled', 'rejected', 'review')),
  reference_price numeric NOT NULL,
  broker_order_id bigint,
  position_ids bigint[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX etoro_stock_orders_user_idx ON public.etoro_stock_orders (user_id, environment, created_at DESC);
CREATE UNIQUE INDEX etoro_stock_orders_pending_idx ON public.etoro_stock_orders (user_id, environment, symbol)
  WHERE state IN ('sending', 'submitted', 'review');
ALTER TABLE public.etoro_stock_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.etoro_stock_orders FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.etoro_stock_orders TO service_role;
ALTER TABLE public.etoro_connections DROP CONSTRAINT etoro_connections_pkey;
ALTER TABLE public.etoro_connections ADD PRIMARY KEY (user_id, environment);
