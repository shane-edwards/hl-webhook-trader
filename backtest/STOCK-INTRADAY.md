# US stock intraday research

Go to **US Stocks → Simulate → Intraday research** for the evidence and a recent replay. The report tests five fixed, long-only adaptations of ideas from published studies and public TradingView scripts. Source links appear alongside the rules in the app. The opening breakout with relative volume uses 1.5× the prior 20 sessions' opening-bar volume, but keeps this study's shorter exits and limited fixed universe. The late-session SPY variant tests a simple sign rule. The SPY volatility band variant uses half-hour checks against a 14-session gap-adjusted band and VWAP, with fixed capital. The reported numbers describe these implementations on eToro, rather than a replication of the papers' portfolios.

## Reproduce

Run the following against an eToro key pair with Read access. Set credentials outside the repository as environment variables. The downloader uses `/api/v1/data/instruments/{instrumentId}/candles` with bid and ask sides and stable pagination windows. It caches historical prices under `backtest/data/intraday/stock-replay/`.

```sh
npm run backtest:stocks:download
npm run backtest:stocks:intraday
```

The study uses AAPL, MSFT, NVDA, AMZN, TSLA and SPY, from May 2025 through November 20, 2026. Both SPY-specific strategies run only on SPY. The primary intervals are the 2025 screen, first-half 2026 validation, and second-half 2026 holdout. Parameters are fixed before the replay. Each stock contributes its own trades; concurrent positions are not modeled as a portfolio.

The replay requires all 78 paired five-minute candles from 9:30 a.m. until 4 p.m. New York time. Published early closes in the covered period are excluded. Incomplete sessions are counted and excluded rather than interpolated. Data missing for an entire session is not counted as a partially observed session. A relative-volume signal requires 20 prior complete sessions. The VWAP approximation weights each completed candle's typical bid price using the volume eToro supplies.

Entries use the next candle's ask open. Stops use the bid and take priority over targets when both are touched. Stops below the opening bid gap use the worse opening bid. The time exit uses the bid at the 60-minute deadline, and SPY's closing rule uses the final bar's bid close. Each trade uses $10,000 nominal capital, quote spread, 2 bps extra slippage and $1 commission per fill. The stress case uses 5 bps and $2 per fill. Actual account fees may differ. Bar data does not measure execution latency or protective-order queueing, and the study does not model short availability or liquidity for larger orders.

A paper candidate needs at least +3 bps per trade at base costs and positive net returns at higher costs in all three periods. Each period needs at least 25 active days, 80 trades and positive returns on three symbols for a multi-stock strategy, or 25 trades on SPY for the SPY rule. It also needs a t-statistic of at least 1.65 on total P&L aggregated by active session day. These are screening thresholds. They do not account for all sources of dependence or provide a guarantee of profitability. Day-by-day paper observations and measured fills are separate from this replay.
