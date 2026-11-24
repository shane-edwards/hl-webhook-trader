# Structural strategy follow-up

| Hypothesis | Test | Result |
| --- | --- | --- |
| Trade a rich perpetual against the matching spot asset | 27 hourly variants on matched Binance BTC, ETH and SOL spot and perpetual bars with observed funding | The most active variant had zero entries in discovery and validation after checking that the gap survived to the next hourly open. |
| Capture the funding difference between two perpetual venues | Same quantity long and short across Hyperliquid and Binance, no transfers assumed, 14-day funding difference, with $3 in collateral per $1 per leg | BTC and ETH each opened once in June–July 2026 and lost 0.24% and 0.21% of committed capital under the higher-cost model. There were no entries in August–October. |
| Follow or fade an earnings gap after observing the first hour | 24 variants using point-in-time SEC Item 2.02 filings, paired eToro quotes, matched SPY returns, and a separate stock sample | No variant qualified for the later window. The most active rule had two trades in discovery and ten in the separate validation sample. |

The earlier BTC and ETH spot/perpetual funding hedge remains the strongest lead. The app now runs a read-only forward simulation that walks both live order books for the same number of units, charges published base-tier taker fees plus modeled extra slippage, and uses a fixed $2,500 of paper capital per coin. It checks the setup hourly and simulates entry only during the daily UTC entry window if the funding and cost thresholds pass. Funding is estimated using observed exchange rates and near-settlement prices. The quote snapshots approximate fills, and the monitoring cadence cannot measure all within-hour collateral moves or the risk that only one leg fills. [Hyperliquid fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees) · [Earlier funding hedge tests](PRICE-ACTION.md)

The earnings test is a reaction-to-price study tied to a public filing timestamp. It does not calculate a surprise relative to analysts' forecast vintages. A timestamp identifies when the filing was available and may lag the original announcement. [Research on earnings drift and trading costs](https://onlinelibrary.wiley.com/doi/10.1111/j.1540-6288.2011.00310.x)

## Reproduce

Use the caches described in the [price-action study](PRICE-ACTION.md). The earnings test also uses the [stock earnings and replication cache](STOCK-FACTORS.md).

```bash
npx tsx backtest/basis-dislocation-study.ts
npx tsx backtest/funding-spread-study.ts
npx tsx backtest/earnings-drift-study.ts
```
