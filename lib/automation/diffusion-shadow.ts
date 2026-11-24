import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import type { Bar } from '@/lib/autopilot/strategies';
import { CRYPTO_RESEARCH_SYMBOLS } from './model';

const FRAME = 900_000;
const HOUR = 3_600_000;
const HISTORY = 14 * 24 * 4;
const HOLD = 24 * HOUR;
const COST = .0015;
const STOP_COST = .0007;
const DRIVERS = ['XRP', 'DOGE', 'TRX'];
const VERSION = 'retail-flow-v1';
export const DIFFUSION_STRATEGY = 'retail_flow_continuation';
type Db = ReturnType<typeof createServiceClient>;
type SpotBar = { t: number; c: number };
type SignalRow = { symbol: string; entry_after: string; settle_after: string; signal_bar: string; stop_pct: number };

export function standardizedMove(bars: SpotBar[], last: number, history = HISTORY) {
  const start = bars.length - history - 3;
  if (start < 0 || bars.at(-1)?.t !== last || bars.slice(start).some((bar, i) =>
    !(bar.c > 0) || bar.t !== last - (bars.length - 1 - start - i) * FRAME)) return null;
  let square = 0;
  for (let i = start + 2; i < bars.length - 1; i++) square += Math.log(bars[i].c / bars[i - 2].c) ** 2;
  const deviation = Math.sqrt(square / history);
  return deviation > 0 ? Math.log(bars.at(-1)!.c / bars.at(-3)!.c) / deviation : null;
}

export function settleDiffusion(entryTime: number, stopPct: number, history: Bar[], rates: Map<number, number>) {
  const prices = new Map(history.map(bar => [bar.t, bar]));
  const opening = prices.get(entryTime);
  if (!opening || !(opening.o > 0)) return null;
  const entry = opening.o * (1 + COST);
  const stop = entry * (1 - stopPct);
  let funding = 0;
  for (let time = entryTime; time <= entryTime + HOLD; time += FRAME) {
    const bar = prices.get(time);
    if (!bar) return null;
    if (time > entryTime && time % HOUR === 0) {
      const rate = rates.get(time);
      if (rate === undefined || !Number.isFinite(rate)) return null;
      funding += rate * bar.o / entry;
    }
    const timed = time === entryTime + HOLD;
    const stopped = timed ? bar.o < stop : bar.l <= stop;
    if (!timed && !stopped) continue;
    const bid = (timed ? bar.o : Math.min(stop, bar.o)) * (1 - COST - (stopped ? STOP_COST : 0));
    const net = bid / entry - 1 - funding;
    return { pnlUsd: 1000 * net, netBps: 10_000 * net, closedAt: new Date(time).toISOString(), exit: stopped ? 'Modeled stop' : '24-hour exit' };
  }
  return null;
}

async function spotMove(symbol: string, last: number) {
  const start = last - (HISTORY + 2) * FRAME;
  const candles = await Promise.all([start, start + 1000 * FRAME].map(async from => {
    const end = Math.min(last, from + 999 * FRAME);
    const query = new URLSearchParams({ symbol: `${symbol}USDT`, interval: '15m', startTime: String(from), endTime: String(end), limit: '1000' });
    const response = await fetch(`https://data-api.binance.vision/api/v3/klines?${query}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Binance flow input unavailable for ${symbol}`);
    const rows: Array<Array<string | number>> = await response.json();
    return rows.map(row => ({ t: Number(row[0]), c: Number(row[4]) }));
  }));
  const move = standardizedMove(candles.flat(), last);
  if (move === null) throw new Error(`Incomplete spot history for ${symbol}`);
  return move;
}

