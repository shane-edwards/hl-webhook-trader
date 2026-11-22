// Markdown for the research studies appended to RESULTS.md.
import { computeStats, type Stats } from './engine';
import { BASKET, runBasketTrend, runCarry, runHold, runTrend } from './research';

const pct = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;
const row = (name: string, s: Stats) =>
  `| ${name} | ${pct(s.cagr)} | ${s.sharpe.toFixed(2)} | ${pct(s.vol)} | ${pct(s.maxDrawdown)} | ${pct(s.worstYear)} | ${s.avgExposure.toFixed(2)}x |`;
const HEAD = '| Strategy | CAGR | Sharpe | Vol | Max drawdown | Worst year | Avg exposure |\n|---|---|---|---|---|---|---|';

export function researchMarkdown(): string {
  // --- Study 1: spot-first ---
  const spotRows: string[] = [];
  for (const start of ['2014-01-01', '2020-01-01']) {
    for (const tv of [0.4, 0.6]) {
      const label = `${pct(tv)} vol, from ${start.slice(0, 4)}`;
      spotRows.push(row(`Perp only, ${label}`, computeStats(runTrend({ source: 'bitstamp', startDate: start, config: { targetVol: tv } }))));
      spotRows.push(row(`**Spot first**, ${label}`, computeStats(runTrend({ source: 'bitstamp', startDate: start, config: { targetVol: tv }, spotFirst: true }))));
    }
  }

  // --- Study 2: basket ---
  const BASKET_START = '2021-01-01';
  const basket = runBasketTrend(BASKET, BASKET_START);
  const basketSpot = runBasketTrend(BASKET, BASKET_START, {}, true);
  const btcOnly = computeStats(runTrend({ coin: 'BTC', source: 'binance', startDate: BASKET_START }));
  const btcHold = computeStats(runHold('BTC', 'binance', BASKET_START));
  const years = Object.keys(basket.stats.byYear);

  // --- Study 3: carry ---
  const carryRows = BASKET.map(coin => {
    const a = runCarry({ coin });
    const lev = runCarry({ coin, spotFraction: 0.75 });
    const y = (k: string) => (a.stats.byYear[k] == null ? '' : pct(a.stats.byYear[k], 1));
    return `| ${coin} | ${pct(a.avgAnnualFunding, 1)} | ${pct(a.shareOfDaysPositive)} | ${pct(a.stats.cagr, 1)} | ${y('2023')} | ${y('2024')} | ${y('2025')} | ${y('2026')} | ${pct(a.stats.maxDrawdown, 1)} | ${a.liquidations.length} / ${lev.liquidations.length} |`;
  });
  const carryStart = runCarry({ coin: 'BTC' }).dates[0];

  return `
---

# Further research

Three follow-up studies. Same cost assumptions as above unless stated; spot trades are charged Hyperliquid's 0.07% spot taker fee.

## Study 1: hold spot for the first 1x, use the perp only above that

The perp strategy pays funding on its whole position, and funding was its biggest cost. Holding spot BTC for exposure up to 1x and using the perp only for the part above 1x pays funding only on the leveraged slice. Same signal, same sizes.

${HEAD}
${spotRows.join('\n')}

**Finding:** same risk, roughly 7–15 points more return a year, purely from not paying funding. This is a cost saving, not a prediction, so it is the most dependable result in this document. It is not implemented in the live runner (which trades the perp only).

## Study 2: the same trend rule across ${BASKET.length} coins

One equal-capital sleeve per coin (${BASKET.join(', ')}), each running the default rule, from ${BASKET_START}. Binance spot prices; real Hyperliquid funding per coin from 2023, assumed 0.03%/day before.

${HEAD}
${row('BTC buy & hold', btcHold)}
${row('BTC trend only', btcOnly)}
${row(`**${BASKET.length}-coin trend basket**`, basket.stats)}
${row(`${BASKET.length}-coin basket, spot first`, basketSpot.stats)}

| Year | ${years.join(' | ')} |
|---|${years.map(() => '---').join('|')}|
| Basket | ${years.map(y => pct(basket.stats.byYear[y])).join(' | ')} |

Per coin: ${basket.perCoin.map(c => `${c.coin} ${pct(c.stats.cagr)}`).join(', ')}.

**Finding:** the basket had a better return for its risk than BTC alone over this period, with a smaller drawdown. **Caveat that matters:** these ten coins were chosen because they are large *today*. Coins that collapsed are missing, which flatters the result by an unknown amount. Treat it as "diversifying probably helps", not as a return forecast. It lost money in 2022, 2025 and 2026.

## Study 3: funding capture (long spot + short perp)

Hold spot and short the same amount of the perp. Price moves cancel; the short collects funding when it is positive and pays when it is negative. Real Hyperliquid funding from ${carryStart}. Half the capital buys spot, half is margin for the short. Costs: both legs' fees and slippage to enter, plus small daily trades to keep the legs equal.

| Coin | Avg funding / yr | Days funding > 0 | Return on capital / yr | 2023 | 2024 | 2025 | 2026 | Max drawdown | Short liquidations (1x / 3x short) |
|---|---|---|---|---|---|---|---|---|---|
${carryRows.join('\n')}

**Finding:** real, low-volatility income, but small and shrinking: about 7% a year on BTC over the whole sample, 12–13% in 2024 and 2–3% in 2026. Only half the capital earns funding, which is why the return is about half the funding rate. Compare that with what cash earns risk-free: at 2026 funding levels this trade is unlikely to be worth its risks, and it only becomes attractive when funding spikes (the Markets page ranks live funding for this reason).

Not modelled: the spot/perp price gap when entering and exiting, the exchange failing or being hacked, and funding turning negative for long stretches. Running the short at 3x instead of 1x raises the return by about half and produces the liquidations in the last column.
`;
}
