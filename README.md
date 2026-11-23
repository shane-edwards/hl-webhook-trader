# Tideframe

Market research and strategy automation for Hyperliquid crypto perps and US stocks.

## US Stocks and eToro

Open **US Stocks → eToro account** and connect an eToro Demo or Real key pair with Read access. Keys are verified before they replace an existing connection, and are encrypted in each user's own server-only record. The connection reads eToro data and does not expose order endpoints. Apply `009_etoro_connections.sql` before deploying. Where `hl-autopilot` already exists, the migration also schedules weekday stock discovery at 15:00 UTC with two follow-up slots for other accounts. Set an identifying contact in `SEC_USER_AGENT` when operating the SEC filing client.

**Discover** scans 12 selected US stocks. Its 100-point grade combines technical and relative strength (against SPY), market risk, spread and annual SEC filing metrics. Expand a result to see every factor, its score and data coverage. Strong buy also requires a recent quote, acceptable spread, positive SPY-relative performance and annual filing coverage. The scores are research rankings. Annual point-in-time figures support the current screen and are not used by the historical technical strategy replay.

**Simulate** tests two native technical strategies with no TradingView input. Signals are evaluated on completed daily candles and filled on the next session's opening bid or ask with configurable extra slippage and commission. The final 30% starts flat, is reported separately and is replayed with doubled additional costs. Results use the broker's price series and exclude dividends. The stock strategies are research-only. Crypto Autopilot and the market scanner already run natively on Hyperliquid and retain their own execution controls.

**Intraday research** compares five fixed opening, VWAP, and SPY momentum rules on five-minute eToro candles. It separates the regular New York session from extended hours, reports historical results across three chronological periods, and replays recent data on demand. See [the research protocol](backtest/STOCK-INTRADAY.md).

**Opening volume research** measures whether ranking unusual opening activity across a 17-stock basket improves the net outcome over choosing stocks by ordinary liquidity. It compares stock and CFD costs and keeps the last sample separate. See [the opening study](backtest/STOCK-OPENING.md).

**Earnings and reversal research** compares market-relative stock moves and SEC-timestamped earnings events, checks changes in the broker quote spread, and tests a frozen earnings setup on a different stock universe. See [the factor study](backtest/STOCK-FACTORS.md).

## Features

- **TradingView Integration** — Receive webhook signals and execute perp orders automatically
- **Hyperliquid Trading** — Market long/short/close with configurable leverage and size
- **Built-in BTC strategy** — Optional daily volatility-targeted trend strategy that runs on a cron with no TradingView needed ([backtest](backtest/RESULTS.md))
- **Live Dashboard** — Account value and P&L straight from the exchange (including fees and funding paid), positions, automation status
- **Wallet connect** — Link your Hyperliquid wallet (SafePal, MetaMask, any WalletConnect wallet) with one signature. The app gets a trade-only key; it can never withdraw
- **Trade ticket** — Market or post-only limit entries, sized by the amount you are prepared to lose, with a chart of support, resistance, entry, stop and target that follows your edits
- **Managed exits** — Split take-profit, stop to break-even after the first target, and a trailing stop. Stops and targets rest on the exchange; moving a stop is done by this app about every ten seconds while a position is open
- **Account limits** — A cap on total exposure and a daily loss limit that apply to every entry, manual, webhook or Autopilot
- **Stop-loss / take-profit on webhook trades** — Per signal (`stop_loss_pct`, `take_profit_pct`) or as defaults in Settings
- **Autopilot** — Scans your chosen markets and opens and closes positions by tested rules, sized by risk, every position with an exchange-side stop. Paper mode builds a track record before any real money is used
- **Trade ideas** — A long / short / no-trade read for the markets you watch and for every liquid Hyperliquid market, built from the rules that held up in testing, with every vote shown, and an alert when a market's read changes
- **Scorecard** — Every idea is logged and scored against what the price then did, alongside a replay over history ([report](backtest/SUGGESTIONS.md))
- **True profit per trade** — Fees, funding and realised P&L pulled from the exchange onto each trade, and trade records settled automatically when a stop is hit or a position is closed on Hyperliquid directly
- **Trade journal** — Manual trades are tagged by whether they followed the rules' read and the suggested stop, with results by tag
- **Smart ticket defaults** — The trade ticket pre-fills a stop-loss and take-profit for the chosen side from recent volatility, the last 24 hours' range and the stops the tested rules use; you can override both
- **Kill switch** — One button pauses all automation and closes every position
- **Markets scanner** — Live funding, premium, open interest and volume for every Hyperliquid perp, sortable
- **Strategy Lab** — Run the trend strategy on 10 coins with your own settings against buy & hold, with real costs; plus research notes on funding capture and multi-coin trend
- **Alerts** — Every alert is kept in a log on the dashboard. Optional phone channels, ntfy push (no account needed), Telegram and/or email: trades, strategy runs, errors, kill-switch use, a daily summary, and a warning when a scheduled scan or the database stops responding
- **Health check** — `/api/health` reports whether the database and the scheduled scans are alive (public, no account data), so an outside uptime monitor can watch it
- **Trade Management** — Manually cancel/close any active position from the UI
- **Performance Analytics** — Return, drawdown and Sharpe measured on the exchange's own account-value history (deposits excluded); per-trade statistics net of fees and funding. Metrics that could not be computed honestly were removed
- **Secure Auth** — Supabase Auth with email/password login
- **Encrypted Credentials** — Private key stored with AES-256-GCM encryption
- **Admin Settings** — Configure leverage, order size, slippage, webhook secret from the UI
- **Mobile Responsive** — Full mobile support with bottom navigation

