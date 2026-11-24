# Crypto setup research

This study tested 740 directional rules on BTC, ETH and SOL. The Bitcoin ETF flow study trades BTC alone. Rules cover both directions and holding periods from 30 minutes to seven days. Zero rules met the validation requirements for Paper or Live.

| Signal | Variants | What happened |
| --- | ---: | --- |
| Binance perpetual open interest | 288 | Tested reversals and continuation after contracts closed or accumulated. The strongest two-day long was positive in all three periods on Binance, with too few signal days and weaker results when rebuilt with Bybit open interest. |
| U.S. cash open, equity confirmation or divergence, Fed statements and ETF pricing window | 60 | All missed early validation. The leading Fed follow-through lost 1.86% at stressed costs over three 2026 meeting dates. |
| Published Bitcoin spot ETF flows | 72 | The strongest three-day flow-following rule made 9.31% at stressed costs in the final period over 19 signal days. Delaying entry by one more day returned −2.05% and −4.06% at stressed costs in the two earlier periods. The source contains revised history without first-publication timestamps. |
| Actual Hyperliquid liquidations | 320 | The best 15-minute liquidation continuation rule went from +6.69% in discovery to −3.01% in validation. The strongest three-day short lost 10.96% over 32 signal days in the final period. |

## Strongest swing lead

The long setup looks for a substantial 24-hour price rise and open interest growth of roughly 4%, confirms positive Binance spot taker flow and screens out expensive funding before the move. It evaluates every fourth hour, enters on the next available 15-minute bar after completing the input, and holds up to 48 hours with a volatility stop. It uses a 15-minute observation lag for open interest. The open interest measure is in coin or contract quantity, so a rise in price alone cannot increase it.

The frozen strategy was replayed at the higher cost across all periods. The Bybit-native run replaces the perpetual prices, funding and open interest while retaining the same Binance spot-flow input. Bybit fills using Binance signals test execution portability with the same entries.

| Signal and execution | Feb–Dec 2024 | 2025 | Jan–Oct 2026 | Jan–Oct signal days |
| --- | ---: | ---: | ---: | ---: |
| Binance signal and execution | +6.95% | +10.83% | +6.22% | 10 |
| Binance signal, Bybit execution | +6.89% | +10.89% | +6.26% | 10 |
| Bybit open interest and execution | +9.11% | +5.72% | −1.87% | 11 |
| Bybit replay with the open-interest filter removed | +14.59% | +5.07% | +6.47% | 16 |

The Binance final period had 13 trades on 10 dates and a 3.49% maximum marked drawdown. The three asset sleeves returned +13.23% BTC (2 trades), +8.40% ETH (5 trades) and −2.96% SOL (6 trades). Removing Binance's open interest filter yielded +6.78% in the final period. The February 2024 start leaves January for market data lookbacks. The 2026 period ends on October 31.

## Liquidation tape

The native run used 12,586 complete hourly candles and funding observations for each asset. The faster run bucketed individual Hyperliquid fills on 15-minute boundaries and replayed trades on Binance perpetuals with Binance funding. Both used approximately $42.46 billion of recorded long and short liquidations across the three markets. Individual fills were bucketed by their own timestamps. Signals waited a completed 60-minute or 15-minute bar after the liquidation window closed.

Rules compare liquidated notional with its previous seven-day baseline and require dominant liquidation direction and an aligned price shock. Entries either follow the shock or fade it. The shorter run held 30 minutes to 18 hours. The hourly run held 2 hours to 3 days. Discovery covered June–December 2025, validation January–April 2026, and the final window May–October 2026. The best stressed three-day short looked profitable in both earlier periods (+9.44% and +7.36% at their respective cost assumptions), then lost 10.96% in the final period. The same price and exit rules with the liquidation filter removed lost 1.99%.

## Execution and reproducibility

The replay uses equally funded asset sleeves, one open position per asset, and up to 1× sleeve equity at entry. Estimated all-in cost is 8.5 basis points per fill, with 3 additional basis points on stop fills. The stressed replay uses 15 basis points per fill and 7 extra on stop fills. Funding rates come from each execution venue and are settled at the recorded boundaries, with candle opens as funding-value proxies. The candle replay uses gap-aware stops and skips trades spanning missing execution bars. It estimates spread and slippage through the fixed fill charge. Prices at observed order-book depth and market impact were outside this study.

Each rule earns a ranking from the weaker of its discovery and validation results. Both windows must have positive net returns, adequate distinct signal dates and weeks, acceptable drawdown and support across the tested assets. The portfolio's weekly return variation controls for trades clustered across assets. The earlier windows choose one rule per family or side as applicable before the final window is evaluated. For the positioning and liquidation studies, the candidate's risk-adjusted score and average trade also have to improve over the same price setup with the data filter removed. Positive rules with weak earlier evidence are shown as diagnostics.

```powershell
npx tsx backtest/crypto-positioning-study.ts --replicate
python backtest/hyperliquid-liquidation-data.py
npx tsx backtest/hyperliquid-liquidation-study.ts
```

The positioning runner downloads and caches public Binance and Bybit archives. The U.S. session and ETF flow research also uses the cached SPY 30-minute dataset from `backtest/intraday-etf-data.ts`, which uses the configured eToro market-data connection. Python requires `pyarrow` and `requests`. Raw data stays in the ignored `backtest/data/intraday` directory.

Machine-readable runs include [Binance positioning](crypto-positioning-results.json), [Bybit replication](crypto-swing-replication-results.json), [U.S. sessions](crypto-sessions-results.json), [Bitcoin ETF flows](crypto-etf-flow-results.json) and [liquidation fills](hyperliquid-liquidation-results.json).

Market data sources include [Binance Data Vision](https://github.com/binance/binance-public-data), [Bybit open interest](https://bybit-exchange.github.io/docs/v5/market/open-interest), [Bybit candles](https://bybit-exchange.github.io/docs/v5/market/kline), [Bybit funding](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate), [Ironflow historical Hyperliquid datasets](https://ironflow.sh/datasets), [Federal Reserve FOMC dates](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) and [TFTC spot ETF flow sources and update schedule](https://www.tftc.io/bitcoin-etf-flows/methodology).

The event tests were informed by [research on U.S. ETF benchmark-hour trading](https://www.sciencedirect.com/science/article/pii/S1544612326014601), [Bitcoin ETF flow publication timing](https://ssrn.com/abstract=7545019) and [Bitcoin futures liquidations](https://ssrn.com/abstract=3781646).