export async function watchDiffusion(db: Db, now: number) {
  const account = await db.from('automation_profiles').select('market').eq('market', 'crypto').eq('enabled', true).limit(1);
  if (account.error) throw new Error('Could not read research settings.');
  if (!account.data.length) return { scanned: false, signals: 0, settled: 0 };
  const anchor = Math.floor(now / FRAME) * FRAME;
  const signal = anchor - FRAME;
  const entry = anchor + FRAME;
  const hl = marketDataClient();
  const pending = await db.from('automation_crypto_shadow').select('symbol,entry_after,settle_after,signal_bar,stop_pct').eq('version', VERSION)
    .eq('decision', 'qualified').is('outcome', null).lte('settle_after', new Date(now).toISOString()).order('settle_after').limit(12);
  if (pending.error) throw new Error('Could not read retail-flow forward tests.');
  let settled = 0;
  for (const row of pending.data as SignalRow[]) {
    const entryTime = Date.parse(row.entry_after), end = Date.parse(row.settle_after);
    const [bars, funding] = await Promise.all([hl.getCandles(row.symbol, '15m', entryTime, end), hl.getFundingRates(row.symbol, entryTime, end)]);
    const outcome = settleDiffusion(entryTime, row.stop_pct, bars, new Map(funding.map(item => [Math.round(item.time / HOUR) * HOUR, item.rate])));
    if (!outcome && now - end < 48 * HOUR) continue;
    const saved = await db.from('automation_crypto_shadow').update({ outcome: outcome ?? { exit: 'Incomplete Hyperliquid data' } })
      .match({ version: VERSION, strategy: DIFFUSION_STRATEGY, symbol: row.symbol, signal_bar: row.signal_bar }).is('outcome', null);
    if (saved.error) throw new Error('Could not record the retail-flow outcome.');
    if (outcome) settled++;
  }
  const drivers = await Promise.all(DRIVERS.map(symbol => spotMove(symbol, signal)));
  const impulse = drivers.reduce((a, b) => a + b, 0) / drivers.length;
  if (impulse < 2.5) return { scanned: true, signals: 0, settled };
  const active = await db.from('automation_crypto_shadow').select('symbol').eq('version', VERSION).eq('decision', 'qualified')
    .gt('settle_after', new Date(now).toISOString());
  if (active.error) throw new Error('Could not read open retail-flow observations.');
  const observed = await Promise.all(CRYPTO_RESEARCH_SYMBOLS.filter(symbol => !active.data.some(row => row.symbol === symbol)).map(async symbol => {
    const move = await spotMove(symbol, signal);
    if (move > impulse * .6) return null;
    const candles = (await hl.getCandles(symbol, '15m', anchor - 97 * FRAME, anchor)).filter(bar => bar.t < anchor);
    if (candles.length !== 97 || candles.some((bar, i) => bar.t !== anchor - (97 - i) * FRAME)) return null;
    const range = candles.slice(1).reduce((total, bar, i) => {
      const close = candles[i].c;
      return total + Math.max(bar.h - bar.l, Math.abs(bar.h - close), Math.abs(bar.l - close)) / close;
    }, 0) / 96;
    if (!Number.isFinite(range) || range <= 0) return null;
    return { version: VERSION, strategy: DIFFUSION_STRATEGY, symbol, decision: 'qualified',
      detail: 'Retail coin rally with a lagging major. Modeled Hyperliquid fill after one full 15-minute bar.',
      signal_bar: new Date(signal).toISOString(), observed_at: new Date().toISOString(), entry_after: new Date(entry).toISOString(),
      settle_after: new Date(entry + HOLD + FRAME).toISOString(), stop_pct: Math.max(.03, Math.min(.13, 14 * range)),
      assumed_slippage_bps: COST * 10_000 };
  }));
  const rows = observed.filter(row => row !== null).filter(row => Date.parse(row.observed_at) < entry);
  if (rows.length) {
    const written = await db.from('automation_crypto_shadow').upsert(rows,
      { onConflict: 'version,symbol,strategy,signal_bar', ignoreDuplicates: true });
    if (written.error) throw new Error('Could not save retail-flow research observations.');
  }
  return { scanned: true, signals: rows.length, settled };
}
