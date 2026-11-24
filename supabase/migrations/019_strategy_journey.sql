ALTER TABLE public.automation_runs
  DROP CONSTRAINT automation_runs_kind_check,
  ADD COLUMN idea_id text,
  ADD CONSTRAINT automation_runs_kind_check CHECK (kind IN ('daily', 'weekly', 'focused')),
  ADD CONSTRAINT automation_runs_idea_check CHECK ((kind = 'focused') = (idea_id IS NOT NULL));

DROP INDEX public.automation_one_pending_run;
CREATE UNIQUE INDEX automation_one_pending_run
  ON public.automation_runs (user_id, market, kind, coalesce(idea_id, '')) WHERE status IN ('queued', 'running');

CREATE INDEX automation_idea_history
  ON public.automation_runs (user_id, market, idea_id, created_at DESC) WHERE kind='focused';

ALTER TABLE public.automation_profiles ADD COLUMN paper_version text;
