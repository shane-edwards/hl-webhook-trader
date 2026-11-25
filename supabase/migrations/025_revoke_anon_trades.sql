-- A visitor who is not signed in has no business with the trade log. Row level security already
-- returns them nothing; this removes the table privilege itself. Signed-in sessions keep reading
-- their own rows. Safe to run more than once.
REVOKE ALL ON public.trades FROM anon;
