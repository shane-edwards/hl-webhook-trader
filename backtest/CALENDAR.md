# Calendar effects in crypto: time of day, weekday, weekend, funding hours

Script: `python -B backtest/calendar-study.py` (from the repo root). Full numbers: `backtest/calendar-results.json`.

## Verdict

Nothing passes. Nothing qualifies as "real but not tradable" either.

- The best and worst hours picked on the train window reversed sign in both later windows, even before costs.
- The weekend long and the Wednesday long were positive before costs in every window, but neither reaches a holdout t-statistic of 2. The weekend effect fell to about zero in the holdout.
- The funding-hour fade has no measurable edge before costs (mean +0.17 bps per trade in the holdout, t = +0.17) and loses everything after costs.

## What was tested

Six calendar rules on BTC, ETH and SOL, using Binance spot hourly candles. The specification was fixed before any result was seen. The script was run once and no variant, threshold or window was changed afterwards. No bug fix or rerun was needed.

Windows: train 2020-07-01 to 2022-12-31, validate 2023-01-01 to 2024-12-31, holdout 2025-01-01 to 2026-11-22.

## Fixed rules

- Every trade is long or short at 1x with equal capital per coin. Entry is at the open of the first bar of the window. Exit is at the open of the bar after the window ends.
- Costs per round trip: zero, base 0.13%, stressed 0.26%.
- Funding assumption: ignored for holds under 8 hours. For longer holds, 0.01% per 8 hours held is charged to a long and credited to a short (0.03% for a one day hold, 0.06% for the weekend). This is applied at base and stressed cost. The zero cost rows are gross of both fees and funding.
- One "trade" is one portfolio round trip: the equal weight average of the coins that have both an entry bar and an exit bar. The t-statistics are computed on these portfolio trades, not on single coin trades, because the three coins move together and counting them separately would overstate significance. SOL joins on 2020-08-11, so the first six weeks of train hold BTC and ETH only.
- Trades are assigned to a window by entry time.
- Selection for variants 1 to 4 uses the train window only, pooled over the three coins, and is then frozen. The 3 hour block is chosen from the 24 possible start hours (a block may wrap past midnight) by the mean 3 hour open to open return.
- Sharpe is the per trade mean over standard deviation, times the square root of trades per year. Annualised return uses the calendar length of the window.
- Pass rule: mean trade at stressed cost is positive in validate and in holdout, and the holdout t-statistic is at least 2.
- "Real but not tradable" rule: zero cost mean is positive in all three windows, with holdout t at least 2, but the variant fails the pass rule.

## Selections made on train

| Variant | Selected on train | Train pooled mean |
|---|---|---|
| `best_hours_long` | 13:00 to 16:00 UTC | highest 3 hour block |
| `worst_hours_short` | 01:00 to 04:00 UTC | lowest 3 hour block |
| `best_day_long` | Wednesday | +54.5 bps per day |
| `worst_day_short` | Tuesday | -4.2 bps per day |
| `weekend_long` | Sat 00:00 to Mon 00:00 UTC | no selection |
| `pre_funding_fade` | short 23-00, 07-08, 15-16 and long 00-01, 08-09, 16-17 UTC | no selection |

## Data check

| Coin | First bar | Last bar | Bars missing (all history) | Train | Validate | Holdout |
|---|---|---|---|---|---|---|
| BTC | 2020-01-01 00:00 | 2026-11-22 22:00 | 32 | 19 | 1 | 0 |
| ETH | 2020-01-01 00:00 | 2026-11-22 22:00 | 32 | 19 | 1 | 0 |
| SOL | 2020-08-11 06:00 | 2026-11-22 22:00 | 20 | 19 | 1 | 0 |

The gaps are small (exchange outages) and none fall in the holdout. Coin round trips skipped because an entry or exit bar was missing: `best_hours_long` 3 in train and 3 in validate, `worst_hours_short` 6 in train, `pre_funding_fade` 15 in train, all others zero. No portfolio trade was lost entirely. The last bar opens at 22:00 on 2026-11-22, so trades needing a later exit are not taken.

## Part A: is there a stable pattern?

Rank correlation (Spearman) of the mean returns between windows. Hours use 24 values, weekdays use 7.

