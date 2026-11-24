ALTER TABLE public.automation_profiles
  ADD COLUMN scan_for_opportunities boolean NOT NULL DEFAULT false,
  ADD COLUMN live_scan_versions text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT automation_profiles_opportunity_mode CHECK (
    NOT scan_for_opportunities AND cardinality(live_scan_versions) = 0
    OR scan_for_opportunities AND (mode = 'paper' AND cardinality(live_scan_versions) = 0
      OR mode = 'live' AND cardinality(live_scan_versions) BETWEEN 1 AND 8 AND live_version = ANY(live_scan_versions))
  );

DO $$
DECLARE
  definition text;
  anchor constant text := '(approval.mode <> ''live'' OR approval.live_version IS DISTINCT FROM approved_version)';
BEGIN
  SELECT pg_get_functiondef('public.reserve_automated_stock_entry(uuid,text,timestamptz,timestamptz,date,integer,numeric,timestamptz,timestamptz,numeric,text,timestamptz)'::regprocedure)
    INTO definition;
  IF strpos(definition, anchor) = 0 THEN RAISE EXCEPTION 'Unexpected stock automation reservation'; END IF;
  EXECUTE replace(definition, anchor,
    '(approval.mode <> ''live'' OR CASE WHEN approval.scan_for_opportunities THEN NOT COALESCE(approved_version = ANY(approval.live_scan_versions), false) ELSE approval.live_version IS DISTINCT FROM approved_version END)');
END $$;
