-- Each logged trade idea keeps the probability predicted for it when it appeared (target before stop
-- within the scoring week) and how many earlier ideas that prediction drew on, so it can be scored
-- later against what the price did.
ALTER TABLE public.suggestion_log
  ADD COLUMN IF NOT EXISTS predicted_prob NUMERIC(5,4) CHECK (predicted_prob >= 0 AND predicted_prob <= 1),
  ADD COLUMN IF NOT EXISTS predicted_n INTEGER CHECK (predicted_n >= 0);
