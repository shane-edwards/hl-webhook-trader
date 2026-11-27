# Flow signals study: ETF flows and Hyperliquid liquidations

Script: `backtest/flow-signals-study.py`. Numbers: `backtest/flow-signals-results.json`. Run with `python -B backtest/flow-signals-study.py` from the repo root. It reads cached files only and is deterministic.

## Verdict

All five variants fail the pass rule that was fixed before any result was seen. Nothing here passed and nothing was "too few to judge".

| Variant | Verdict | Why |
|---|---|---|
| `etf_flow_trend` | Fail | Positive in both windows and ahead of exposure-matched buy and hold in both, but the holdout trade t-statistic is 0.12 against a required 2. At the conservative D+2 timing the holdout is negative. |
| `etf_flow_shock_follow` | Fail | Negative in discovery. Holdout t-statistic 1.45. The holdout gain disappears completely at D+2 timing. |
| `etf_flow_shock_fade` | Fail | Negative in both windows at both timings. |
| `liq_long_flush_rebound` | Fail | Negative in both windows at stressed cost. Holdout t-statistic -1.38. |
| `liq_short_squeeze_fade` | Fail | Negative in both windows. Holdout t-statistic -0.39. |

## What the two caches contain

### `data/intraday/crypto-flow/btc-etf-flows.json`