| Scope | Hours: train vs validate | Hours: validate vs holdout | Hours: train vs holdout | Days: train vs validate | Days: validate vs holdout | Days: train vs holdout |
|---|---|---|---|---|---|---|
| BTC | -0.065 | 0.180 | -0.155 | 0.429 | 0.786 | 0.821 |
| ETH | -0.397 | 0.275 | -0.302 | 0.464 | 0.821 | 0.750 |
| SOL | -0.457 | 0.396 | -0.643 | 0.607 | 0.786 | 0.464 |
| Pooled | -0.330 | 0.426 | -0.537 | 0.429 | 0.750 | 0.750 |

Hours: the pattern is not stable. The train ranking is negatively related to both later windows, which means hours that looked best in 2020 to 2022 tended to look worse afterwards. Validate and holdout agree weakly (pooled 0.43). On the pooled table the sign of the hourly mean matched in 12 of 24 hours between train and validate and in 14 of 24 between validate and holdout, which is close to a coin flip.

Weekdays: the ranking is more consistent (pooled 0.43, 0.75 and 0.75), but with only 7 values these correlations are weak evidence. A rank correlation of 0.75 on 7 points is about the 5% significance line, and six such comparisons were made. The sign of the pooled daily mean matched on 7 of 7 days between train and validate and 5 of 7 between validate and holdout. Most of the agreement comes from Tuesday being weak and Wednesday being strong in every window.

Pooled mean hourly return in bps, with t-statistic in brackets:

| Hour UTC | Train | Validate | Holdout |
|---|---|---|---|
| 00 | +1.54 (+0.56) | +5.99 (+3.23) | -2.15 (-1.46) |
| 01 | -0.21 (-0.09) | -1.56 (-0.89) | -0.17 (-0.10) |
| 02 | -7.67 (-3.64) | +1.96 (+1.29) | +0.59 (+0.42) |
| 03 | -6.64 (-3.08) | +3.79 (+3.04) | +0.77 (+0.59) |
| 04 | +0.15 (+0.08) | +1.88 (+1.43) | +1.68 (+1.39) |
| 05 | +4.85 (+2.38) | +1.16 (+0.94) | -0.70 (-0.55) |
| 06 | +4.78 (+2.26) | +3.15 (+2.54) | -2.39 (-1.73) |
| 07 | +4.37 (+2.03) | -0.91 (-0.65) | +0.07 (+0.06) |
| 08 | +0.34 (+0.14) | +1.81 (+1.18) | +2.98 (+2.34) |
| 09 | -2.13 (-0.98) | +3.35 (+2.53) | +1.00 (+0.87) |
| 10 | +5.69 (+2.52) | +0.41 (+0.34) | -1.85 (-1.63) |
| 11 | -0.51 (-0.23) | +2.30 (+1.87) | +2.57 (+2.17) |
| 12 | +1.87 (+0.67) | +1.32 (+0.87) | -1.84 (-1.43) |
| 13 | +9.81 (+3.64) | -3.36 (-1.95) | -3.97 (-2.24) |
| 14 | -1.39 (-0.45) | -1.55 (-0.76) | +0.12 (+0.06) |
| 15 | +8.23 (+3.25) | -1.73 (-0.86) | -1.00 (-0.46) |
| 16 | +2.93 (+1.18) | -2.13 (-1.35) | -2.72 (-1.59) |
| 17 | -3.46 (-1.49) | +6.04 (+3.43) | +1.85 (+1.02) |
| 18 | +1.16 (+0.54) | +3.82 (+2.28) | -3.05 (-2.06) |
| 19 | +0.21 (+0.10) | -3.01 (-1.64) | +0.75 (+0.51) |
| 20 | +2.57 (+1.13) | -0.27 (-0.16) | +0.19 (+0.13) |
| 21 | +2.97 (+1.36) | +4.23 (+2.60) | +3.01 (+2.05) |
| 22 | +0.41 (+0.19) | +7.82 (+4.63) | +1.69 (+1.16) |
| 23 | +0.27 (+0.12) | -2.01 (-1.59) | -1.96 (-1.67) |

The pooled t-statistics treat each coin hour as independent. The coins are highly correlated, so these are overstated by up to a factor of about 1.7. They are for description only.

