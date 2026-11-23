# Broad US stock opening research

This tests daily selection separately from entry rules. The [Zarattini, Barbon and Aziz study](https://alexandria.unisg.ch/server/api/core/bitstreams/3c2989c4-688d-4d78-8a71-f02690990d51/content) ranked the top 20 by opening relative volume across a US stock universe of over 7,000 names. Tideframe tests a fixed, currently listed 17-stock eToro basket and a SPY regime filter. It is a smaller, long-only adaptation, with no short availability, delisted stocks or leverage modeled. Results may be affected by universe selection and survivorship.

## Reproduce

With `ETORO_API_KEY` and `ETORO_USER_KEY` set outside the repository, download the 30-minute candles and the earlier five-minute diagnostic if it is not already cached. Use the broker's Read permission.

```sh
npm run backtest:stocks:download
npm run backtest:stocks:opening-data
npm run backtest:stocks:opening
```

## Fixed rules

- Use complete regular New York sessions from May 2025 through November 20, 2026. The final period starts July 1, 2026. Compute prior volume and ATR from the preceding complete sessions, and today's relative volume from the completed opening bar. Day selection excludes incomplete quote pairs, including incomplete sessions exposed by intraday gaps.
- Eligible entries need a green opening bar, an opening price above $5, a prior 14-session average of at least one million shares per day, and ATR above $0.50. The control picks three eligible stocks by prior dollar volume. The other 30-minute variants pick up to three by current opening volume relative to their previous 14 opens and require at least 1× relative volume. The five-minute diagnostic repeats that screen for the five stocks from the earlier study, with one slot and a 90-minute exit.
- Buy when a later bar's bid high reaches the opening high. Approximate the ask fill using the larger of the opening high or the triggering candle's opening bid, plus the triggering candle's observed opening spread. Exit at a stop 10% of prior daily ATR below the trigger fill on the bid side. If the entry bar includes the stop, assume the stop was reached after entry and avoid using the pre-entry opening bid. Later gaps use the worse opening bid. All trades are flat by the close. The shorter variants exit in at most 90 minutes. The SPY-filter variant first requires SPY's 30-minute opening bar to be green.
- The next-open momentum variant buys the second bar's observed ask and sells at the observed bid 90 minutes later. It uses a timed exit with no simulated intrabar stop. This keeps it independent of the intrabar sequence assumptions used for stop-triggered trades.
- A $10,000 fixed session budget is split between the available strategy slots. Apply 2 bps extra slippage and $1 per side for the stock base case. The stock stress case uses 5 bps and $2 per side. A separate CFD scenario applies 15 bps proportional charges per side and 2 bps slippage. The eToro bid/ask spread is included in all three. These scenarios are comparisons, since actual product availability and fees depend on the account. The [eToro fee schedule](https://www.etoro.com/en-sg/trading/fees/) describes the stock commission range and the separate stock/ETF CFD charge.

A new strategy qualifies for paper evaluation if, in all three periods, it averages at least +3 net bps, remains positive under higher stock costs, records at least 60 trades and 40 active session days, finishes positive on three or more stocks, and has an active-day t-statistic of at least 1.65. Active-day aggregation reduces the effect of simultaneous correlated trades. It does not account for all serial dependence or the selection of multiple hypotheses. The control and the previously explored five-minute sample remain diagnostics.
