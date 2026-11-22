# HL Trader: status and to-do list

Written 2026-11-22 as a handoff for a new working session. Read the "State of the platform" and
"Ground rules" sections before starting on the list.

## State of the platform

Live at `https://hl-webhook-trader.vercel.app`. Vercel deploys `master` automatically; every pull
request gets a preview build. The production database is Supabase project `Trading`
(ref `famqzrvaivcwjwxohgev`, Tokyo), with migrations `001` to `006` applied.

| Area | What exists | Where |
|---|---|---|
| Webhook trading | TradingView signals to Hyperliquid perps, `position`/`action` semantics, max position size, optional `stop_loss_pct` / `take_profit_pct` | `app/api/webhook/route.ts`, `lib/webhook.ts`, `lib/execution.ts` |
| Exchange client | Orders, stop/target trigger orders, cancels, candles; signing checked against the official SDK | `lib/hyperliquid/` (`client.ts`, `signing.ts`, `format.ts`), `tests/signing.test.ts` |
| Wallet connect | One `approveAgent` signature creates a trade-only key (cannot withdraw) | `app/api/wallet/route.ts`, `lib/wallet/connect.ts`, `components/settings/WalletCard.tsx` |
| Manual trading | Trade ticket with pre-filled stop and target; close any position by symbol | `components/dashboard/TradeTicket.tsx`, `app/api/trade/route.ts` |
| Trade ideas | Long / short / no-trade read per market, every vote shown | `lib/suggestions.ts`, `app/api/suggestions/route.ts`, `components/dashboard/TradeIdeas.tsx` |
| Support / resistance | Levels from 30 days of hourly candles; used to place suggested stops and targets | `lib/levels.ts` |
| Autopilot | Hourly scanner, risk limits, paper mode, live gate, 4 per-market strategies plus a paper-only momentum basket | `lib/autopilot/` (`strategies.ts`, `run.ts`, `risk.ts`, `momentum.ts`), `app/(dashboard)/autopilot/page.tsx` |
| Daily BTC strategy | Volatility-targeted trend, daily Vercel cron, dry run by default | `lib/strategy/`, `app/api/cron/strategy/route.ts` |
| Kill switch | Pauses automation, closes every position | `app/api/risk/flatten/route.ts` |
| Research tools | Markets scanner, Strategy Lab, backtests | `app/(dashboard)/markets`, `app/(dashboard)/lab`, `backtest/` |
| Alerts | Telegram (built, not configured) | `lib/notify.ts` |

Current settings on the live account: mainnet, a trading key is saved, webhook off, daily strategy
off, Autopilot **on in paper mode** with shorts allowed. The Autopilot scan is called every
5 minutes by a `pg_cron` job in Supabase named `hl-autopilot` (Vercel's free plan only allows daily
crons); the same scan now also looks after limit orders, managed stops and the trade log. A second job,
`hl-market`, runs the whole-market ideas scan. `CRON_SECRET` is set in Vercel and embedded in that job.

### What the research found (read before proposing strategies)

About 600 configurations have been tested, each with fees, slippage, funding and stops, and each
checked on data it was not chosen on. Reports are in `backtest/`:

- `RESULTS.md`: daily BTC trend strategy; funding, not fees, is the main cost of leveraged longs.
- `INTRADAY.md`, `SCALPING.md`: candle-based scalping has no edge, with or without fees (517
  configurations, none passed; a planted look-ahead rule does pass, so the harness works).
- `UNIVERSE.md`: the live-eligible rule on 22 coins; cross-coin momentum.
- `POPULAR.md`: 35 TradingView and indicator strategies with volume and 5-minute data.
- `AUTOPILOT.md`: evidence behind the live gate.
- `SUGGESTIONS.md`: the trade ideas replayed over history; no edge after costs.

The consistent pattern: long-only trend rules made money through 2024 and nothing in 2025-2026,
when the market fell. The only rules profitable in 2025-2026 can go short (90-day cross-coin
momentum, 4-hour MACD with a 200-average filter, volume-confirmed 20-day breakout). Each is a
lone survivor of its batch, so each is on paper until it has a track record.

**Never tested with a real account:** no real order, stop-loss, wallet connection or Autopilot live
trade has been placed. Everything live-facing is verified only against the SDK's signatures, a
simulated exchange, and read-only calls.