Pooled mean daily return in bps, with t-statistic in brackets:

| Day | Train | Validate | Holdout |
|---|---|---|---|
| Mon | +37.0 (+1.14) | +43.7 (+1.96) | +6.1 (+0.29) |
| Tue | -4.2 (-0.17) | -2.5 (-0.13) | -14.5 (-0.77) |
| Wed | +54.5 (+1.52) | +52.4 (+2.28) | +44.4 (+2.21) |
| Thu | +15.8 (+0.54) | +4.4 (+0.20) | -75.5 (-3.63) |
| Fri | +4.3 (+0.14) | +57.7 (+2.72) | +1.7 (+0.08) |
| Sat | +44.2 (+1.98) | +26.4 (+1.58) | -1.3 (-0.09) |
| Sun | +48.9 (+1.99) | +43.7 (+2.77) | +7.3 (+0.38) |

Per coin tables for all three windows are in the JSON under `part_a.tables`.

## Part B: results

Mean is per portfolio trade in basis points.

### Train (2020-07-01 to 2022-12-31)

| Variant | Cost | Trades | Mean bps | t | Win rate | Total return | Annualised | Sharpe | Max drawdown |
|---|---|---|---|---|---|---|---|---|---|
| `best_hours_long` | zero | 913 | +16.47 | +2.41 | 54.8% | +270.4% | +68.8% | +1.52 | -29.3% |
| `best_hours_long` | base | 913 | +3.47 | +0.51 | 51.5% | +13.1% | +5.1% | +0.32 | -44.5% |
| `best_hours_long` | stressed | 913 | -9.53 | -1.39 | 47.0% | -65.5% | -34.6% | -0.88 | -71.3% |
| `worst_hours_short` | zero | 912 | +13.90 | +2.39 | 52.5% | +208.8% | +56.9% | +1.51 | -21.7% |
| `worst_hours_short` | base | 912 | +0.90 | +0.15 | 47.6% | -5.6% | -2.3% | +0.10 | -31.0% |
| `worst_hours_short` | stressed | 912 | -12.10 | -2.08 | 42.5% | -71.2% | -39.2% | -1.32 | -71.9% |
| `best_day_long` | zero | 131 | +56.95 | +1.12 | 58.0% | +67.2% | +22.8% | +0.71 | -37.4% |
| `best_day_long` | base | 131 | +40.95 | +0.81 | 58.0% | +35.6% | +13.0% | +0.51 | -41.5% |
| `best_day_long` | stressed | 131 | +27.95 | +0.55 | 56.5% | +14.4% | +5.5% | +0.35 | -45.1% |
| `worst_day_short` | zero | 130 | +4.80 | +0.14 | 45.4% | -2.9% | -1.2% | +0.09 | -44.8% |
| `worst_day_short` | base | 130 | -5.20 | -0.16 | 44.6% | -14.8% | -6.2% | -0.10 | -49.2% |
| `worst_day_short` | stressed | 130 | -18.20 | -0.55 | 44.6% | -28.0% | -12.3% | -0.35 | -54.5% |
| `weekend_long` | zero | 131 | +93.91 | +2.31 | 60.3% | +195.9% | +54.3% | +1.46 | -30.8% |
| `weekend_long` | base | 131 | +74.91 | +1.84 | 60.3% | +131.1% | +39.8% | +1.17 | -36.7% |
| `weekend_long` | stressed | 131 | +61.91 | +1.52 | 58.8% | +95.0% | +30.6% | +0.96 | -40.7% |
| `pre_funding_fade` | zero | 5479 | -1.28 | -0.89 | 48.9% | -63.7% | -33.3% | -0.56 | -68.2% |
| `pre_funding_fade` | base | 5479 | -14.28 | -9.94 | 41.6% | -100.0% | -96.1% | -6.28 | -100.0% |
| `pre_funding_fade` | stressed | 5479 | -27.28 | -18.99 | 34.8% | -100.0% | -99.8% | -12.00 | -100.0% |

The train results for variants 1 to 4 are in sample, because the hours and days were chosen on this window.

### Validate (2023-01-01 to 2024-12-31)

