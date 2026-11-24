import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { SWING_COINS, SWING_END, swingData } from './crypto-swing-data';
import { DAY } from './price-action-data';

const windows = [
  { from: Date.UTC(2021, 5, 1), to: Date.UTC(2024, 0, 1) },
  { from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) },
  { from: Date.UTC(2025, 0, 1), to: SWING_END },
];
type Window = typeof windows[number];
type Rule = { signal: 'slope' | 'channel'; days: number; annualVol: number; short: boolean };
type Data = Awaited<ReturnType<typeof swingData>>;
type StudySeries = { symbol: string; data: Data };
const feeRates = [.00085, .0015];

function signal(data: Data, i: number, rule: Rule, btc: number) {
  const previous = data[i - 1].c, base = data[i - 1 - rule.days].c;
  if (rule.signal === 'slope') {
    const direction = previous / base - 1;
    return direction >= .025 ? 1 : rule.short && direction <= -.025 && btc < 0 ? -1 : 0;
  }
  const prior = data.slice(i - rule.days - 1, i - 1);
  const midpoint = (Math.max(...prior.map(row => row.h)) + Math.min(...prior.map(row => row.l))) / 2;
  return previous > midpoint ? 1 : rule.short && previous < midpoint && btc < 0 ? -1 : 0;
}

function scale(data: Data, i: number, annualVol: number) {
  let sum = 0, squares = 0;
  for (let j = i - 30; j < i; j++) {
    const change = Math.log(data[j].c / data[j - 1].c);
    sum += change; squares += change ** 2;
  }
  const annual = Math.sqrt(Math.max(0, squares / 30 - (sum / 30) ** 2) * 365);
  return Math.min(1, annualVol / Math.max(.01, annual));
}

function evaluate(market: StudySeries[], btc: Data, window: Window, transactionFee: number, rule?: Rule) {
  const keys = new Float64Array(market.length);
  const moves: number[] = [];
  let cash = 1, high = 1, equity = 1, drawdown = 0, exposure = 0, rebalances = 0, changes = 0, priorWeek = -1;
  let heldDays = 0, fundingPaid = 0, costsPaid = 0, depleted = false;
  for (let i = 130; i < btc.length; i++) {
    const t = btc[i].t;
    if (t < window.from) continue;
    if (t >= window.to) break;
    const last = btc[i + 1]?.t >= window.to || !btc[i + 1];
    const rebalance = rule ? new Date(t).getUTCDay() === 1 : heldDays === 0;
    if (rebalance && !last) {
      rebalances++;
      const opening = cash + market.reduce((sum, row, j) => sum + keys[j] * row.data[i].o, 0);
      const regime = btc[i - 1].c / btc[i - 85].c - 1;
      for (let j = 0; j < market.length; j++) {
        const { data } = market[j];
        const side = rule ? signal(data, i, rule, regime) : 1;
        const weight = (rule ? scale(data, i, rule.annualVol) : 1) * side / market.length;
        const px = data[i].o;
        const desired = Math.max(0, opening) * weight / px;
        if (keys[j] * desired <= 0 && keys[j] !== desired) changes++;
        const fee = Math.abs(desired - keys[j]) * px * transactionFee;
        cash -= (desired - keys[j]) * px + fee;
        costsPaid += fee;
        keys[j] = desired;
      }
    }
    let gross = 0, downside = 0, adverseGross = 0;
    for (let j = 0; j < market.length; j++) {
      const { data } = market[j];
      const quote = data[i], units = keys[j];
      const paid = units > 0 ? units * (quote.pay * quote.h - quote.receive * quote.l) :
        -units * (quote.receive * quote.h - quote.pay * quote.l);
      cash -= paid;
      fundingPaid += paid;
      gross += Math.abs(units) * quote.c;
      const adverse = units > 0 ? quote.l : quote.h;
      downside += units * adverse;
      adverseGross += Math.abs(units) * adverse;
      if (last) {
        const fee = Math.abs(units) * quote.c * transactionFee;
        cash += units * quote.c - fee;
        costsPaid += fee;
        keys[j] = 0;
      }
    }
    const marked = cash + market.reduce((sum, row, j) => sum + keys[j] * row.data[i].c, 0);
    const week = Math.floor((t - window.from) / (7 * DAY));
    if (week !== priorWeek) { moves.push(0); priorWeek = week; }
    if (marked <= 0 || (!last && adverseGross > 0 && cash + downside <= adverseGross * .02)) {
      moves[moves.length - 1] -= equity;
      equity = 0;
      drawdown = 1;
      depleted = true;
      break;
    }
    moves[moves.length - 1] += marked - equity;
    equity = marked;
    exposure += marked > 0 ? gross / marked : 0;
    high = Math.max(high, equity);
    drawdown = Math.max(drawdown, 1 - equity / high);
    heldDays++;
  }
  const mean = moves.reduce((sum, n) => sum + n, 0) / moves.length;
  const error = Math.sqrt(moves.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (moves.length - 1) / moves.length);
  return { net: equity - 1, drawdown, rebalances, changes, fundingPaid, costsPaid, depleted,
    score: error ? mean / error : 0, exposure: heldDays ? exposure / heldDays : 0 };
}

