# dev-mock: preview the UI without production credentials

A fake Supabase plus a screenshot script, so UI changes can be looked at locally.
The app runs **unmodified**; only its environment points somewhere else.

## Run

Three terminals, from the repo root:

```bash
# 1. the fake Supabase (port 54321; PORT=... to change)
node scripts/dev-mock/server.mjs

# 2. the app, pointed at it
(set -a; . scripts/dev-mock/env.example; set +a; npx next dev)

# 3. screenshots of every dashboard page, desktop (1440x900) and phone (390x844)
node scripts/dev-mock/screenshot.mjs
```

PNGs land in `scripts/dev-mock/out/` (gitignored), named `<route>-<desktop|phone>.png`.

Screenshot options:

```bash
node scripts/dev-mock/screenshot.mjs /tmp/shots                    # another output directory
node scripts/dev-mock/screenshot.mjs --routes=/dashboard,/analytics
node scripts/dev-mock/screenshot.mjs --base=http://localhost:3100  # app on another port
node scripts/dev-mock/screenshot.mjs --supabase=http://localhost:54399 --wait=15000
```

Each line of output is `ok`, `warn` (console errors, failed requests or HTTP 4xx/5xx, listed
underneath) or `FAIL` (navigation failed, or the page ended up on `/login`). The exit code is 1
if any page failed. Playwright is expected to be installed globally; it is not a dependency of this repo.

To click around by hand, open <http://localhost:3000/login> and sign in with any email and
password: the mock accepts everything and you become `dev@example.com`.

If the app runs on a port other than 3000, also set `NEXT_PUBLIC_APP_URL` to match, and if the
mock moves, set `NEXT_PUBLIC_SUPABASE_URL` and pass `--supabase=` to the screenshot script
(the cookie name is derived from that URL's hostname).

## What is mocked

`server.mjs` has no dependencies and keeps everything in memory.

- **Auth** (`/auth/v1`): `GET /user` returns the dev user for any bearer token; `POST /token`
  (password or refresh) returns a session; `POST /logout` does nothing.
- **Tables** (`/rest/v1/<table>`): enough PostgREST for supabase-js. `select`, filters
  (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `is`, `like`, `ilike`, `not.`), `order`, `limit`,
  `offset`, insert, upsert, update, delete, `.single()` / `.maybeSingle()`, and `count: 'exact'`.
  A table that is not in the fixtures reads as empty and accepts inserts, so new tables just work.
- **Data**: `fixtures.json`, one array of rows per table. Strings such as `"@now-3h"`, `"@date-2d"`
  and `"@ms-5h"` become a timestamp, a date and epoch milliseconds relative to server start, so
  nothing looks stale. Edits made through the app last until the mock restarts;
  `curl -X POST localhost:54321/__mock/reset` reloads the fixtures and
  `curl localhost:54321/__mock/db` dumps the current state.

`screenshot.mjs` signs in by setting the same session cookie `@supabase/ssr` would have written
(`sb-localhost-auth-token`), holding an unsigned token that only the mock accepts.

## What is not mocked

- **The exchange.** Prices, markets, candles and funding come from the real public Hyperliquid
  API, so those pages need network access and change from run to run.
- **Wallets.** The seeded user has no wallet or key, so account value, live positions and
  anything that would place an order show "not connected". Paper autopilot works, including
  "Scan now", because it only reads public prices.
- **Database rules.** No row-level security, no column types or check constraints, no joins and
  no `rpc()`. Only a few unique keys are enforced. A query that works here can still fail on
  real Supabase, and fixture prices are a snapshot, so they drift from the live market.
- Realtime, storage, email, OAuth and Telegram.

## The rule

**No auth bypass goes in the app.** No "skip login in development" flag, no fake user in
`middleware.ts`, no env var that turns checks off. This harness works by replacing what the app
talks to, never by changing what the app checks, so the code under preview is the code that ships.
The dummy values in `env.example` open nothing real; keep it that way.
