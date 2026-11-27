-- Funding-rate gap scanner (record-only research). One row per market per five-minute scan with
-- each venue's funding per hour, taken from Hyperliquid's public predictedFundings feed. The
-- existing hl-market job writes the rows, so no schedule changes here.

CREATE TABLE IF NOT EXISTS public.funding_gap_scans (
  scanned_at timestamptz NOT NULL,
  symbol text NOT NULL,
  hl_rate double precision,
  binance_rate double precision,
  bybit_rate double precision,
  hl_spread double precision,
  hl_volume double precision NOT NULL,
  PRIMARY KEY (scanned_at, symbol)
);

ALTER TABLE public.funding_gap_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funding_gap_scans FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.funding_gap_scans TO service_role;

-- Averages per market since a given time. For each venue pair: how many scans quoted both venues,
-- the average signed difference in funding per hour (first venue minus second), and the share of
-- those scans where the first venue paid more.
CREATE OR REPLACE FUNCTION public.funding_gap_summary(since timestamptz)
RETURNS TABLE (
  symbol text, scans integer, hl_spread double precision, hl_volume double precision,
  hl_binance_n integer, hl_binance_gap double precision, hl_binance_above double precision,
  hl_bybit_n integer, hl_bybit_gap double precision, hl_bybit_above double precision,
  binance_bybit_n integer, binance_bybit_gap double precision, binance_bybit_above double precision
)
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT s.symbol, count(*)::integer, avg(s.hl_spread), avg(s.hl_volume),
    count(s.hl_rate - s.binance_rate)::integer, avg(s.hl_rate - s.binance_rate), avg((s.hl_rate > s.binance_rate)::integer::double precision),
    count(s.hl_rate - s.bybit_rate)::integer, avg(s.hl_rate - s.bybit_rate), avg((s.hl_rate > s.bybit_rate)::integer::double precision),
    count(s.binance_rate - s.bybit_rate)::integer, avg(s.binance_rate - s.bybit_rate), avg((s.binance_rate > s.bybit_rate)::integer::double precision)
  FROM public.funding_gap_scans s
  WHERE s.scanned_at >= since
  GROUP BY s.symbol;
$$;

REVOKE ALL ON FUNCTION public.funding_gap_summary(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.funding_gap_summary(timestamptz) TO service_role;