- One JSON object with descriptive metadata and a `days` list of 735 rows.
- Frequency: one row per US trading day (Monday to Friday only). First row 2024-01-11, last row 2026-11-20.
- Fields per row: `date`, `netFlowUsd` (total net flow, US dollars), `vendorNetFlowUsd` (the vendor's own aggregate, US dollars), `totalNetAssetsUsd` (US dollars, null in older rows), `btcCloseUsd` (a BTC reference price marked around 21:00 UTC), `perEtfUsd` (net flow per fund, US dollars).
- The study uses `netFlowUsd` only.
- 16 rows have a flow of exactly zero. All fall on US market holidays up to 2025-06-19. Later holidays are simply absent. No null flows, no duplicate dates.
- Prices end 2026-10-31, so the 15 flow rows after that date are not used. 720 rows are used.

### `data/intraday/hyperliquid-liquidations/`

- 18 monthly hourly files, `2025-05.json` to `2026-10.json`, and 18 matching `-15m` files.
- Each file has three keys only: `BTC`, `ETH`, `SOL`. So the data is per coin, for exactly the three coins tested.
- Hourly rows have 9 unlabelled numbers: timestamp in milliseconds UTC, open, high, low, close, volume, an hourly funding rate, and two liquidation columns. The 15 minute rows have 3 numbers: timestamp and the same two liquidation columns, listed only for intervals where something was liquidated.
- Coverage: 2025-05-25 14:00 UTC to 2026-10-31 23:00 UTC, 12,586 hourly rows per coin with no missing hours. The first day is partial and is dropped, leaving 524 full days per coin.
- The two liquidation columns sum to the same daily totals in the hourly and 15 minute files (difference below one cent), so the hourly files are used.
- Units look like US dollar notional. Totals over the period: BTC 15.6 billion and 9.5 billion, ETH 9.4 billion and 4.0 billion, SOL 3.1 billion and 0.8 billion for the first and second column.
- **The cache has no header saying which column is long liquidations and which is short.** The sides were identified from the data: 90% (BTC), 78% (ETH) and 93% (SOL) of the first column's notional falls in hours when price fell, and 88%, 93% and 90% of the second column's notional falls in hours when price rose. The first column is therefore treated as long liquidations and the second as short liquidations. This check uses only the price move in the same hour, not any later return. It is an inference, not a documented fact.

### Prices and funding

Binance USD-M perpetual daily bars and funding for BTCUSDT, ETHUSDT, SOLUSDT from `data/intraday/crypto-swing/`. 2021-01-01 to 2026-10-31. No missing days in the periods used (SOL has 5 missing days in 2022, outside the study).

## Fixed rules

- Costs: 0.10% per side (base) and 0.20% per side (stressed), charged on every position change. A flip pays two sides.
- Funding: the recorded Binance funding rate is charged for every day held. Longs pay when the rate is positive, shorts receive.
- 1x notional, no stops. Returns are open to open on UTC days and compounded daily.
- A trade is one unbroken run of days in the same direction. Runs are cut at window edges.
- Sharpe uses all daily returns in the window, including flat days, annualised with 365 days.
- t-statistic is the mean trade return divided by its standard error.

### ETF variants (BTC perp)

- Timing: flows for US trading day D are published after the US close. The main run trades at the 00:00 UTC open of D+1. That is 8pm New York time on day D, usually before the figures are out, so it is optimistic. The conservative run trades at the open of D+2.
- `etf_flow_trend`: long when the sum of the last 5 published daily flows is positive, flat otherwise.
- `etf_flow_shock_follow`: a flow above the 90th percentile of the previous 120 flow days starts a 5 calendar day long. Below the 10th percentile starts a 5 calendar day short. A repeat signal restarts the 5 days. An opposite signal flips.
- `etf_flow_shock_fade`: the opposite positions.
- Windows: the tradable span 2024-01-12 to 2026-10-31 split in half by calendar days. Discovery is 2024-01-12 to 2025-06-06. Holdout is 2025-06-07 to 2026-10-31. The shock variants need 120 flow days of history, so their discovery window really starts 2024-06-28.
- Signal counts for the shock rule over the full history: 70 above the 90th percentile, 68 below the 10th.

### Liquidation variants (BTC, ETH, SOL perps, equal capital, each coin on its own signal)

- A UTC day's total is known at that day's close and trades at the next open.
- `liq_long_flush_rebound`: long liquidation notional above the 95th percentile of the previous 60 days starts a 3 day long.
- `liq_short_squeeze_fade`: short liquidation notional above the 95th percentile of the previous 60 days starts a 3 day short.
- Windows: discovery 2025-05 to 2025-12, holdout 2026-01 to 2026-10. Because data starts 2025-05-25 and 60 full days are needed, the first possible trade day is 2025-07-26. Discovery is therefore only about five months. This history is short.

### Pass rule

A variant passes only if, at stressed cost, it is positive in both windows, has at least 20 holdout trades (for `etf_flow_trend`: beats exposure-matched buy and hold in both windows), and has a holdout trade t-statistic of at least 2. Fewer than 20 holdout trades means "too few to judge". The verdict uses the D+1 run. The D+2 run is reported next to it.

## Results

Columns: trades, exposure (share of days in the market), total return, annualised return, Sharpe, max drawdown, mean return per trade in basis points, trade t-statistic, then buy and hold BTC perp over the same window as total return (Sharpe, max drawdown).

### `etf_flow_trend`

Days in market (D+1): 348 of 506 in discovery, 277 of 512 in holdout. The last column is the exposure-matched fraction of buy and hold.

| Timing | Window | Cost | Dates | Trades | Exp | Total | Ann | Sharpe | Max DD | Mean bps | t | Buy and hold | Exp-matched B&H |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D+1 | discovery | base | 2024-01-18 to 2025-06-06 | 18 | 0.69 | 132.9% | 84.0% | 1.69 | -19.6% | 572 | 1.59 | 113.2% (1.32, -29.4%) | 75.0% |
| D+1 | discovery | stressed | 2024-01-18 to 2025-06-06 | 18 | 0.69 | 124.7% | 79.3% | 1.63 | -20.0% | 551 | 1.53 | 112.7% (1.31, -29.4%) | 74.7% |
| D+1 | holdout | base | 2025-06-07 to 2026-10-31 | 23 | 0.54 | 5.0% | 3.5% | 0.26 | -30.9% | 34 | 0.30 | -29.9% (-0.41, -53.7%) | -15.0% |
| D+1 | holdout | stressed | 2025-06-07 to 2026-10-31 | 23 | 0.54 | 0.2% | 0.2% | 0.14 | -32.4% | 14 | 0.12 | -30.1% (-0.42, -53.7%) | -15.1% |
| D+2 | discovery | base | 2024-01-19 to 2025-06-06 | 18 | 0.69 | 103.6% | 67.2% | 1.46 | -31.7% | 490 | 1.40 | 120.8% (1.37, -29.4%) | 79.4% |
| D+2 | discovery | stressed | 2024-01-19 to 2025-06-06 | 18 | 0.69 | 96.3% | 62.8% | 1.39 | -32.6% | 469 | 1.34 | 120.3% (1.37, -29.4%) | 79.1% |
| D+2 | holdout | base | 2025-06-07 to 2026-10-31 | 23 | 0.54 | -8.9% | -6.4% | -0.10 | -33.7% | -28 | -0.25 | -29.9% (-0.41, -53.7%) | -15.0% |
| D+2 | holdout | stressed | 2025-06-07 to 2026-10-31 | 23 | 0.54 | -13.0% | -9.4% | -0.22 | -35.2% | -48 | -0.43 | -30.1% (-0.42, -53.7%) | -15.1% |

It beat exposure-matched buy and hold in both windows at both timings, and lost less than BTC in a falling holdout. But the holdout trade t-statistic is 0.12 (D+1) and -0.43 (D+2), far from 2, and at D+2 the holdout return is negative. Fail.

### `etf_flow_shock_follow`

Days in market (D+1): discovery 181 of 344 (91 long, 90 short), holdout 228 of 512 (101 long, 127 short).

| Timing | Window | Cost | Dates | Trades | Exp | Total | Ann | Sharpe | Max DD | Mean bps | t | Buy and hold |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D+1 | discovery | base | 2024-06-28 to 2025-06-06 | 25 | 0.53 | -3.8% | -4.0% | 0.09 | -32.5% | -2 | -0.02 | 58.7% (1.22, -29.3%) |
| D+1 | discovery | stressed | 2024-06-28 to 2025-06-06 | 25 | 0.53 | -8.5% | -9.0% | -0.05 | -34.9% | -22 | -0.21 | 58.3% (1.22, -29.3%) |
| D+1 | holdout | base | 2025-06-07 to 2026-10-31 | 34 | 0.45 | 68.9% | 45.3% | 1.36 | -15.5% | 173 | 1.64 | -29.9% (-0.41, -53.7%) |
| D+1 | holdout | stressed | 2025-06-07 to 2026-10-31 | 34 | 0.45 | 57.8% | 38.5% | 1.21 | -16.9% | 152 | 1.45 | -30.1% (-0.42, -53.7%) |
| D+2 | discovery | base | 2024-06-29 to 2025-06-06 | 25 | 0.53 | -1.4% | -1.5% | 0.16 | -31.6% | 11 | 0.09 | 62.0% (1.27, -29.3%) |
| D+2 | discovery | stressed | 2024-06-29 to 2025-06-06 | 25 | 0.53 | -6.2% | -6.6% | 0.03 | -34.1% | -9 | -0.07 | 61.7% (1.27, -29.3%) |
| D+2 | holdout | base | 2025-06-07 to 2026-10-31 | 33 | 0.44 | -7.5% | -5.4% | -0.02 | -38.9% | 1 | 0.01 | -29.9% (-0.41, -53.7%) |
| D+2 | holdout | stressed | 2025-06-07 to 2026-10-31 | 33 | 0.44 | -13.5% | -9.8% | -0.17 | -40.4% | -19 | -0.15 | -30.1% (-0.42, -53.7%) |

The D+1 holdout looks strong (57.8% at stressed cost) but discovery was negative, the t-statistic is 1.45, and the whole gain turns into a loss when the trade is delayed one day. That means the result depends on trading at 00:00 UTC on figures that are usually not yet published at that time. Fail.

### `etf_flow_shock_fade`

Days in market (D+1): discovery 181 of 344 (90 long, 91 short), holdout 228 of 512 (127 long, 101 short).

| Timing | Window | Cost | Dates | Trades | Exp | Total | Ann | Sharpe | Max DD | Mean bps | t | Buy and hold |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D+1 | discovery | base | 2024-06-28 to 2025-06-06 | 25 | 0.53 | -18.4% | -19.4% | -0.36 | -27.0% | -66 | -0.62 | 58.7% (1.22, -29.3%) |
| D+1 | discovery | stressed | 2024-06-28 to 2025-06-06 | 25 | 0.53 | -22.4% | -23.5% | -0.50 | -28.5% | -86 | -0.80 | 58.3% (1.22, -29.3%) |
| D+1 | holdout | base | 2025-06-07 to 2026-10-31 | 34 | 0.45 | -54.9% | -43.3% | -1.68 | -61.1% | -214 | -2.16 | -29.9% (-0.41, -53.7%) |
| D+1 | holdout | stressed | 2025-06-07 to 2026-10-31 | 34 | 0.45 | -57.8% | -46.0% | -1.83 | -62.4% | -234 | -2.36 | -30.1% (-0.42, -53.7%) |
| D+2 | discovery | base | 2024-06-29 to 2025-06-06 | 25 | 0.53 | -21.0% | -22.2% | -0.43 | -28.5% | -76 | -0.64 | 62.0% (1.27, -29.3%) |
| D+2 | discovery | stressed | 2024-06-29 to 2025-06-06 | 25 | 0.53 | -24.9% | -26.3% | -0.56 | -29.5% | -96 | -0.81 | 61.7% (1.27, -29.3%) |
| D+2 | holdout | base | 2025-06-07 to 2026-10-31 | 33 | 0.44 | -17.2% | -12.6% | -0.28 | -42.0% | -33 | -0.27 | -29.9% (-0.41, -53.7%) |
| D+2 | holdout | stressed | 2025-06-07 to 2026-10-31 | 33 | 0.44 | -22.5% | -16.6% | -0.44 | -42.8% | -53 | -0.43 | -30.1% (-0.42, -53.7%) |

Negative everywhere. Fail. Note that both follow and fade lose in discovery and at D+2, because costs and funding are paid on both sides of a signal with no edge.

### `liq_long_flush_rebound`

The benchmark is an equal-weight long of the three perps over the same dates. Signal days over the full history: BTC 44, ETH 30, SOL 31.

| Window | Cost | Dates | Trades | Exp | Total | Ann | Sharpe | Max DD | Mean bps | t | Buy and hold |
|---|---|---|---|---|---|---|---|---|---|---|---|
| discovery | base | 2025-07-26 to 2025-12-31 | 24 | 0.18 | 0.7% | 1.7% | 0.20 | -8.2% | 19 | 0.14 | -26.7% (-0.93, -40.0%) |
| discovery | stressed | 2025-07-26 to 2025-12-31 | 24 | 0.18 | -0.9% | -2.0% | 0.07 | -8.4% | -1 | -0.01 | -26.9% (-0.94, -40.0%) |
| holdout | base | 2026-01-01 to 2026-10-31 | 39 | 0.18 | -17.1% | -20.2% | -0.80 | -25.9% | -128 | -1.19 | -20.1% (-0.24, -49.5%) |
| holdout | stressed | 2026-01-01 to 2026-10-31 | 39 | 0.18 | -19.2% | -22.6% | -0.93 | -26.7% | -148 | -1.38 | -20.2% (-0.24, -49.5%) |

Holdout per coin at stressed cost (trades, total return on that coin's capital, mean bps per trade): BTC 15, -15.9%, -99. ETH 14, -13.7%, -79. SOL 10, -29.4%, -317. All three coins lost. Buying after a long flush lost almost as much as holding the coins while being in the market only 18% of the time. Fail.

### `liq_short_squeeze_fade`

Signal days over the full history: BTC 25, ETH 22, SOL 23.

| Window | Cost | Dates | Trades | Exp | Total | Ann | Sharpe | Max DD | Mean bps | t | Buy and hold (long) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| discovery | base | 2025-07-26 to 2025-12-31 | 12 | 0.09 | -4.2% | -9.3% | -0.67 | -11.7% | -92 | -0.41 | -26.7% (-0.93, -40.0%) |
| discovery | stressed | 2025-07-26 to 2025-12-31 | 12 | 0.09 | -4.9% | -10.9% | -0.81 | -11.8% | -111 | -0.50 | -26.9% (-0.94, -40.0%) |
| holdout | base | 2026-01-01 to 2026-10-31 | 36 | 0.15 | -3.3% | -4.0% | -0.19 | -19.3% | -17 | -0.18 | -20.1% (-0.24, -49.5%) |
| holdout | stressed | 2026-01-01 to 2026-10-31 | 36 | 0.15 | -5.6% | -6.7% | -0.38 | -20.0% | -37 | -0.39 | -20.2% (-0.24, -49.5%) |

Holdout per coin at stressed cost: BTC 12, -6.0%, -28. ETH 13, 0.9%, 16. SOL 11, -13.1%, -110. A short strategy lost money in a period when the coins themselves fell about 20%. Fail.

## Not testable

No variant was untestable. Both caches held what the variants needed. The one gap is that the liquidation side labels had to be inferred, as described above.

## Limits

- The liquidation history is about 17 months, and after the 60 day warm-up the discovery window is five months with 24 and 12 trades. That is thin for discovery and holdout alike.
- Liquidation sides are inferred from same-hour price direction because the cache has no column labels. The split is clear for all three coins, but if the labels were reversed the two variants would be testing the opposite ideas.
- Liquidations are from Hyperliquid only. Trades are priced on Binance perps with Binance funding. Hyperliquid is one venue and its liquidations are not the whole market.
- ETF flow figures are as published in the cache today. Any later revisions are already in the numbers. A real trader saw first prints, which can differ.
- The D+1 run enters at 00:00 UTC, which is before flows are normally published. Treat D+1 as an upper bound and D+2 as the realistic case. The two runs disagree sharply for `etf_flow_shock_follow` in the holdout (57.8% against -13.5% at stressed cost), so that result rests on a single calendar day per signal that could not have been traded on this information.
- Holiday rows with zero flow (16, all before July 2025) are kept as published. They count as flow days in the 5 day and 120 day windows.
- The 5 day hold in the shock variants is 5 calendar days, because the perp trades every day. The specification did not say calendar or trading days. This was chosen before running.
- Trades are few (18 to 39 per window) and overlap in time, so the t-statistics are rough.
- BTC rose strongly in the ETF discovery window and fell in the holdout. `etf_flow_trend` is long only, so much of its discovery return is market direction. That is why the exposure-matched benchmark is shown.
- Five variants were tested once each. The script was run without changes to rules after seeing results. No bugs were found and no rerun with altered logic took place.