## Ground rules

1. **No strategy trades real money without evidence.** `lib/autopilot/evidence.json` (written by
   `npm run backtest:autopilot`) is the gate. Rules chosen after their recent results were known
   carry `paperOnly: true` and stay on paper even if they pass.
2. **Test protocol:** choose on 2020-2022 and 2023-2024; look at 2025 onward once, for the chosen
   ones only. State how many variants were tested. Do not tune after seeing the holdout.
3. **Same code live and in backtest.** Signals live in `lib/`; backtests import them.
4. **Report honestly.** Losing results go in the report and the UI. Do not present a backtest as a
   forecast or imply guaranteed profit.
5. **Checks before every merge:** `npm test`, `npx eslint .`, `npx tsc --noEmit`, `npx next build`.
6. **Deploying:** open a pull request to `master`, wait for the Vercel preview to pass, merge.
   New database changes go in a numbered file under `supabase/migrations/` and must leave the app
   working when the migration has not been run yet.

### Working environment

- Cloud environment `hl-webhook-trader` holds access tokens for `api.supabase.com` and
  `api.vercel.com` (injected by the network proxy; never printed). SQL can be run through the
  Supabase management API (`POST /v1/projects/{ref}/database/query`). The site itself is not
  reachable from that environment; test live endpoints by calling them from Supabase with `pg_net`.
- Vercel: project `hl-webhook-trader`, team `team_kRdnCAPeO7o2DxwJCvBbSQHJ`, Hobby plan. The same
  token can see three unrelated projects; leave them alone.
- Candle caches in `backtest/data/intraday/` are not committed. `npx tsx backtest/candles.ts`
  downloads them (about 10 minutes, mostly the 5-minute files).
- To see the UI locally use `scripts/dev-mock/` (mock Supabase, forged session cookie, Playwright screenshots).

## To-do list

Updated 2026-11-22 after a session that worked through all 18 items. What follows is what was built for each,
and what is still open. The open items are collected first.

### Still open (needs the account owner, or a real exchange)

- **Run the testnet check (item 17).** `npm run testnet:check` with a funded Hyperliquid testnet key places one small
  position and walks it through every order type the app sends: market entry, stop and target, moving a stop, split
  targets, a post-only limit entry with attached stop and target, cancel, close, and reading fills. It has **not been
  run**: no key was available. Nothing live-facing has been placed with a real account yet, and that now includes
  limit entries, split targets and stop moves.
- **New order shapes were not signed by the official SDK.** The session could not install the Python SDK to produce
  reference signatures. The tests show the builders reproduce the two SDK-verified actions exactly and that the new
  shapes (trigger legs with grouping `na`, `Alo` limit, `normalTpsl`) keep the same field order, but the exchange
  accepting them is only proven by the testnet check. In particular, confirm how `normalTpsl` children behave on a
  partial fill, and that open orders are labelled "Stop Market" / "Take Profit Market" (the exits code tells stops
  from targets by that text).
- **Alerts are still not delivered.** Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Vercel; email
  needs `RESEND_API_KEY` and `ALERT_EMAIL_TO`. Until one is set, health warnings, idea alerts and the daily summary
  are computed and dropped. Settings shows which channels are configured and has a test button.
- **WalletConnect** still needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.
- **An outside uptime monitor** pointed at `/api/health` (returns 503 when something is down) would catch the one case
  the app cannot report itself: Vercel being unreachable.
- **The daily BTC strategy does not pass through the portfolio limits.** It rebalances toward a target exposure under
  its own leverage cap and calls the exchange client directly. It is off and in dry run today.
- **`react-hooks/set-state-in-effect` is switched off** in `eslint.config.mjs`. Every page loads data in an effect;
  satisfying the rule means moving to a data-fetching library.

### What the new research found

- **The trade ideas have no measurable edge.** Replayed over 2021 to 2026 on BTC, ETH and SOL (2,962 ideas), the average
  result was 0.00% per idea after costs, and -0.06% from 2025 on. See `backtest/SUGGESTIONS.md`. The dashboard says so.
- **Stops at support/resistance did not beat volatility-only stops.** On identical entries they were slightly worse in
  all three periods (0.07 percentage points per idea). The level-based placement was kept because nothing shows the
  alternative is better by a margin that matters, but it should not be described as an improvement.
