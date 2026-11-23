ALTER TABLE public.etoro_stock_orders
  ADD COLUMN decision_quote jsonb,
  ADD COLUMN submission_quote jsonb,
  ADD COLUMN estimated_costs jsonb,
  ADD COLUMN fill_metrics jsonb,
  ADD COLUMN broker_state smallint,
  ADD COLUMN broker_message text,
  ADD COLUMN close_execution jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN statement_financing_usd numeric;

CREATE TABLE public.stock_scan_journal (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('real', 'demo')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('submitted', 'skipped', 'error')),
  detail text NOT NULL
);
CREATE INDEX stock_scan_journal_mode_idx ON public.stock_scan_journal (user_id, environment, observed_at DESC);
ALTER TABLE public.stock_scan_journal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_scan_journal FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.stock_scan_journal TO service_role;

CREATE TABLE public.stock_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind = 'intraday'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object')
);
CREATE INDEX stock_research_runs_user_idx ON public.stock_research_runs (user_id, created_at DESC);
ALTER TABLE public.stock_research_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_research_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.stock_research_runs TO service_role;
