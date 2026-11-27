# Funding basket study (cross-sectional funding carry)

Script: `python -B backtest/funding-basket-study.py` (reads the local cache only, never downloads, deterministic).
Numbers: `backtest/funding-basket-results.json`. Every figure below is copied from that file.

## What was tested

Each week, rank 16 Binance USD-M perpetuals by how much funding they have recently paid. Go short the
coins paying the most and long the coins paying the least, in equal dollar amounts, and collect the
funding difference. Earlier studies in this folder only tested single-coin spot/perp hedges, so this
idea was new here.

The four variants, the thresholds, the coins, the windows and the pass rule were all fixed before any
result was seen. Nothing was added, dropped or tuned afterwards. One rerun was made after the first
run, only to remove a pandas deprecation warning in the funding loader. The output file was
byte-identical before and after (same md5).

## Fixed rules

- Coins: AAVE, ADA, ATOM, AVAX, BCH, BNB, BTC, DOGE, ETC, ETH, LINK, LTC, SOL, TRX, XLM, XRP. All 16 have
  price and funding data from January 2021, so all 16 are eligible on every rebalance in every window.
- Windows: discovery 2022-01-01 to 2023-12-31, validation 2024-01-01 to 2024-12-31, holdout 2025-01-01
  to 2026-10-31.
- Rebalance at Monday's daily open (UTC). The ranking uses the mean daily funding over the lookback
  ending on Sunday, using only funding prints stamped on or before Sunday 16:00 UTC (later for SOL's
  short-interval prints, but always before Monday 00:00). No look-ahead.
- Short the top quartile (4 coins), long the bottom quartile (4 coins), equal weight, 50% of capital per
  side. Hold one week. Positions drift with price during the week.
- Daily P&L per leg is the open to open price return times direction, plus funding. A short receives the
  day's funding, a long pays it. A day's funding is the prints after that day's open up to and including
  the next midnight print.
- Costs are charged on traded notional at each rebalance: 0.10% per side (base) and 0.20% per side
  (stressed). Each window starts flat and pays to enter, and pays to close everything on its last day.
- Variants:
  1. `carry_7d`: 7 day lookback.
  2. `carry_30d`: 30 day lookback.
  3. `carry_7d_btc_hedged_short_only`: short the top 4 coins by 7 day funding (BTC skipped if it is in the
     top 4), hedged with a 50% long BTC perp that pays BTC funding.
  4. `placebo_random`: same as variant 1 but the ranking is a random shuffle each week. 200 runs, seed 7.
     This is the null.
- Pass rule: stressed total return positive in all three windows, AND holdout stressed Sharpe at least
  0.5, AND holdout stressed total return above the placebo's 95th percentile.

## Results

Total and annualised return, Sharpe from daily returns (365 days, no risk-free rate), maximum drawdown,
number of weekly rebalances, and average weekly turnover (sum of absolute weight changes as a share of
equity, excluding the first entry). Price, Funding and Costs are the split of the total return, in
dollars per 1.00 of starting capital, and they add up to the total. Placebo rows are the mean of 200
runs.