| Variant | Cost | Trades | Mean bps | t | Win rate | Total return | Annualised | Sharpe | Max drawdown |
|---|---|---|---|---|---|---|---|---|---|
| `best_hours_long` | zero | 730 | -6.40 | -1.22 | 47.1% | -41.7% | -23.7% | -0.86 | -57.1% |
| `best_hours_long` | base | 730 | -19.40 | -3.69 | 41.0% | -77.5% | -52.5% | -2.60 | -80.0% |
| `best_hours_long` | stressed | 730 | -32.40 | -6.16 | 35.9% | -91.3% | -70.5% | -4.35 | -92.0% |
| `worst_hours_short` | zero | 731 | -4.13 | -1.10 | 46.4% | -28.7% | -15.6% | -0.78 | -31.6% |
| `worst_hours_short` | base | 731 | -17.13 | -4.58 | 40.1% | -72.5% | -47.5% | -3.24 | -72.5% |
| `worst_hours_short` | stressed | 731 | -30.13 | -8.05 | 31.9% | -89.4% | -67.4% | -5.69 | -89.4% |
| `best_day_long` | zero | 104 | +52.39 | +1.48 | 54.8% | +61.2% | +26.9% | +1.04 | -25.5% |
| `best_day_long` | base | 104 | +36.39 | +1.02 | 51.9% | +36.5% | +16.8% | +0.72 | -29.4% |
| `best_day_long` | stressed | 104 | +23.39 | +0.66 | 49.0% | +19.3% | +9.2% | +0.47 | -32.4% |
| `worst_day_short` | zero | 105 | +2.49 | +0.09 | 48.6% | -1.4% | -0.7% | +0.07 | -37.6% |
| `worst_day_short` | base | 105 | -7.51 | -0.28 | 46.7% | -11.2% | -5.8% | -0.20 | -40.5% |
| `worst_day_short` | stressed | 105 | -20.51 | -0.75 | 45.7% | -22.6% | -12.0% | -0.53 | -45.1% |
| `weekend_long` | zero | 104 | +69.22 | +2.29 | 61.5% | +95.3% | +39.7% | +1.62 | -16.7% |
| `weekend_long` | base | 104 | +50.23 | +1.66 | 56.7% | +60.5% | +26.7% | +1.17 | -18.1% |
| `weekend_long` | stressed | 104 | +37.23 | +1.23 | 54.8% | +40.2% | +18.4% | +0.87 | -19.1% |
| `pre_funding_fade` | zero | 4386 | +1.72 | +1.74 | 50.5% | +93.4% | +39.0% | +1.23 | -29.1% |
| `pre_funding_fade` | base | 4386 | -11.28 | -11.40 | 38.6% | -99.4% | -92.0% | -8.06 | -99.4% |
| `pre_funding_fade` | stressed | 4386 | -24.28 | -24.54 | 28.2% | -100.0% | -99.5% | -17.35 | -100.0% |

### Holdout (2025-01-01 to 2026-11-22)