## Stack

- **Next.js 16** (App Router)
- **Supabase** (Auth + PostgreSQL + Row Level Security)
- **Hyperliquid API** (EIP-712 signed perp trading)
- **Tailwind CSS** + Radix UI
- **Recharts** (performance charts)
- **Vercel** (deployment)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/shane-edwards/hl-webhook-trader.git
cd hl-webhook-trader
npm install
```

### 2. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Go to **SQL Editor** and run the migrations in order from `001_initial.sql` through `009_etoro_connections.sql` (all in `supabase/migrations/`)
3. Copy your project URL, anon key, and service role key

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

Generate an encryption key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### 5. Create your first user

In Supabase Dashboard → **Authentication** → **Users** → **Add user**

### 6. Configure in the app

1. Log in and go to **Settings**
2. Choose the network (start on **Testnet**), then use the **Wallet** card to connect:
   - **SafePal / any mobile wallet:** open the app's URL inside the wallet's built-in browser (SafePal → DApp tab) and tap *Connect wallet in this browser*. No extra setup.
   - **Desktop with a browser-extension wallet:** same button.
   - **WalletConnect QR:** set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (free at cloud.reown.com) and use the WalletConnect button.

   You sign one "approve agent" message. That authorises a separate trading key, created and stored encrypted by this app, which can place and cancel orders but **cannot withdraw or transfer funds**. Your wallet's own key never leaves the wallet. The wallet must already have deposited to Hyperliquid. Revoke any time with *Disconnect*, or on Hyperliquid under More → API. (Pasting an API wallet key by hand still works under the advanced card.)
3. Configure leverage, order size, and slippage
4. Enable webhook trading and copy your webhook secret
5. Copy the Webhook URL

### 7. TradingView Setup

In your TradingView alert:
- **Webhook URL**: `https://your-app.vercel.app/api/webhook`
- **Message**:

```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "signal_id": "{{strategy.order.id}}-{{timenow}}",
  "position": "{{strategy.market_position}}",
  "symbol": "{{syminfo.basecurrency}}",
  "price": {{close}},
  "comment": "{{strategy.order.comment}}"
}
```

`position` is the strategy's position *after* the order (`long`, `short` or `flat`), so exits and reversals are unambiguous: `flat` closes, and `short` while long closes the long and opens a short.

For plain (non-strategy) alerts send `"action"` instead: `buy`/`long`, `sell`/`short`, `close`. Because TradingView uses "sell" for both "exit long" and "go short", an opposite-side `action` only **closes** the open position; it does not reverse.

Optional fields: `leverage` (whole number) and `size_usd` override the defaults from Settings; `stop_loss_pct` and `take_profit_pct` (percent from entry, e.g. `1.5`) place a stop-loss and take-profit on the exchange right after the entry fills.

Rules the webhook enforces:

- Unknown actions are rejected (they are never guessed).
- A signal that would take the position past **Max Position Size** is rejected.
- A close settles every open trade record for the symbol.
- Orders that do not fill are reported as errors, never recorded as fills.
- The secret is never written to logs or trade records.

### 8. Deploy to Vercel

```bash
npx vercel
```

Add all environment variables from `.env.local` to your Vercel project settings.

---

## Autopilot

The autopilot looks at each market you list, on completed hourly candles, and trades when a strategy's rule fires and the risk limits allow it.

**Strategies and the live gate.** The rules live in `lib/autopilot/strategies.ts`; the same code is backtested by `npm run backtest:autopilot`, which writes [`backtest/AUTOPILOT.md`](backtest/AUTOPILOT.md) and `lib/autopilot/evidence.json`. A strategy may trade real money only if that evidence shows it profitable in both 2020–2022 and 2023+, with an average trade that clears costs by more than 15 basis points. Today one of six variants passes (trend breakout, long only). The two short-horizon, scalp-style rules lost money after fees and are locked to paper mode. The gate is code, not a setting.

