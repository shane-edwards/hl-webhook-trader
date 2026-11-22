# HL Trader: status and to-do list

Written 2026-11-22 as a handoff for a new working session. Read the "State of the platform" and
"Ground rules" sections before starting on the list.

## State of the platform

Live at `https://hl-webhook-trader.vercel.app`. Vercel deploys `master` automatically; every pull
request gets a preview build. The production database is Supabase project `Trading`
(ref `famqzrvaivcwjwxohgev`, Tokyo), with migrations `001` to `005` applied.

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
crons). `CRON_SECRET` is set in Vercel and embedded in that job.

### What the research found (read before proposing strategies)

About 600 configurations have been tested, each with fees, slippage, funding and stops, and each
checked on data it was not chosen on. Reports are in `backtest/`:

- `RESULTS.md`: daily BTC trend strategy; funding, not fees, is the main cost of leveraged longs.
- `INTRADAY.md`, `SCALPING.md`: candle-based scalping has no edge, with or without fees (517
  configurations, none passed; a planted look-ahead rule does pass, so the harness works).
- `UNIVERSE.md`: the live-eligible rule on 22 coins; cross-coin momentum.
- `POPULAR.md`: 35 TradingView and indicator strategies with volume and 5-minute data.
- `AUTOPILOT.md`: evidence behind the live gate.

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
- To see the UI locally you need a stand-in for Supabase auth and tables. The previous session
  used a small mock HTTP server and a forged session cookie with Playwright; it was not committed.
  Consider committing one under `scripts/dev-mock/` (see item 16).

## To-do list

Ordered by recommended priority. Items 1, 2, 6, 8 and 9 were recommended as the first batch.

### Make manual trading smarter

**1. Size by risk in the trade ticket.**
Let the user enter the amount to risk (dollars or percent of account) and derive position size
from the stop distance: `size = risk / stop%`. Show margin, leverage needed and the resulting
size; cap at max position size and at the market's max leverage. Keep the existing "size in USD"
mode as an option.
*Where:* `components/dashboard/TradeTicket.tsx`; reuse `sizeNotional` from `lib/autopilot/risk.ts`.
*Done when:* changing the stop changes the size so the loss at the stop stays at the entered risk;
unit test for the sizing maths.

**2. Chart in the ticket and the ideas panel.**
Candles (hourly, last few days) with support and resistance levels, entry, stop and target drawn
as lines. Use the existing Recharts dependency or add `lightweight-charts`. Colour-blind-safe
series colours are defined in `app/globals.css` (`--series-1`, `--series-2`).
*Where:* new `components/charts/LevelsChart.tsx`; `/api/suggestions` should return the recent
candles (or add `/api/candles`).
*Done when:* lines move when the user edits stop/target; readable at phone width.

**3. Better exits.**
(a) Split take-profit: part at target 1, remainder at target 2 or trailing. (b) Move stop to
break-even after target 1. (c) Trailing stop. Hyperliquid has no native trailing order, so (b) and
(c) need the 5-minute scan to amend trigger orders; that means a stop only trails as often as the
scan runs. Say so in the UI.
*Where:* `lib/hyperliquid/client.ts` (`placeProtectiveOrders` takes one size today),
`lib/execution.ts`, a position-management pass in the cron route.
*Done when:* covered by simulated-exchange tests; order wire format checked against the SDK the
way `tests/signing.test.ts` does.

**4. Limit-order entries.**
Post-only (`Alo`) limit entries from the ticket and from suggestions ("buy at support"). Needs:
resting-order tracking, expiry/cancel, placing the stop and target once the entry fills (detected
by the scan), and a list of open orders on the dashboard. Maker fee is 0.015% versus 0.045%.
*Where:* `lib/hyperliquid/client.ts` (add `placeLimitOrder`), new `pending_orders` table.
*Done when:* an unfilled order never leaves an orphaned stop; a filled one always gets its stop.

**5. Trade ideas across the whole market.**
Scan every liquid Hyperliquid perp (for example, over $5M daily volume from `/api/markets`),
rank by score, and alert when a market flips to a long or short read. Each market needs about
2,430 hourly candles, so cache results (for example a `suggestions_cache` table refreshed by the
5-minute scan) rather than computing on page load.
*Where:* `lib/suggestions.ts`, `app/api/cron/autopilot/route.ts` or a new cron route.

### Find out what actually works

