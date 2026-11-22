// Downloads the datasets the backtest uses. Re-run to refresh.
//   node backtest/fetch-data.mjs
// - BTC/USD daily OHLC from Bitstamp (long history, spot)
// - BTC hourly funding rates from Hyperliquid (the venue this app trades on)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, init, attempt = 0) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1000 * 2 ** attempt);
    return getJson(url, init, attempt + 1);
  }
}

async function fetchBitstampDaily(startSec) {
  const rows = new Map();
  let start = startSec;
  const nowSec = Math.floor(Date.now() / 1000);
  while (start < nowSec) {
    const url = `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`;
    const { data } = await getJson(url);
    if (!data.ohlc.length) break;
    for (const c of data.ohlc) rows.set(Number(c.timestamp), c);
    const last = Number(data.ohlc[data.ohlc.length - 1].timestamp);
    if (last + 86400 <= start) break;
    start = last + 86400;
    await sleep(250);
  }
  // Drop the still-forming candle for today.
  const todayStart = Math.floor(nowSec / 86400) * 86400;
  return [...rows.values()]
    .filter(c => Number(c.timestamp) < todayStart)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

async function fetchHlFunding(coin) {
  const out = [];
  let startTime = Date.UTC(2023, 0, 1);
  for (;;) {
    const page = await getJson('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin, startTime }),
    });
    if (!page.length) break;
    out.push(...page);
    const last = page[page.length - 1].time;
    if (page.length < 500) break;
    startTime = last + 1;
    await sleep(150);
  }
  return out;
}

const candles = await fetchBitstampDaily(Date.UTC(2012, 0, 1) / 1000);
writeFileSync(
  join(DATA_DIR, 'btcusd-daily-bitstamp.csv'),
  'date,open,high,low,close,volume\n' +
    candles
      .map(c => [new Date(Number(c.timestamp) * 1000).toISOString().slice(0, 10), c.open, c.high, c.low, c.close, c.volume].join(','))
      .join('\n') + '\n'
);
console.log(`candles: ${candles.length}`);

// Aggregate hourly funding into one summed rate per UTC day to keep the file small.
const funding = await fetchHlFunding('BTC');
const byDay = new Map();
for (const f of funding) {
  const day = new Date(f.time).toISOString().slice(0, 10);
  const cur = byDay.get(day) ?? { sum: 0, n: 0 };
  cur.sum += Number(f.fundingRate);
  cur.n += 1;
  byDay.set(day, cur);
}
writeFileSync(
  join(DATA_DIR, 'btc-funding-daily-hyperliquid.csv'),
  'date,funding_rate_sum,hours\n' +
    [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => `${d},${v.sum.toFixed(10)},${v.n}`).join('\n') + '\n'
);
console.log(`funding hours: ${funding.length}, days: ${byDay.size}`);