**Scalping search.** `npm run backtest:scalp` tests 517 short-term configurations in five families on 15-minute data, selecting on 2020–2024 and checking once on 2025 onward. None passed, with or without fees; see [`backtest/SCALPING.md`](backtest/SCALPING.md). No scalping strategy has been added to the autopilot for that reason. The search is there to test new ideas the same way.

**Other studies.** [`backtest/UNIVERSE.md`](backtest/UNIVERSE.md) tests the eligible strategy on 22 coins and 16 cross-coin ranking rules. [`backtest/POPULAR.md`](backtest/POPULAR.md) tests eight strategies taken from TradingView's public community scripts plus the common indicator strategies (26 variants). The pattern across all of them: long-only trend rules made money through 2024 and nothing in 2025–2026, when the market fell.

**MACD trend, 4-hour (paper only, on probation).** Buys when MACD crosses up above the 200-period average on 4-hour bars, shorts the opposite cross below it, exits when MACD crosses back. Its backtest passes the live gate, but it was chosen after its recent results were known, so that backtest is not an independent test. It stays on paper until it has a track record.

**Cross-coin momentum (paper only).** Once a week it ranks 19 large coins by 90-day return and holds the strongest quarter long and the weakest quarter short in equal size. It was the one ranking rule that held up on unseen data, which may be luck, so it cannot trade real money. Select it on the Autopilot page to start a paper record.

**Long and short.** "Allow shorts" is on by default. On paper every selected strategy may short. With real money a strategy shorts only if its long-and-short version passed the gate; otherwise it trades long-only.

**Risk rules** (all adjustable on the Autopilot page):
- Position size is set so a stopped-out trade loses a fixed share of equity (default 0.5%), capped at a leverage limit per position.
- Every live position gets a stop-loss on the exchange. If the stop cannot be placed, the position is closed immediately.
- A cap on simultaneous positions, a daily loss limit that blocks new entries until the next UTC day, and a drawdown limit that pauses the autopilot until you reset it.
- It never touches a position it did not open, and it skips the market the built-in daily strategy is trading.

**Paper mode** (the default) runs the identical logic on live prices and records what it would have done, with fees charged, starting from $10,000. It needs no wallet.

**To run it:**
1. Run `supabase/migrations/004_autopilot.sql`.
2. Set `CRON_SECRET` in Vercel.
3. Schedule the scan. Vercel's free plan only allows daily cron jobs, so use Supabase: the last section of `004_autopilot.sql` has a ready-made `pg_cron` statement that calls `/api/cron/autopilot` every five minutes. (On Vercel Pro you can add it to `vercel.json` instead.)
4. Open **Autopilot**, choose markets and strategies, and switch it on. Leave it on Paper until its record matches the backtest.

"Scan now" on the page runs one pass immediately, in whichever mode is selected.

---

## Scheduled jobs and database migrations

Run the files in `supabase/migrations/` in order from 001 through 009 before deploying. Trading writes require the coordination functions in 008. The US Stocks connection and weekday scans use 009.

| Job | Endpoint | Scheduler | What it does |
|---|---|---|---|
| Trading scan | `/api/cron/autopilot` | Supabase `pg_cron`, every 5 minutes (see 004) | Autopilot, limit-order follow-up, moving managed stops, reconciling the trade log with the exchange, daily summary |
| Market scan | `/api/cron/market` | Supabase `pg_cron`, every 5 minutes (see 006) | Trade ideas for every liquid market, alerts on changes, scoring earlier ideas |
| Fast scan | `/api/cron/fast` | Supabase `pg_cron`, every 10 seconds, only while a trade, exit plan or resting entry is open (see 007) | Moves trailing and break-even stops, follows limit and chase entries, settles a trade the moment its position closes |
| Daily strategy | `/api/cron/strategy` | Supabase `pg_cron`, daily (see 007) | The BTC trend strategy; also checks that the scans and the database are alive |

No Vercel cron jobs are used, so the free plan is enough. All four require `Authorization: Bearer $CRON_SECRET`. Each scan records a heartbeat and alerts if the other has not
succeeded for 20 minutes.

## Checking changes

```bash
npm test && npx eslint . && npx tsc --noEmit && npx next build
```

To look at the UI without production credentials, use the mock backend in `scripts/dev-mock/` (see its README):
`npm run mock:supabase`, start `next dev` with `scripts/dev-mock/env.example`, then `npm run mock:shots`.

Before trading real money, run `npm run testnet:check` with a funded Hyperliquid **testnet** key. It places one small
position and walks it through every order type the app sends. No real order had been placed by this app when that
script was written.

## Research tools

- **Markets** (`/markets`) reads Hyperliquid's public market data. No setup needed.
- **Strategy Lab** (`/lab`) runs backtests on the price and funding history cached in `backtest/data/` (refresh with `npm run backtest:fetch`, then redeploy). What the studies found, including what did *not* work, is in [`backtest/RESULTS.md`](backtest/RESULTS.md).
- **Telegram alerts:** set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (see `.env.example`).
- **Scalping vs swing study:** [`backtest/INTRADAY.md`](backtest/INTRADAY.md) (`npm run backtest:intraday`). Short version: every textbook scalping rule lost money after fees; slow trend rules did not.

