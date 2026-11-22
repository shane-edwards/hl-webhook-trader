# HL Webhook Trader

A professional Next.js trading application that receives TradingView webhook alerts and executes perpetual futures orders on Hyperliquid on your behalf.

## Features

- **TradingView Integration** — Receive webhook signals and execute perp orders automatically
- **Hyperliquid Trading** — Market long/short/close with configurable leverage and size
- **Built-in BTC strategy** — Optional daily volatility-targeted trend strategy that runs on a cron with no TradingView needed ([backtest](backtest/RESULTS.md))
- **Live Dashboard** — Portfolio overview, equity curve, active positions, recent trades
- **Trade Management** — Manually cancel/close any active position from the UI
- **Performance Analytics** — Sharpe ratio, Sortino ratio, max drawdown, Calmar ratio, win rate, profit factor, expectancy, Kelly %, VaR, and more
- **Monthly P&L Charts** — Visualize performance over time
- **Drawdown Chart** — Track portfolio risk visually
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
2. Go to **SQL Editor** and run the migrations in order: `supabase/migrations/001_initial.sql`, then `002_strategy_and_hardening.sql`
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
2. Create an **API wallet** on Hyperliquid (More → API). Enter its private key, and your main account address as the Account Address (start on **Testnet**). An API wallet can trade but cannot withdraw, so a leaked key cannot drain the account.
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
  "position": "{{strategy.market_position}}",
  "symbol": "{{syminfo.basecurrency}}",
  "price": {{close}},
  "comment": "{{strategy.order.comment}}"
}
```

`position` is the strategy's position *after* the order (`long`, `short` or `flat`), so exits and reversals are unambiguous: `flat` closes, and `short` while long closes the long and opens a short.

For plain (non-strategy) alerts send `"action"` instead: `buy`/`long`, `sell`/`short`, `close`. Because TradingView uses "sell" for both "exit long" and "go short", an opposite-side `action` only **closes** the open position; it does not reverse.

Optional fields: `leverage` (whole number) and `size_usd` override the defaults from Settings.

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