async function main() {
  const market: StudySeries[] = [], unavailable: string[] = [];
  const loaded = await Promise.allSettled(SWING_COINS.map(async symbol => ({ symbol, data: await swingData(symbol) })));
  for (const [i, row] of loaded.entries()) {
    if (row.status === 'fulfilled') market.push(row.value);
    else unavailable.push(SWING_COINS[i]);
  }
  const btc = market.find(row => row.symbol === 'BTC')?.data;
  if (!btc || market.length < 5) throw new Error('Insufficient complete perpetual series.');
  const benchmark = windows.map(window => evaluate(market, btc, window, feeRates[1]));
  const variants: Rule[] = (['slope', 'channel'] as const).flatMap(signal => [42, 84, 126].flatMap(days =>
    [.28, .45].flatMap(annualVol => [false, true].map(short => ({ signal, days, annualVol, short })))));
  const earlier = variants.map(rule => {
    const discovery = evaluate(market, btc, windows[0], feeRates[0], rule), validation = evaluate(market, btc, windows[1], feeRates[1], rule);
    return { rule, discovery, validation, rank: Math.min(discovery.score, validation.score) };
  }).sort((a, b) => b.rank - a.rank);
  const qualified = earlier.filter(row => [row.discovery, row.validation].every((x, i) => x.net > 0 && x.score >= 1.25 &&
    x.drawdown <= .65 * benchmark[i].drawdown && x.changes >= 12));
  const finalists = (['slope', 'channel'] as const).flatMap(family => {
    const pick = qualified.find(row => row.rule.signal === family);
    if (!pick) return [];
    const holdout = evaluate(market, btc, windows[2], feeRates[0], pick.rule);
    const stressed = evaluate(market, btc, windows[2], feeRates[1], pick.rule);
    const passed = stressed.net > 0 && stressed.score >= 2 && stressed.changes >= 12 &&
      stressed.drawdown <= .65 * benchmark[2].drawdown && stressed.score >= benchmark[2].score;
    return [{ ...pick, holdout, stressed, passed }];
  });
  const separate = market.flatMap(asset => {
    const bench = windows.map(window => evaluate([asset], btc, window, feeRates[1]));
    const rules = variants.map(rule => {
      const discovery = evaluate([asset], btc, windows[0], feeRates[0], rule), validation = evaluate([asset], btc, windows[1], feeRates[1], rule);
      return { rule, discovery, validation, rank: Math.min(discovery.score, validation.score) };
    });
    const chosen = rules.filter(row => [row.discovery, row.validation].every((x, i) => x.net > 0 && x.score >= 1.2 &&
      x.drawdown <= .65 * bench[i].drawdown && x.changes >= 8)).sort((a, b) => b.rank - a.rank)[0];
    if (!chosen) return [];
    const holdout = evaluate([asset], btc, windows[2], feeRates[0], chosen.rule), stressed = evaluate([asset], btc, windows[2], feeRates[1], chosen.rule);
    return [{ symbol: asset.symbol, ...chosen, holdout, stressed, benchmark: bench[2],
      passed: stressed.net > 0 && stressed.changes >= 10 && stressed.score >= 2.5 && stressed.drawdown <= .65 * bench[2].drawdown }];
  });
  const report = { markets: market.map(row => row.symbol), unavailable, variants: variants.length,
    windows: windows.map(window => [new Date(window.from).toISOString().slice(0, 10), new Date(window.to).toISOString().slice(0, 10)]),
    qualified: qualified.length, finalists, separate, benchmark, diagnostics: earlier.slice(0, 3) };
  writeFileSync(join(process.cwd(), 'backtest', 'crypto-weekly-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ markets: report.markets, unavailable, tested: report.variants, finalists, separate,
    benchmark: benchmark[2], strongestEarlier: report.diagnostics[0] }));
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