**6. Scorecard for suggestions.**
Neither the long/short reads nor the stop/target placement has been tested. Record each
suggestion when it is shown (market, time, bias, score, stop, target, basis) and resolve it later
from candles: did price hit the target or the stop first, and what was the return after 1, 3 and
7 days. Show hit rate and average result by bias, by strength, and by stop basis (level versus
volatility). Also run it historically: replay `buildSuggestion` over cached candles so there is a
backtest without waiting weeks.
*Where:* new `backtest/suggestions.ts`, new `suggestion_log` table, a panel on the dashboard or Lab.
*Done when:* the report states plainly whether level-based stops beat volatility-only stops.

**7. Trade journal.**
Tag each manual trade automatically (followed the read, against the read, no read; used the
suggested stop or changed it) and allow a free-text note. Show results by tag.
*Where:* `trades.webhook_payload` can carry the tags for manual trades, or add columns;
`app/api/trade/route.ts`; Trades and Analytics pages.

**8. True profit per trade.**
Pull fees, funding and realised P&L from Hyperliquid (`userFillsByTime`, `userFunding`) and store
them on the trade row (`fees`, `funding_paid` columns already exist and are always 0). The fills
response shape was taken from documentation and never confirmed against an account with recent
fills; verify it first.
*Where:* `lib/hyperliquid/public.ts`, `lib/trade-records.ts`, a sync step in the scan.

**9. Fix the Analytics page.**
Sharpe is computed on per-trade dollar P&L and annualised with sqrt(252); Calmar and drawdown
percent are measured against cumulative P&L instead of account equity. Rebuild the page on the
exchange's account-value history (`getAccountTruth` in `lib/hyperliquid/public.ts`) and net
per-trade figures from item 8. Remove any metric that cannot be computed honestly.
*Where:* `lib/analytics.ts`, `app/(dashboard)/analytics/page.tsx`.

### Protect the account

**10. Portfolio-level limits.**
A cap on total exposure across all positions and a daily loss limit that applies to manual and
webhook trades as well as the Autopilot. BTC, ETH and SOL move together, so count correlated
positions as one risk (simplest version: cap gross exposure as a multiple of equity).
*Where:* `lib/autopilot/risk.ts` generalised; enforced in `lib/execution.ts` so every entry path
passes through it.

**11. Keep records in step with the exchange.**
Webhook and manual trade rows stay "open" if the stop is hit or the position is closed on
Hyperliquid directly. Reconcile on each scan: compare open rows with exchange positions and
settle the missing ones from fills (the Autopilot already does a rough version for its own
positions in `lib/autopilot/run.ts`).

**12. Alerts and a daily summary.**
Telegram needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Vercel (the user must create the
bot). Add a once-a-day summary: account value, day's P&L, open positions, what the Autopilot did.
Consider email as a second channel.

**13. Health monitoring.**
The database was found paused on 2026-11-22, which had silently broken login and webhooks. Add a
check that the webhook, the scan and the database are responding, and alert when the last
Autopilot scan is older than about 20 minutes. The 5-minute `pg_cron` job probably keeps the
project active now, but that is not confirmed.

### Carry-overs

**14. Volume-confirmed breakout as a paper strategy.**
20-day high (or low, for shorts) on volume above 1.5 times its 20-day average; exit on the
opposite 10-day extreme. Survived the holdout in `POPULAR.md` (long and short). The Autopilot reads
hourly candles without volume today; add volume to `getHourlyCandles` and daily aggregation to
`computeIndicators`, mark it `paperOnly`.

**15. Paper record versus backtest.**
On the Autopilot page, chart each strategy's paper equity against what the backtest predicted for
the same dates, so drift is visible early.

**16. Commit a local preview harness.**
A mock Supabase server and a Playwright screenshot script under `scripts/dev-mock/`, so UI changes
can be checked without production credentials. Never add an auth bypass to the app itself.

**17. Live-mode test on testnet.**
Before any real money: connect a wallet on Hyperliquid testnet, place a manual trade with stop
and target, close it, run the Autopilot in live mode there, and use the kill switch. Fix whatever
the first real orders reveal.

**18. Smaller items.**
- The 5-minute scan runs strategies on completed hourly candles; the stale-scan warning on the
  Autopilot page uses a 20-minute threshold.
- `eslint-config-next` is pinned to 14 while Next is 16.
- `middleware.ts` uses the deprecated name; Next 16 prefers `proxy.ts`.
- WalletConnect needs `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`; without it only in-wallet browsers
  work.
- One-click path from a trade idea to the ticket has not been exercised with a real long/short
  read.
