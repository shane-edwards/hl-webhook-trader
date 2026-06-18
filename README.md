# HL Webhook Trader

A professional Next.js trading application that receives TradingView webhook alerts and executes perpetual futures orders on Hyperliquid on your behalf.

## Features

- **TradingView Integration** — Receive webhook signals and execute perp orders automatically
- **Hyperliquid Trading** — Market long/short/close with configurable leverage and size
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

- **Next.js 14** (App Router)
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
2. Go to **SQL Editor** and run the migration: `supabase/migrations/001_initial.sql`
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
2. Enter your Hyperliquid wallet address and private key (start on **Testnet**)
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
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": {{close}},
  "comment": "{{strategy.order.comment}}"
}
```

Action values: `buy`, `sell`, `long`, `short`, `close`

### 8. Deploy to Vercel

```bash
npx vercel
```

Add all environment variables from `.env.local` to your Vercel project settings.

---

## Security

- All routes are protected behind Supabase Auth
- Private key is encrypted with AES-256-GCM before storage
- Webhook requests are authenticated by secret key
- Row Level Security enforces data isolation between users
- Use `HL_PRIVATE_KEY` env var instead of DB storage for maximum security

## Disclaimer

This software is for educational and personal use only. Trading cryptocurrencies involves substantial risk of loss. Use testnet before trading with real funds.
