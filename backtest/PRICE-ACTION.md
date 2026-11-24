# Long and short strategy research

## Findings

BTC and ETH funding hedges earned positive modeled returns on Binance and Hyperliquid. The hedge holds spot and shorts the same number of units in perpetuals while funding is favorable. This is a carry trade with modest returns on total committed capital, including collateral.

| Funding-regime hedge | Binance, Jan–Oct 2026 | Binance, doubled costs | Hyperliquid, May 27–Nov 22, 2026 | Hyperliquid, doubled costs |
| --- | ---: | ---: | ---: | ---: |
| BTC | +0.69% | +0.53% | +1.59% | +1.44% |
| ETH | +0.18% | +0.05% | +1.44% | +1.30% |
| SOL | 0.00%, no entry | 0.00%, no entry | +1.00% | +0.86% |

BTC and ETH each stayed positive across three separate 60-day Hyperliquid replays with doubled execution costs. The longer Hyperliquid replay had one entry per asset. The venue checks share calendar dates with Binance and use separate market prices and funding records. They provide evidence of transfer across venues and a limited number of independent regimes.

The fixed hedge enters at a UTC day boundary when trailing 14-day realized funding reaches 0.27%. It closes when the trailing rate drops below 0.03% at a day boundary or the collateral reset condition is reached. The model allocates $2.50 in capital per $1 of spot and $1 of short perpetual exposure, marks both legs, and applies actual funding and execution costs to both legs. The stress test doubles modeled fees and slippage. It uses candles as fill proxies. It cannot establish actual two-leg fill quality, collateral transfers, or losses during an exchange outage. Returns are before tax and any cost on idle collateral. [BIS research on crypto carry](https://www.bis.org/publications/working-paper-1087-crypto-carry) · [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding)

## Directional results

| Experiment | Result |
| --- | --- |
| BTC, ETH and SOL on 15-minute, hourly and four-hour perpetual candles | 972 configurations. No pooled or asset-specific variant cleared the earlier validation checks. |
| Seventeen US stocks on paired eToro 30-minute quotes | 108 long and short configurations. No variant cleared the earlier validation checks. |
| Fixed four-hour long/short MACD rule | January–October 2026 return was −2.07% on BTC, ETH and SOL and −12.56% on a separate group of XRP, LINK and LTC. Both baskets lost more under higher costs. |
| Weekly 90-day long/short momentum with protective exits | −5.17% in January–October 2026, or −10.30% at higher costs. It also lost money in the earlier periods. |

The price-action tests use known rolling highs and lows, wait for a completed candle to confirm a failed break or a retest, then enter at the next candle's open. Confirmations include volume, trend, and observed perp funding. Positions include timed exits and stop-first fills when both exit levels are touched. Crypto costs include recorded funding. The stock experiment uses observed bid and ask opens, same-session exits, and a separate short-CFD cost model. Historical short availability is unknown. [eToro fee schedule](https://www.etoro.com/en-sg/trading/fees/)

Directional variants were ranked on earlier data, with increased costs in validation. Final windows were reserved for selected variants. The equity data begins in 2025 and includes the earlier broker spreads as recorded. The fixed MACD and momentum replications revisit previously researched rules, and comparisons across coins can share market exposure.

## Reproduce

Run from the repository root with dependencies installed. The scripts write aggregate results beside this report. Price archives stay in the ignored research cache.

```bash
python backtest/scalp-data.py 2026-10
npx tsx backtest/price-action-study.ts
npm run backtest:stocks:opening-data
npx tsx backtest/stock-price-action.ts
```

The stock downloader uses read-authorized eToro keys from the environment. The Hyperliquid check is anchored to November 23, 2026. Hyperliquid's rolling candle limit can make that fixed historical window unavailable when rerunning the script later. [Binance public archive](https://github.com/binance/binance-public-data) · [Hyperliquid candle API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
