# Directional strategy testing

This round covered 516 configurations across intraday and multi-day holds. The longest equity and crypto samples reached back to 2021. Returns are modeled after costs. The study used no funds or orders.

## Strongest stock leads

| Fixed setup | Earlier validation | Reserved 2026 period, higher costs | Decision |
| --- | --- | --- | --- |
| Buy after a filing shows at least 15% year-over-year diluted EPS growth and hold three US sessions | +14.55% on the first stock group and +11.93% on a separate stock group and period | +2.15% over 32 trades. Same-window SPY was ahead by 5.1 basis points per trade. Maximum portfolio drawdown was 7.89%. | Research only |
| Buy an ETF after two-day RSI falls to 5 or lower in a 200-day uptrend and exit after five sessions or on the risk stop | +3.35% after higher costs in 2025 on 12 ETFs outside the initial universe, 36 trades across 23 dates | +1.97% on those 12 ETFs over 45 trades and +0.56% on the original eight over 28 trades. Gains were uneven across weeks. | Research only |

The earnings rule waits until the second trading session after the filing date. The EPS comparison uses the same filing's current and year-ago three-month figures to reduce split and restatement discrepancies. The price comparison uses SPY over the same trade windows. The test allocated up to 25% of portfolio equity per stock, with at most three concurrent positions. It measures filed EPS growth. Analyst consensus and earnings surprises were outside the dataset.

The ETF pullback rule uses a 7.5% modeled stop, actual opening bid/ask prices, and an extra 6.5 basis points per fill in the higher-cost test. ETF groups share market exposure. The separate ticker set tests transfer across instruments, while January–November 2026 is a separate time window. eToro quotes preserve the broker's historical spreads. Returns are price returns, with no dividend or tax reconstruction.

## Tests that did not produce a finalist

| Universe | Setup families | Configurations |
| --- | --- | ---: |
| SPY, QQQ, IWM, XLK and XLF | Volatility-band breaks, opening moves, and post-FOMC reactions | 36 |
| Eight US-listed ETFs | Relative strength rotation with and without a defensive market-regime filter | 36 |
| BTC, ETH and SOL | Spot/perpetual taker-flow agreement, crowded reversals, absorption and spot-led moves, held one to six hours or two to seven days | 288 |
| BTC, ETH, LINK, ADA and DOGE | Weekly directional channel and trailing-return signals with volatility-based sizing | 24, plus the same 24 run on each coin separately |
| BTC, ETH, LINK, ADA and DOGE | Short-term RSI reversals with trend and stop controls | 72 |

The remaining configurations are the 24 filing-growth rules and the 36 ETF pullback rules. The crypto-flow replay matched 298,068 15-minute spot and perpetual bars. Directional crypto trades include archived funding payments and modeled taker execution. USD-M series without complete daily prices and funding were excluded from the longer replay. The US ETF intraday study uses the Federal Reserve's actual statement dates and flat-by-close rules. It charges a higher CFD cost scenario for short positions. None of these tests produced a rule for Automated or Live trading.

[Binance archive specification](https://github.com/binance/binance-public-data) · [Federal Reserve FOMC calendars](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) · [Original ETF intraday momentum study](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172) · [SEC public data APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

## Reproduce

Run with the repository dependencies installed. The stock downloaders use the configured eToro market-data feed. Raw archives and account data stay in the ignored cache. The studies write aggregate JSON beside this report.

```bash
npx tsx backtest/intraday-etf-data.ts
npx tsx backtest/intraday-etf-data.ts --reserve
npx tsx backtest/fundamental-drift-data.ts
npx tsx backtest/crypto-flow-study.ts
npx tsx backtest/etf-signal-study.ts
npx tsx backtest/crypto-weekly-study.ts
npx tsx backtest/fundamental-drift-study.ts
npx tsx backtest/short-term-reversal-study.ts
```
