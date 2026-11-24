CREATE TABLE public.funding_hedge_observations (
  revision text NOT NULL,
  symbol text NOT NULL CHECK (symbol IN ('BTC', 'ETH')),
  hour timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  reading jsonb NOT NULL,
  PRIMARY KEY (revision, symbol, hour)
);

ALTER TABLE public.funding_hedge_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funding_hedge_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.funding_hedge_observations TO service_role;
