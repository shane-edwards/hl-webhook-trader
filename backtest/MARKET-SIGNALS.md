# Cross-market price and volatility signals

This research tested whether moves in retail-heavy coins transmit to other cryptocurrencies, whether relative U.S. opening gaps or late-session moves reverse, and whether the Cboe volatility curve adds information to equity selloffs. No rule met the requirements for automated trading.

## Best lead

A large 30-minute rally across XRP, DOGE and TRX can precede further gains in lagging BTC, ETH and SOL. The rule compares each leader's move with its own trailing 14-day variation, requires an average standardized move of at least 2.5, and looks for a lagging receiver. It waits a full 15-minute bar, then holds a directional long for up to 24 hours with a volatility stop.

| Prices and execution | Feb–Dec 2024 | 2025 | Jan–Oct 2026 |
| --- | ---: | ---: | ---: |
| Binance BTC, ETH and SOL | +5.22% | +38.21% | +13.51% |
| Binance signals, Bybit execution prices and funding | +7.16% | +37.92% | +13.43% |
| Frozen setup on BNB, LINK and ADA | +33.91% | +20.75% | +15.99% |

All rows use 15 basis points per fill, 7 extra basis points for stops, recorded perpetual funding and 1× sleeve exposure. Bybit keeps the Binance signal and changes the modeled execution and funding. The extra receiver set checks whether the same rule works on other coins. The 2026 Binance result used 62 trades on 29 dates, had 7.22% marked drawdown and beat a similar rule with other major coins as leaders, which lost 6.89%. The 2024 Binance drawdown reached 24.35% at higher costs, and the weekly return variation made the weakest period inconclusive. Tideframe tracks this rule in its research watchlist with modeled 15-minute Hyperliquid fills and signed funding. The forward replay freezes the stop from the latest complete candles at observation.

The best three-day fade returned +21.60% in the 2026 Binance replay, with a 22.35% drawdown. The same fixed rule lost 12.33% on the additional receiver assets. That result ruled out a broad interpretation of the fade.

## Stock and ETF tests

The opening and late-session study grouped real eToro bid/ask quotes into regular 30-minute sessions. It tested entering after a large relative opening gap or after a large move by 15:30 New York time. Each trigger was compared with the asset's prior gap variation and SPY's contemporaneous move. A separate study used Cboe VIX, VIX9D and VIX3M closes observed before entering the following regular session. It tested equity ETF trades held one to ten sessions during volatility shocks and subsequent cooling.

| Research | Rules | Outcome |
| --- | ---: | --- |
| Crypto cross-market diffusion | 240 | Positive leads and venue checks shown above. Zero early qualifiers. |
| Cash equity gaps and late moves | 48 ETF rules plus 48 individual-stock rules | Zero early qualifiers. The individual-stock results use the verified sessions available in the report. |
| Cboe volatility inputs on equity ETF trades | 64 | Zero early qualifiers across the six discovery ETFs. |

Samples are ordered chronologically. The two earlier windows choose fixed rules before measurement on later data, with separate receiving assets and venue pricing where available. Cash-stock legs use actual historical opening ask and bid quotes. Crypto stop and execution costs are modeled. The historical dataset overlaps earlier Tideframe research, so future observations are still needed.

## Run the studies

```text
npx tsx backtest/crypto-diffusion-study.ts --replicate
npx tsx backtest/intraday-etf-data.ts
npx tsx backtest/stock-gap-data.ts
npx tsx backtest/stock-gap-study.ts
npx tsx backtest/stock-volatility-study.ts
```

[Crypto results](crypto-diffusion-results.json) · [Crypto replication](crypto-diffusion-replication.json) · [Equity gap results](stock-gap-results.json) · [Volatility results](stock-volatility-results.json)

Sources include [directional crypto spillover research](https://ssrn.com/abstract=7597918), [Federal Reserve research on overnight returns](https://www.newyorkfed.org/research/staff_reports/sr917.html), [Binance public data](https://github.com/binance/binance-public-data), [Bybit historical candles](https://bybit-exchange.github.io/docs/v5/market/kline), and [Cboe volatility index data](https://www.cboe.com/tradable-products/vix/vix-historical-data).
