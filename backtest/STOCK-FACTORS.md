# US stock earnings and reversal research

Tideframe compared 34 fixed variants in three families on the 17-stock eToro basket. They study temporary relative moves versus SPY, last-half-hour reversal and the opening gap following an earnings filing. The app links to the primary research behind the families.

## Price sample and execution

The recorded median regular-session spread is over 30 bps in the 2025 data and about 2 bps in the 2026 periods used for execution testing. This was observed in the broker feed and does not establish the cause or a historical change in any user's actual charges. The 2025 wide-spread data is now used as a price-signal screen with the spread filter disabled and returns reported before execution costs. The subsequent periods are April–June and July–November 2026, with an observed entry spread of 10 bps or less. No prices in the source data are normalized or replaced.

The tests buy on the available ask at the decision quote, with 2 bps additional slippage and $1 per side per $5,000 slot. At most two stocks qualify per session, ranked by the measured signal. Higher costs use 5 bps and $2 per side. Exit at the timed bid or the regular session's last bid close. Gross uses quote midpoints at both ends if available and the bid for regular closing exits. It does not represent a tradable fill.

## Selection and earnings timing

One candidate per family is chosen using the first two periods. Enough trades, positive validation and stress returns, a positive 2025 price signal, consistency across tickers, and active-day t-statistic above 1.65 are required. Results for the first screen-excluded rule in a family are diagnostic only. Three previously examined rule IDs are ineligible for promotion. Other choices are frozen before viewing the later result. Discovery thresholds and duration choices are in `lib/stocks/factor-research.ts`.

The earnings input is an SEC 8-K acceptance timestamp with Item 2.02. Use only filings available between the last regular close and five minutes before the following open. Match nearby report dates and require the prior SPY and stock session dates to agree. Discard apparent gaps above 25% in either direction. SEC timestamp is evidence the filing was available, not necessarily the first publication of the release. No analyst surprise figures are inferred.

## Freeze and replicate

The clearest lead in the first basket buys at 10 a.m. ET after a matched earnings filing and a market-adjusted opening drop of at least 1%, then closes the position that day. Freeze it and evaluate all earnings windows on a separate list of 26 eToro stocks. This is a separate stock sample over overlapping market dates. It is not an independent future time period. The fixed 60-minute version is a secondary comparison. A separate non-matched-gap benchmark applies the original closing exit to days without a matched filing.

Promotion from replication requires at least 30 trades, 20 active days, five positive stocks, +3 bps net per trade, positive higher-cost returns overall and in both calendar slices, and active-day t-statistic of at least 1.65. Forward paper records would need fresh dates and independently logged eligible quotes before assessing live suitability.

The uncertainty interval resamples active session days together with all their trades. It helps illustrate dispersion in the average trade. It does not account for autocorrelation across days or earlier strategy selection.

## Reproduce

Run the opening-price download first if its eToro data is unavailable. Put Read credentials in environment variables outside the repo. SEC requests use `SEC_USER_AGENT` when configured. The report commits aggregate evidence only.

```sh
npm run backtest:stocks:opening-data
npm run backtest:stocks:events
npm run backtest:stocks:factors
npm run backtest:stocks:replication-data
npm run backtest:stocks:replication
```

For observations on dates after the historical study, run `npm run backtest:stocks:forward`. It keeps the original rule and the separate 26-stock basket fixed, starts on November 23, 2026, and ignores the current UTC date. It writes incremental as-of snapshots to ignored local storage and reads broker candles without placing orders. Those are historical observations on prospective dates, not quotes captured at order time. Evaluate the forward sample separately before considering a paper strategy.
