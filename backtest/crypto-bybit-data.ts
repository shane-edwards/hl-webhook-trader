import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { END, FLOW_MARKETS, FRAME, START } from './crypto-flow-data';
import { HOUR, type Funding } from './price-action-data';

const folder = join('backtest', 'data', 'intraday', 'crypto-bybit');
const origin = 'https://api.bytick.com';
type Candle = { o: number; h: number; l: number; c: number };
type InterestRecord = { timestamp: string; openInterest: string };
type FundingRecord = { fundingRateTimestamp: string; fundingRate: string };

async function page<Row>(path: string, key: string, parameters: Record<string, string | number>) {
  const file = join(folder, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as Row[];
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { retCode: number; retMsg: string; result: { list: Row[] } };
      if (data.retCode !== 0 || !Array.isArray(data.result.list)) throw new Error(data.retMsg);
      writeFileSync(file, JSON.stringify(data.result.list));
      return data.result.list;
    } catch (error) {
      if (attempt === 2) throw new Error(`Bybit ${key} failed: ${String(error)}`);
      await new Promise(resolve => setTimeout(resolve, 900 * (attempt + 1)));
    }
  }
  throw new Error(`Bybit ${key} retries exhausted`);
}

async function byCandleWindow<Row>(symbol: string, size: number, load: (start: number, end: number) => Promise<Row[]>) {
  const step = size * FRAME;
  const requests = Array.from({ length: Math.ceil((END - START) / step) }, (_, i) => START + i * step);
  const rows: Row[] = [];
  for (let i = 0; i < requests.length; i += 4) {
    const responses = await Promise.all(requests.slice(i, i + 4).map(start => load(start, Math.min(END, start + step) - 1)));
    for (const response of responses) rows.push(...response);
  }
  if (!rows.length) throw new Error(`Bybit returned no observations for ${symbol}`);
  return rows;
}

export async function bybitData(coin: string) {
  mkdirSync(folder, { recursive: true });
  const symbol = `${coin}USDT`;
  const candles = new Map<number, Candle>();
  const interest = new Map<number, number>();
  const category = 'linear';
  for (const item of await byCandleWindow(symbol, 1000, (start, end) =>
    page<string[]>('/v5/market/kline', `${symbol}-candle-${start}`, { category, symbol, interval: 15, limit: 1000, start, end }))) {
    const [t, o, h, l, c] = item.map(Number);
    if ([t, o, h, l, c].every(Number.isFinite) && t >= START && t < END && o > 0 && c > 0 && l > 0 &&
      h >= Math.max(o, c) && l <= Math.min(o, c)) candles.set(t, { o, h, l, c });
  }
  for (const row of await byCandleWindow(symbol, 200, (startTime, endTime) =>
    page<InterestRecord>('/v5/market/open-interest', `${symbol}-interest-${startTime}`,
      { category, symbol, intervalTime: '15min', limit: 200, startTime, endTime }))) {
    const t = Number(row.timestamp), value = Number(row.openInterest);
    if (t >= START && t < END && Number.isFinite(value) && value > 0) interest.set(t, value);
  }
  const rawRates = new Map<number, number>();
  let endTime = END - 1;
  while (endTime >= START) {
    const batch = await page<FundingRecord>('/v5/market/funding/history', `${symbol}-funding-${endTime}`,
      { category, symbol, endTime, limit: 200 });
    const times = batch.map(row => Number(row.fundingRateTimestamp));
    if (!times.length || times.some(t => !Number.isFinite(t) || t > endTime)) throw new Error(`Invalid Bybit funding page for ${symbol}`);
    endTime = Math.min(...times) - 1;
    for (const [i, time] of times.entries()) {
      const rate = Number(batch[i].fundingRate);
      if (!Number.isFinite(rate)) throw new Error(`Invalid Bybit funding rate for ${symbol}`);
      rawRates.set(Math.round(time / HOUR) * HOUR, rate);
    }
  }
  const ordered = [...rawRates].sort(([a], [b]) => a - b);
  const funding: Funding[] = ordered.flatMap(([time, rate], i) => {
    if (time < START || time >= END) return [];
    return [{ time, rate, hours: (time - (ordered[i - 1]?.[0] ?? time - 8 * HOUR)) / HOUR }];
  });
  const expected = (END - START) / FRAME;
  if (candles.size < expected * .99 || interest.size < expected * .99 ||
    !funding.length || funding[0].time - START > 8 * HOUR || END - funding.at(-1)!.time > 8 * HOUR ||
    funding.some(row => row.hours <= 0 || row.hours > 8)) throw new Error(`Incomplete Bybit history for ${symbol}: ${candles.size} candles, ${interest.size} OI`);
  return { candles, interest, funding };
}

if (process.argv[1]?.endsWith('crypto-bybit-data.ts')) void Promise.all(FLOW_MARKETS.map(async coin => {
  const { candles, interest, funding } = await bybitData(coin);
  console.log(`${coin}: ${candles.size} candles, ${interest.size} open interest, ${funding.length} funding`);
})).catch(error => { console.error(error.message); process.exitCode = 1; });