- **Volume breakout** passes the gate on BTC/ETH/SOL (long and short: +13% a year since 2023, +9% from 2025) and is
  `paperOnly`, like MACD trend. Ten variants are now in `evidence.json`; the existing eight are unchanged.

### Done

**1. Size by risk.** `lib/sizing.ts`, trade ticket "By amount at risk" (percent or dollars), capped by max position
size and the market's max leverage; "Size in USD" kept. Tests: the loss at the stop stays at the entered risk.

**2. Chart.** `components/charts/LevelsChart.tsx` (plain SVG) in the ticket and in each expanded idea: hourly candles,
support/resistance, entry, stop, targets. Lines follow edits. `/api/candles`.

**3. Better exits.** `lib/exits.ts`: split take-profit, break-even after target 1, trailing stop. Orders rest on the
exchange; the five-minute scan moves the stop (new one placed before the old one is cancelled) and the UI says so.
Table `position_plans`. Simulated-exchange tests in `tests/upgrades.test.ts`.

**4. Limit entries.** `lib/pending.ts`, `placeLimitEntry` in the client, table `pending_orders`, "Open orders and exit
plans" panel, `/api/orders`. Stop and target are children of the entry (`normalTpsl`); the scan re-checks both rules
on every pass. Simple stop and target only: managed exits are for market entries.

**5. Whole-market ideas.** `lib/market-scan.ts`, `/api/cron/market`, table `suggestions_cache`. Markets over $5M daily
volume (60 at most), 12 refreshed per run. Alerts when a read turns long or short.

**6. Scorecard.** Live: table `suggestion_log`, scored by the market scan. Historical: `npm run backtest:suggestions`.
Panel on the dashboard under the ideas.

**7. Journal.** `lib/journal.ts`: tags in `trades.webhook_payload.journal`, optional note in the ticket, results by
tag on Analytics, tag shown on the Trades page.

**8. True profit per trade.** `lib/reconcile.ts`: fees, funding and realised P&L per trade from `userFillsByTime` and
`userFunding`. Response shapes were confirmed against live mainnet accounts. Columns `exchange_pnl`, `net_pnl`,
`fills_synced_at`. Not yet seen working on this account, which has no fills.

**9. Analytics.** Rebuilt on the exchange's account-value history: return (deposits excluded), drawdown on equity,
Sharpe from daily returns only with 30 or more of them. Sortino, Calmar, recovery factor, Kelly and VaR removed.

**10. Portfolio limits.** `lib/risk/portfolio.ts`, enforced inside `openPosition` and `placeLimitEntry`. Gross
exposure cap (default 3x) and account daily loss limit (default 5%), editable in Settings.

**11. Reconcile.** Same module as item 8: open rows with no position behind them are settled from the exchange's
closing fills. When the exchange shows neither a position nor a closing fill, the rows are cancelled without a
profit or loss (there is no honest exit price).

**12. Alerts and daily summary.** Email channel added (`lib/notify.ts`); summary in `lib/upkeep.ts`. Needs a channel
configured (see above).

**13. Health.** `lib/health.ts`, table `system_health`, `/api/health`, banner on the dashboard. Each scan records a
heartbeat and alerts about the other after 20 minutes; the daily Vercel cron checks both and the database.

**14. Volume breakout.** `volume_breakout` in `lib/autopilot/strategies.ts`, with daily bars and volume added to the
indicators. Paper only.

**15. Paper versus backtest.** `lib/autopilot/drift.ts`, `/api/autopilot/drift`, chart on the Autopilot page. The
simulator moved to `lib/autopilot/simulate.ts` so the backtest and the comparison share it.

**16. Preview harness.** `scripts/dev-mock/`: mock Supabase, screenshots of every page, and `ticket.mjs`, which walks
idea to ticket using made-up long and short reads.

**17. Testnet.** Script written, not run (see above).

**18. Smaller items.** `eslint-config-next` 16 with ESLint 9 and a flat config; `middleware.ts` renamed `proxy.ts`;
the idea-to-ticket path exercised in the harness (which found and fixed a bug: a slow reply for the watched list could
overwrite the whole-market list).

### Database and scheduling

Migration `006_trading_upgrades.sql` adds everything above. A second `pg_cron` job, `hl-market`, calls
`/api/cron/market` every five minutes.
