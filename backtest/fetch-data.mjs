// Downloads the datasets the backtests use. Re-run to refresh.
//   node backtest/fetch-data.mjs
// - BTC/USD daily OHLC from Bitstamp (long history, spot)
// - Daily OHLC for a basket of large coins from Binance spot (USDT pairs)
// - Funding rates from Hyperliquid (the venue this app trades on), summed per UTC day
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Basket for the multi-asset tests. These are coins that are large *today*,
// which flatters any backtest (the ones that died are missing).
export const BASKET = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC'];

async function getJson(url, init, attempt = 0) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 5) throw err;
    await sleep(1000 * 2 ** attempt);
    return getJson(url, init, attempt + 1);
  }
}

const day = ms => new Date(ms).toISOString().slice(0, 10);
const todayStartMs = () => Math.floor(Date.now() / 86_400_000) * 86_400_000;

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
  return [...rows.values()]
    .filter(c => Number(c.timestamp) * 1000 < todayStartMs())
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .map(c => [day(Number(c.timestamp) * 1000), c.open, c.high, c.low, c.close, c.volume]);
}

async function fetchBinanceDaily(symbol) {
  const rows = new Map();
  let startTime = Date.UTC(2017, 0, 1);
  for (;;) {
    const page = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&startTime=${startTime}`);
    if (!page.length) break;
    for (const k of page) rows.set(k[0], k);
    const last = page[page.length - 1][0];
    if (page.length < 1000) break;
    startTime = last + 86_400_000;
    await sleep(120);
  }
  return [...rows.values()]
    .filter(k => k[0] < todayStartMs())
    .sort((a, b) => a[0] - b[0])
    .map(k => [day(k[0]), +k[1], +k[2], +k[3], +k[4], +k[5]]);
}

async function fetchHlFundingDaily(coin) {
  const byDay = new Map();
  let startTime = Date.UTC(2023, 0, 1);
  for (;;) {
    const page = await getJson('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin, startTime }),
    });
    if (!page.length) break;
    for (const f of page) {
      const cur = byDay.get(day(f.time)) ?? { sum: 0, n: 0 };
      cur.sum += Number(f.fundingRate);
      cur.n += 1;
      byDay.set(day(f.time), cur);
    }
    if (page.length < 500) break;
    startTime = page[page.length - 1].time + 1;
    await sleep(120);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function writeCsv(name, header, rows) {
  writeFileSync(join(DATA_DIR, name), header + '\n' + rows.map(r => r.join(',')).join('\n') + '\n');
}

const btc = await fetchBitstampDaily(Date.UTC(2012, 0, 1) / 1000);
writeCsv('btcusd-daily-bitstamp.csv', 'date,open,high,low,close,volume', btc);
console.log(`BTC (Bitstamp): ${btc.length} days`);

for (const coin of BASKET) {
  const candles = await fetchBinanceDaily(`${coin}USDT`);
  writeCsv(`${coin.toLowerCase()}usdt-daily-binance.csv`, 'date,open,high,low,close,volume', candles);
  const funding = await fetchHlFundingDaily(coin);
  writeCsv(
    `${coin.toLowerCase()}-funding-daily-hyperliquid.csv`,
    'date,funding_rate_sum,hours',
    funding.map(([d, v]) => [d, v.sum.toFixed(10), v.n])
  );
  console.log(`${coin}: ${candles.length} days from ${candles[0]?.[0]}, funding ${funding.length} days from ${funding[0]?.[0]}`);
}