| Variant | Window | Costs | Total | Ann. | Sharpe | Max DD | Rebals | Turnover | Price | Funding | Costs |
|---|---|---|---|---|---|---|---|---|---|---|---|
| carry_7d | discovery | base | +3.2% | +1.6% | +0.18 | -20.9% | 104 | 82% | -5.2% | +17.5% | -9.0% |
| carry_7d | discovery | stressed | -5.3% | -2.7% | -0.04 | -21.6% | 104 | 82% | -4.7% | +16.7% | -17.3% |
| carry_7d | validation | base | -8.1% | -8.0% | -0.31 | -27.4% | 53 | 89% | -9.6% | +6.7% | -5.1% |
| carry_7d | validation | stressed | -12.4% | -12.4% | -0.55 | -28.0% | 53 | 89% | -8.9% | +6.5% | -10.0% |
| carry_7d | holdout | base | +71.4% | +34.2% | +1.83 | -13.5% | 95 | 93% | +72.8% | +9.8% | -11.2% |
| carry_7d | holdout | stressed | +56.8% | +27.8% | +1.54 | -14.3% | 95 | 93% | +68.9% | +9.3% | -21.4% |
| carry_30d | discovery | base | +9.2% | +4.5% | +0.33 | -23.7% | 104 | 41% | -2.7% | +16.6% | -4.7% |
| carry_30d | discovery | stressed | +4.5% | +2.2% | +0.21 | -24.2% | 104 | 41% | -2.6% | +16.2% | -9.1% |
| carry_30d | validation | base | +4.6% | +4.6% | +0.30 | -18.4% | 53 | 44% | +0.5% | +6.8% | -2.7% |
| carry_30d | validation | stressed | +2.0% | +2.0% | +0.21 | -18.6% | 53 | 44% | +0.6% | +6.7% | -5.2% |
| carry_30d | holdout | base | +60.7% | +29.5% | +1.67 | -13.4% | 95 | 39% | +55.6% | +10.2% | -5.1% |
| carry_30d | holdout | stressed | +54.7% | +26.9% | +1.54 | -13.9% | 95 | 39% | +54.6% | +10.0% | -9.9% |
| carry_7d_btc_hedged_short_only | discovery | base | -7.6% | -3.9% | -0.07 | -32.4% | 104 | 48% | -3.4% | +1.1% | -5.3% |
| carry_7d_btc_hedged_short_only | discovery | stressed | -12.2% | -6.3% | -0.19 | -33.0% | 104 | 48% | -2.9% | +1.1% | -10.4% |
| carry_7d_btc_hedged_short_only | validation | base | -14.0% | -14.0% | -0.44 | -36.2% | 53 | 58% | -11.9% | +1.3% | -3.4% |
| carry_7d_btc_hedged_short_only | validation | stressed | -16.8% | -16.7% | -0.56 | -36.6% | 53 | 58% | -11.4% | +1.3% | -6.7% |
| carry_7d_btc_hedged_short_only | holdout | base | +28.9% | +14.9% | +0.80 | -24.8% | 95 | 54% | +34.8% | +0.1% | -5.9% |
| carry_7d_btc_hedged_short_only | holdout | stressed | +22.3% | +11.6% | +0.65 | -25.6% | 95 | 54% | +33.8% | +0.1% | -11.6% |
| placebo_random (mean) | discovery | base | -12.3% | -7.3% | -0.35 | -32.3% | 104 | 152% | +2.5% | +0.1% | -15.0% |
| placebo_random (mean) | discovery | stressed | -25.2% | -14.4% | -0.76 | -38.5% | 104 | 152% | +2.4% | +0.1% | -27.7% |
| placebo_random (mean) | validation | base | -8.3% | -8.3% | -0.35 | -29.5% | 53 | 154% | -0.4% | -0.0% | -7.9% |
| placebo_random (mean) | validation | stressed | -15.5% | -15.5% | -0.68 | -32.6% | 53 | 154% | -0.4% | -0.0% | -15.1% |
| placebo_random (mean) | holdout | base | -11.9% | -7.4% | -0.46 | -27.9% | 95 | 152% | +1.8% | -0.0% | -13.7% |
| placebo_random (mean) | holdout | stressed | -23.8% | -14.4% | -0.95 | -34.2% | 95 | 152% | +1.7% | -0.0% | -25.5% |

### Placebo band (total return across 200 random runs)

| Window | Costs | Mean | 5th pct | 95th pct |
|---|---|---|---|---|
| discovery | base | -12.3% | -45.6% | +31.1% |
| discovery | stressed | -25.2% | -53.7% | +12.3% |
| validation | base | -8.3% | -43.9% | +35.2% |
| validation | stressed | -15.5% | -48.5% | +24.5% |
| holdout | base | -11.9% | -40.9% | +26.8% |
| holdout | stressed | -23.8% | -49.0% | +9.6% |

The placebo trades much more (about 152% weekly turnover) than the real variants, so its costs are
higher. Its band is therefore an easier bar than a turnover-matched null would be.

### Basket funding, delay test and bootstrap (variants 1 and 2)

Realised funding of each basket while held, annualised. "Signal" is the trailing funding that got the
coins picked.

| Variant | Window | Short basket realised | Short signal | Long basket realised | Long signal |
|---|---|---|---|---|---|
| carry_7d | discovery | +7.3% | +8.9% | -9.7% | -16.3% |
| carry_7d | validation | +14.1% | +16.6% | +2.0% | -0.1% |
| carry_7d | holdout | +4.1% | +5.9% | -4.6% | -7.0% |
| carry_30d | discovery | +7.3% | +7.9% | -8.4% | -14.6% |
| carry_30d | validation | +14.3% | +16.1% | +2.0% | +1.0% |
| carry_30d | holdout | +4.4% | +5.3% | -4.4% | -5.9% |

