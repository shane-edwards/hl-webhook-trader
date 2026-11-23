# TradingView-inspired scalp research

Open **Strategy Lab → Scalping research** for the study and a replay of recent Hyperliquid candles. The screen compares five original rules inspired by public TradingView descriptions. The source links are in `lib/scalp-study.ts`. The rules adapt those concepts to 24-hour crypto perps and use independent entry and exit logic.

## Reproduce the study

```sh
python backtest/scalp-data.py
npm run backtest:scalp-study
```

The Python 3 downloader caches Binance USDⓈ-M 5-minute monthly archives for BTC, ETH and SOL from January 2024 through October 2026. The study aggregates those bars for the 15-minute tests, then requests up to 4,999 closed candles per market and interval from Hyperliquid. The native comparison starts no earlier than the end of the last Binance period and uses the common coverage available across the three markets. The committed JSON contains the date ranges and results. Hyperliquid's rolling retention means rerunning later produces a different native sample.

The study tests ten combinations (five rules, two intervals) with no parameter search. Start each evaluation period flat and use earlier candles only as indicator warm-up. Signals require 1.5× the previous two hours' average volume. Enter at the next open. Use a 14-bar average true range, a 1.5 ATR stop, a 2.25 ATR target and a 60-minute time exit. On ambiguous candles, give priority to the stop. Gaps through stops exit at the worse open. A missing candle cancels an unfilled entry, forces an open trade out at the next available open, and restarts warm-up. The results are unleveraged per-trade averages, without a shared portfolio sizing model.

The model charges 4.5 basis points taker fees and 2 bps slippage per side, 3 bps extra on stops, and 1 bp per crossed hourly funding boundary. The higher-cost column adds 3 bps per side. Funding and execution costs are estimates. OHLC data cannot measure order-book depth, queue position, trade ordering inside a candle, or signal-to-fill delays.

## Evaluate a new idea

1. Record the TradingView URL, market hypothesis and complete entry, exit, sizing and cost rules before looking at the results. Use only closed bars and information that would have been known at decision time.
2. Add the rule to `SCALP_RULES` and its entry conditions to `replayScalp`. To compare against a genuinely unseen period after revising a rule, reserve fresh data before making those revisions. Repeated changes based on a holdout turn that holdout into development data.
3. Compare the historical screen, validation and holdout, and the recent Hyperliquid sample. The screen requires at least 100 trades in each historical period and 30 on Hyperliquid, at least +3 bps per trade in all four periods, positive results under higher costs, profits on at least two markets, and a majority of active days profitable. These are research thresholds, not statistical proof.
4. Forward paper test any passing rule with measured spread, visible depth and signal-to-fill delays. Compare each proposed entry with the next realistically executable price and review the resulting drawdown and net returns. All variants in the initial study failed the screen.