| Variant | Cost | Trades | Mean bps | t | Win rate | Total return | Annualised | Sharpe | Max drawdown |
|---|---|---|---|---|---|---|---|---|---|
| `best_hours_long` | zero | 691 | -4.87 | -0.86 | 50.8% | -33.8% | -19.6% | -0.63 | -49.8% |
| `best_hours_long` | base | 691 | -17.87 | -3.16 | 45.7% | -73.1% | -50.0% | -2.30 | -77.0% |
| `best_hours_long` | stressed | 691 | -30.87 | -5.46 | 39.8% | -89.1% | -69.0% | -3.97 | -90.2% |
| `worst_hours_short` | zero | 691 | -1.12 | -0.29 | 47.0% | -10.7% | -5.8% | -0.21 | -37.0% |
| `worst_hours_short` | base | 691 | -14.12 | -3.67 | 41.1% | -63.6% | -41.4% | -2.67 | -66.7% |
| `worst_hours_short` | stressed | 691 | -27.12 | -7.06 | 35.3% | -85.2% | -63.6% | -5.13 | -85.9% |
| `best_day_long` | zero | 99 | +44.38 | +1.37 | 51.5% | +47.5% | +22.8% | +1.00 | -15.6% |
| `best_day_long` | base | 99 | +28.38 | +0.88 | 46.5% | +26.0% | +13.0% | +0.64 | -19.4% |
| `best_day_long` | stressed | 99 | +15.38 | +0.47 | 45.5% | +10.8% | +5.6% | +0.34 | -23.7% |
| `worst_day_short` | zero | 98 | +14.52 | +0.47 | 52.0% | +10.2% | +5.3% | +0.34 | -26.6% |
| `worst_day_short` | base | 98 | +4.52 | +0.15 | 52.0% | -0.1% | -0.1% | +0.11 | -28.7% |
| `worst_day_short` | stressed | 98 | -8.48 | -0.28 | 51.0% | -12.0% | -6.6% | -0.20 | -32.8% |
| `weekend_long` | zero | 98 | +2.73 | +0.08 | 59.2% | -3.3% | -1.8% | +0.06 | -28.1% |
| `weekend_long` | base | 98 | -16.27 | -0.46 | 54.1% | -19.8% | -11.0% | -0.33 | -30.0% |
| `weekend_long` | stressed | 98 | -29.27 | -0.82 | 51.0% | -29.4% | -16.8% | -0.60 | -32.2% |
| `pre_funding_fade` | zero | 4145 | +0.17 | +0.17 | 50.1% | -1.5% | -0.8% | +0.12 | -37.8% |
| `pre_funding_fade` | base | 4145 | -12.83 | -12.89 | 36.7% | -99.6% | -94.3% | -9.37 | -99.6% |
| `pre_funding_fade` | stressed | 4145 | -25.83 | -25.95 | 25.1% | -100.0% | -99.7% | -18.86 | -100.0% |

A positive mean can sit beside a slightly negative total return (for example `weekend_long` at zero cost in the holdout) because the total is compounded and the mean is a simple average.

## Verdicts

| Variant | Stressed mean, validate | Stressed mean, holdout | Holdout t (stressed) | Passes | Zero cost mean positive in all three windows | Holdout t (zero cost) | Real but not tradable |
|---|---|---|---|---|---|---|---|
| `best_hours_long` | -32.40 | -30.87 | -5.46 | No | No | -0.86 | No |
| `worst_hours_short` | -30.13 | -27.12 | -7.06 | No | No | -0.29 | No |
| `best_day_long` | +23.39 | +15.38 | +0.47 | No | Yes | +1.37 | No |
| `worst_day_short` | -20.51 | -8.48 | -0.28 | No | Yes | +0.47 | No |
| `weekend_long` | +37.23 | -29.27 | -0.82 | No | Yes | +0.08 | No |
| `pre_funding_fade` | -24.28 | -25.83 | -25.95 | No | No | +0.17 | No |

`best_day_long` (Wednesday) is the closest. Its mean is positive at stressed cost in both later windows, but the holdout t-statistic is 0.47 against a required 2, so it fails. With about 100 trades per window and daily crypto volatility, it cannot be told apart from holding the coin on a random day in a period when prices rose.

## Limits

- Spot prices stand in for perpetual futures. Perp prices, the basis around funding times and real fills would differ. The funding hour test in particular looks at spot, where any funding effect would only show up second hand.
- Funding is a flat assumption of 0.01% per 8 hours, not actual funding rates. Real funding was often several times higher in bull phases, which would hurt the long variants more than shown.
- Three coins only, and they are highly correlated, so this is close to one market tested three times.
- The long variants are compared with zero, not with buy and hold. In a rising market any long window has a positive expected return, so a positive mean for a long day or weekend is not by itself a calendar effect.
- Trades enter and exit exactly at hourly opens with a flat cost. No slippage model beyond the stressed cost level.
- The holdout window has already been used by other studies in this folder, so it is not a fresh holdout for the folder as a whole.
- Six variants were tested. One could pass by chance, and none did. The Part A tables contain 24 hours and 7 days per coin and window, so individual cells with large t-statistics (for example Thursday in the holdout at -75.5 bps, t = -3.63) are expected to appear by chance and were not pre-registered as trades.
- Hours are in UTC with no adjustment for daylight saving time, so a US or European session effect would be smeared across two adjacent hours.
- Weekday samples are small: about 100 to 130 trades per window for the day and weekend variants.
