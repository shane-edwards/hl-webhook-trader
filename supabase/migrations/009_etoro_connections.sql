CREATE TABLE public.etoro_connections (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  environment text NOT NULL CHECK (environment IN ('demo', 'real')),
  credentials_encrypted text NOT NULL,
  discovery jsonb,
  scan_attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.etoro_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.etoro_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.etoro_connections TO service_role;

-- Reuse the project's existing cron authorization without copying the secret into source.
DO $$ DECLARE base text; BEGIN
  SELECT command INTO base FROM cron.job WHERE jobname = 'hl-autopilot';
  IF base IS NOT NULL THEN
    PERFORM cron.schedule('tideframe-stocks', '0,20,40 15 * * 1-5',
      regexp_replace(replace(base, '/api/cron/autopilot', '/api/cron/stocks'), ';\s*$', '')
      || ' WHERE EXISTS (SELECT 1 FROM public.etoro_connections WHERE scan_attempted_at IS NULL OR scan_attempted_at < now() - interval ''4 hours'');');
  END IF;
END $$;
