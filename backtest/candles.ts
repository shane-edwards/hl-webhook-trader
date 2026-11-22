// Candle loader with volume, cached on disk (not committed; fetched on demand).
// Used by the newer studies. `npx tsx backtest/candles.ts` pre-downloads everything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'backtest', 'data', 'intraday');
const MS = { '5m': 300_000, '15m': 900_000, '1h': 3_600_000 } as const;
export type Timeframe = keyof typeof MS;

export interface Bars { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; ms: number }

/** The large coins of mid-2020, fixed in advance (includes ones that later did badly). */
export const UNIVERSE = ['BTC', 'ETH', 'XRP', 'LTC', 'BCH', 'BNB', 'EOS', 'XLM', 'ADA', 'TRX', 'LINK', 'XTZ', 'ATOM', 'ETC', 'DOGE', 'DASH', 'ZEC', 'NEO', 'IOTA', 'VET', 'ALGO', 'SOL'];
export const MAJORS = ['BTC', 'ETH', 'SOL'];

export async function loadBars(coin: string, tf: Timeframe): Promise<Bars | null> {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, `${coin.toLowerCase()}-${tf}-v.csv`);
  if (!existsSync(file)) {
    const rows: string[] = [];
    let startTime = Date.UTC(2020, 0, 1);
    for (;;) {
      let page: Array<[number, string, string, string, string, string]> | null = null;
      for (let attempt = 0; attempt < 5 && !page; attempt++) {
        try {
          const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${coin}USDT&interval=${tf}&limit=1000&startTime=${startTime}`);
          if (res.status === 400) return null; // pair does not exist
          if (res.ok) page = await res.json();
        } catch { /* retry */ }
        if (!page) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      }
      if (!page) throw new Error(`Could not download ${coin} ${tf}`);
      if (!page.length) break;
      for (const k of page) rows.push(`${k[0]},${+k[1]},${+k[2]},${+k[3]},${+k[4]},${+k[5]}`);
      if (page.length < 1000) break;
      startTime = page[page.length - 1][0] + MS[tf];
    }
    rows.pop(); // the bar still forming
    if (rows.length < 5000) return null;
    writeFileSync(file, rows.join('\n') + '\n');
  }
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [], ms: MS[tf] };
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const [t, o, h, l, c, v] = line.split(',').map(Number);
    b.t.push(t); b.o.push(o); b.h.push(h); b.l.push(l); b.c.push(c); b.v.push(v);
  }
  return b;
}

/** Merge bars into `factor`-times-longer bars aligned to UTC. Incomplete groups are dropped. */
export function aggregate(src: Bars, factor: number): Bars {
  const ms = src.ms * factor;
  const out: Bars = { t: [], o: [], h: [], l: [], c: [], v: [], ms };
  let n = 0;
  const dropLast = () => { for (const k of ['t', 'o', 'h', 'l', 'c', 'v'] as const) out[k].pop(); };
  for (let i = 0; i < src.t.length; i++) {
    const bucket = Math.floor(src.t[i] / ms) * ms;
    const k = out.t.length - 1;
    if (k < 0 || out.t[k] !== bucket) {
      if (k >= 0 && n < factor) dropLast();
      out.t.push(bucket); out.o.push(src.o[i]); out.h.push(src.h[i]); out.l.push(src.l[i]); out.c.push(src.c[i]); out.v.push(src.v[i]); n = 1;
    } else {
      out.h[k] = Math.max(out.h[k], src.h[i]); out.l[k] = Math.min(out.l[k], src.l[i]); out.c[k] = src.c[i]; out.v[k] += src.v[i]; n++;
    }
  }
  if (out.t.length && n < factor) dropLast();
  return out;
}

// Pre-download when run directly.
if (process.argv[1]?.endsWith('candles.ts')) {
  (async () => {
    for (const c of UNIVERSE) { const b = await loadBars(c, '1h'); console.log(c, '1h', b ? b.t.length : 'unavailable'); }
    for (const c of MAJORS) for (const tf of ['15m', '5m'] as const) { const b = await loadBars(c, tf); console.log(c, tf, b ? b.t.length : 'unavailable'); }
  })().catch(e => { console.error(e); process.exit(1); });
}