One extra day of delay (same Sunday signal, traded at Tuesday's open):

| Variant | Window | Base total | Base Sharpe | Stressed total | Stressed Sharpe |
|---|---|---|---|---|---|
| carry_7d | discovery | -7.4% | -0.09 | -15.1% | -0.31 |
| carry_7d | validation | -14.2% | -0.64 | -18.3% | -0.87 |
| carry_7d | holdout | +51.1% | +1.43 | +38.3% | +1.13 |
| carry_30d | discovery | -0.8% | +0.07 | -5.1% | -0.05 |
| carry_30d | validation | -0.6% | +0.11 | -3.0% | +0.01 |
| carry_30d | holdout | +50.4% | +1.45 | +44.8% | +1.32 |

Stationary block bootstrap of holdout daily returns at stressed costs (mean block 20 days, 2,000 draws),
90% interval for the annualised return:

- `carry_7d`: +6.8% to +53.0%, median +28.2%.
- `carry_30d`: +4.1% to +56.2%, median +27.3%.

## Verdicts under the fixed pass rule

| Variant | Stressed total positive in all 3 windows | Holdout stressed Sharpe at least 0.5 | Beats placebo 95th pct in holdout (+9.6%) | Verdict |
|---|---|---|---|---|
| carry_7d | No (-5.3%, -12.4%, +56.8%) | Yes (1.54) | Yes (+56.8%) | FAILS |
| carry_30d | Yes (+4.5%, +2.0%, +54.7%) | Yes (1.54) | Yes (+54.7%) | PASSES |
| carry_7d_btc_hedged_short_only | No (-12.2%, -16.8%, +22.3%) | Yes (0.65) | Yes (+22.3%) | FAILS |
| placebo_random | n/a | n/a | n/a | The null, not a candidate |

`carry_30d` passes the rule as written. The pass should be read together with these facts, all visible
in the tables above:

- The pass is carried by the holdout, and the holdout return is mostly price, not funding. Of the
  +54.7% stressed holdout return, +54.6% is price P&L and +10.0% is funding, less 9.9% costs. The idea
  under test was collecting funding. In discovery and validation the price leg was about flat or
  negative (-2.6% and +0.6%). The study does not show why the price leg was so large in the holdout, and
  one window cannot tell skill from a lucky pairing of coins.
- The discovery and validation passes are thin: +2.2% and +2.0% a year at stressed costs, with Sharpe
  0.21 in both and drawdowns of 24.2% and 18.6%.
- With one extra day of delay, `carry_30d` is negative at stressed costs in discovery (-5.1%) and
  validation (-3.0%). On the delayed run it would not meet the first condition of the pass rule. The
  delayed run also trades on a different weekday, so part of that gap is day-of-week noise rather than
  decay.
- Funding itself behaved as hoped. The short basket kept paying more than the long basket after
  selection in every window (a gap of roughly 9 to 17 points a year), and the funding leg was positive
  in every window for both carry variants. It is small against the price swings: 5% to 10% a year of
  funding against drawdowns of 14% to 24%.
- In the holdout the 30 day ranking leaned on a few names. ATOM was in the long basket in 92 of 95 weeks
  and LINK, LTC, ETC, AAVE and BTC supplied most of the shorts. That is close to one persistent coin
  bet, not 95 independent ones.

## Limits

- These are Binance USD-M perpetuals. Funding and prices on Hyperliquid differ (hourly funding, other
  caps, other liquidity), so none of this transfers directly.
- Daily bars only. Fills are assumed at the daily open with a flat fee. No spread, slippage, market
  impact or intraday liquidation path is modelled.
- No margin, leverage, borrow or liquidation modelling. A dollar-neutral book of 8 perps can still be
  liquidated on one leg in a sharp move.
- Funding is applied to the start-of-day notional of each position, a small approximation.
- The 16 coins are survivors chosen with hindsight: all are still listed and liquid in 2026. Coins that
  were delisted or collapsed are missing, and those are exactly the ones a low-funding long basket
  would tend to hold.
- Only 16 coins, so each side is 4 names. Results are sensitive to single coins.
- The holdout window (2025-01 to 2026-10) has been used by many earlier studies in this folder. It is
  not a fresh sample for the researcher, even though this specification was fixed before looking.
- About 2,000 variants have been tried in this folder. One pass out of three candidates here, driven by
  one window, is weak evidence on that base rate.
- The final day (2026-10-31) uses that day's close in place of the next open, and misses the midnight
  funding print that follows it, because neither is in the cache.
- Five daily bars (2022-02-26 to 2022-02-28, 2022-04-01, 2022-04-02) are missing from the monthly daily
  archives for LTC, SOL, TRX, XLM and XRP. They were rebuilt from cached hourly bars, the same patch the
  folder's other daily crypto studies use.
- SOL has 101 funding prints at 2 hour or 4 hour intervals. They are summed into the day like any
  other print.
- The placebo has higher turnover than the real variants, so beating its 95th percentile is easier than
  beating a turnover-matched null.
