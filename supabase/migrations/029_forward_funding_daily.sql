-- Daily funding per coin for the funding basket forward test: the sum of each UTC day's hourly rates
-- on Hyperliquid and how many there were. Kept so the weekly ranking only fetches the days it lacks.
CREATE TABLE IF NOT EXISTS public.forward_funding_daily (
  symbol text NOT NULL,
  day date NOT NULL,
  funding_sum double precision NOT NULL,
  prints integer NOT NULL CHECK (prints >= 0),
  PRIMARY KEY (symbol, day)
);

ALTER TABLE public.forward_funding_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.forward_funding_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.forward_funding_daily TO service_role;
