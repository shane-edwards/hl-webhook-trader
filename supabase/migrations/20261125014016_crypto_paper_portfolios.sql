-- Each observation has at most one successor, including two workers racing across an hour boundary.
create table public.crypto_paper_portfolios (
  user_id uuid not null references auth.users(id) on delete cascade,
  through_ms bigint not null,
  prior_ms bigint not null check (through_ms > prior_ms),
  observed_at timestamptz not null default now(),
  state jsonb not null,
  events jsonb not null,
  summary jsonb not null,
  primary key (user_id, through_ms),
  unique (user_id, prior_ms)
);
alter table public.crypto_paper_portfolios enable row level security;
revoke all on public.crypto_paper_portfolios from public, anon, authenticated, service_role;
grant select, insert on public.crypto_paper_portfolios to service_role;
