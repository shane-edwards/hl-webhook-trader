-- Forward tests: a frozen rule is run day by day on new dates and its hypothetical trades are logged.
-- Record-only research; nothing here places an order. Written by the existing hl-market job.

-- Daily positioning readings (Binance public archive, 23:00 UTC) for the days after the bundled seed.
CREATE TABLE IF NOT EXISTS public.forward_positioning (
  symbol text NOT NULL,
  day date NOT NULL,
  open_interest double precision NOT NULL,
  account_ratio double precision NOT NULL,
  PRIMARY KEY (symbol, day)
);

CREATE TABLE IF NOT EXISTS public.forward_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('long', 'short')),
  -- 'tested': a coin the original study covered. 'extension': a coin it never saw.
  basket text NOT NULL CHECK (basket IN ('tested', 'extension')),
  signal_day date NOT NULL,
  entry_day date NOT NULL,
  entry_price double precision NOT NULL,
  stop_price double precision NOT NULL,
  -- The last day fully accounted for, so a run resumes where the previous one stopped.
  last_day date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  exit_day date,
  exit_price double precision,
  exit_reason text,
  -- Fractions of the entry notional: price move in the trade's direction, funding paid, and net after fees.
  gross double precision,
  funding double precision,
  net double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy, symbol, entry_day)
);
CREATE INDEX IF NOT EXISTS forward_trades_open ON public.forward_trades (strategy) WHERE status = 'open';

-- One row per strategy and UTC day once that day has been worked, with what was seen.
CREATE TABLE IF NOT EXISTS public.forward_test_days (
  strategy text NOT NULL,
  day date NOT NULL,
  checked_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (strategy, day)
);

ALTER TABLE public.forward_positioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forward_test_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.forward_positioning, public.forward_trades, public.forward_test_days FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.forward_positioning, public.forward_test_days TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.forward_trades TO service_role;
