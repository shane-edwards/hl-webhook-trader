-- Existing live configurations retain their original strategy coverage until explicitly restarted.
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS autopilot_live_rules_confirmed boolean NOT NULL DEFAULT false;