Research results are not live features: the spot-first and funding-capture ideas are backtested only. The live runner trades the BTC perp.

---

## Built-in BTC strategy (optional)

A daily trend-following strategy that runs by itself on a Vercel Cron job — no TradingView required.

- **Rule:** long BTC in proportion to how many of its 50/100/150/200-day moving averages it is above, sized to a volatility target (default 40% annualised), capped at a max leverage (default 2x), flat when below all four.
- **Backtest:** [`backtest/RESULTS.md`](backtest/RESULTS.md), 2014 → today, with fees, slippage, real Hyperliquid funding and intraday liquidation checks. Read it before enabling anything. It has losing years and a ~40% historical drawdown at the defaults. **It is not a guarantee of profit; nothing is.**
- **Same code live and in backtest:** both call `lib/strategy/trend.ts`.

To enable:

1. Run migration `002_strategy_and_hardening.sql`.
2. Set a `CRON_SECRET` env var in Vercel (any long random string). Vercel Cron sends it automatically; the endpoint refuses to run without it.
3. Deploy. `vercel.json` schedules `/api/cron/strategy` at 00:10 UTC daily.
4. In **Settings → Built-in BTC Trend Strategy**, turn it on. It starts in **dry run**: each day it logs what it would do without sending orders. Use **Preview today's decision** to check it any time.
5. Run it in dry run, then on testnet, before turning dry run off on mainnet.

Things to know:

- It sizes against the **whole account value** unless you set a Capital cap. Use a dedicated account or sub-account.
- While it is enabled, webhook signals for BTC are rejected so the two cannot fight over one position.
- If the cron does not run (outage, paused project), the position simply stays as it was. There is no exchange-side stop-loss.

Reproduce or extend the backtest:

```bash
npm run backtest:fetch   # refresh price + funding data
npm run backtest         # regenerate backtest/RESULTS.md
npm test                 # unit tests (signal, engine, order logic)
```

---

## Security

- All routes are protected behind Supabase Auth
- Private key is encrypted with AES-256-GCM before storage
- Webhook requests are authenticated by secret key
- Row Level Security enforces data isolation between users
- Use a Hyperliquid **API wallet** key, never your main wallet key
- `HL_PRIVATE_KEY` / `HL_WALLET_ADDRESS` env vars override stored credentials for **every** user — only use them on a single-user deployment
- The cron endpoint requires `CRON_SECRET`

## Disclaimer

This software is for educational and personal use only. Trading cryptocurrencies involves substantial risk of loss, and leverage multiplies it: in the backtest a BTC position held at a constant 3x or more was liquidated in every period tested. No strategy here is guaranteed to make money. Use testnet before trading with real funds, and never trade money you cannot afford to lose.

## Trading safety update

Apply `supabase/migrations/008_trading_safety.sql` before deploying this version. The migration adds account execution leases, a shared signer nonce counter, durable exchange action records, a webhook queue, recovery state and per-user alerts. It extends the existing `hl-fast` schedule to wake for queued signals and account recovery. Verify that `hl-autopilot` exists before applying the scheduling block.

TradingView payloads now require `signal_id`. Use a unique value for each original alert and preserve it when retrying delivery. The example above combines TradingView's order ID and alert time. Plain alerts also need a unique ID. A successful webhook response is HTTP 202 after durable queue acceptance. Execution follows on the next fast scan, typically within ten seconds. Signals expire after three minutes in the queue. Duplicate delivery does not execute a second trade.

The kill switch disables all automation, cancels entry orders, closes positions and verifies the account is flat. A failed recovery remains scheduled for another attempt. New exposure stays halted until **Settings → Account limits → Resume trading after account check** succeeds. That check requires a flat account with no resting entries. Enable the automation you want afterward.

Set alert destinations in the Account limits card. Topics, Telegram chat IDs and email recipients belong to each user. Deployment-level Telegram and email service credentials provide delivery. Existing global alert destinations receive operational messages. Account alerts use their saved user destinations.

Daily entry limits use exchange equity history around UTC midnight, current account value and ledger cash movements. The baseline can precede midnight by up to one hour because the exchange samples its portfolio history. Missing or incomplete history blocks new exposure. Deposits and withdrawals are excluded from the loss calculation.

Autopilot evidence has been regenerated using fixed coin quantities and reconciled trade and equity accounting. Newly qualifying short variants remain on paper pending forward validation. Paper risk includes open-position P&L, estimated closing costs and accrued exchange funding. The current historical study continues to show weak recent results for the live long-only strategy.
