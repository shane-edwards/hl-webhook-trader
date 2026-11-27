// Funding-rate gaps between Hyperliquid, Binance and Bybit perps. Record-only research: nothing here
// places an order. Pure functions, so the arithmetic is unit tested without a database or network.

export const VENUES = ['hl', 'binance', 'bybit'] as const;
export type Venue = typeof VENUES[number];
export const VENUE_NAMES: Record<Venue, string> = { hl: 'Hyperliquid', binance: 'Binance', bybit: 'Bybit' };

const FEED_NAMES: Record<string, Venue> = { HlPerp: 'hl', BinPerp: 'binance', BybitPerp: 'bybit' };

/** Base-tier taker fee per fill, as a fraction of notional. */
export const TAKER_FEE: Record<Venue, number> = { hl: 0.00045, binance: 0.0005, bybit: 0.00055 };

export const SCAN_MINUTES = 5;
export const SCAN_MS = SCAN_MINUTES * 60_000;
export const SCAN_SYMBOLS = 40;
export const KEEP_DAYS = 30;
/** A market quieter than this on Hyperliquid is not worth recording. */
export const MIN_DAY_VOLUME_USD = 1_000_000;

export const PAIRS = [['hl', 'binance'], ['hl', 'bybit'], ['binance', 'bybit']] as const;

export type HourlyRates = Partial<Record<Venue, number>>;

export interface ScanRow {
  symbol: string;
  hl_rate: number | null;
  binance_rate: number | null;
  bybit_rate: number | null;
  /** Hyperliquid's impact bid-to-ask width as a fraction of the mid price. */
  hl_spread: number | null;
  hl_volume: number;
}

const finite = (value: unknown) => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * Hyperliquid's `predictedFundings` feed as funding per hour for each venue. A venue is left out
 * when its rate or its funding interval is missing, so a gap is never built from a guess.
 */
export function parsePredictedFundings(raw: unknown): Map<string, HourlyRates> {
  const out = new Map<string, HourlyRates>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) continue;
    const rates: HourlyRates = {};
    for (const quote of entry[1]) {
      if (!Array.isArray(quote) || !quote[1] || typeof quote[1] !== 'object') continue;
      const venue = FEED_NAMES[String(quote[0])];
      const info = quote[1] as Record<string, unknown>;
      const rate = finite(info.fundingRate), hours = finite(info.fundingIntervalHours);
      if (!venue || rate == null || hours == null || hours <= 0) continue;
      rates[venue] = rate / hours;
    }
    if (Object.keys(rates).length) out.set(entry[0], rates);
  }
  return out;
}

/** The rows one scan records: the busiest Hyperliquid markets that at least one other venue also lists. */
export function buildScanRows(predicted: unknown, contexts: unknown, limit = SCAN_SYMBOLS): ScanRow[] {
  const rates = parsePredictedFundings(predicted);
  if (!Array.isArray(contexts) || !Array.isArray(contexts[1])) return [];
  const universe = (contexts[0] as { universe?: unknown })?.universe;
  if (!Array.isArray(universe)) return [];
  const rows: ScanRow[] = [];
  universe.forEach((asset, index) => {
    const meta = asset as { name?: unknown; isDelisted?: unknown };
    const ctx = contexts[1][index] as Record<string, unknown> | undefined;
    if (typeof meta?.name !== 'string' || meta.isDelisted === true || !ctx) return;
    const quoted = rates.get(meta.name);
    if (!quoted || quoted.hl == null || (quoted.binance == null && quoted.bybit == null)) return;
    const volume = finite(ctx.dayNtlVlm);
    if (volume == null || volume < MIN_DAY_VOLUME_USD) return;
    const impact = Array.isArray(ctx.impactPxs) ? ctx.impactPxs.map(finite) : [];
    const [bid, ask] = impact;
    const spread = bid != null && ask != null && bid > 0 && ask >= bid ? (ask - bid) / ((ask + bid) / 2) : null;
    rows.push({ symbol: meta.name, hl_rate: quoted.hl, binance_rate: quoted.binance ?? null, bybit_rate: quoted.bybit ?? null,
      hl_spread: spread, hl_volume: volume });
  });
  return rows.sort((a, b) => b.hl_volume - a.hl_volume || a.symbol.localeCompare(b.symbol)).slice(0, limit);
}

/**
 * What opening and later closing both legs costs, as a fraction of notional: a taker fee on all four
 * fills, and one spread crossed per leg. Only Hyperliquid's spread is measured; the other venue is
 * assumed to be as wide, which flatters thin markets on the other venue.
 */
export function roundTripCost(a: Venue, b: Venue, hlSpread: number | null) {
  const spread = hlSpread ?? 0;
  return 2 * (TAKER_FEE[a] + TAKER_FEE[b]) + 2 * spread;
}

/** One row of `funding_gap_summary`: averages over the scans in the window. */
export interface SummaryRow {
  symbol: string;
  scans: number;
  hl_spread: number | null;
  hl_volume: number | null;
  hl_binance_n: number; hl_binance_gap: number | null; hl_binance_above: number | null;
  hl_bybit_n: number; hl_bybit_gap: number | null; hl_bybit_above: number | null;
  binance_bybit_n: number; binance_bybit_gap: number | null; binance_bybit_above: number | null;
}

export interface GapResult {
  symbol: string;
  /** Receive funding here: short the venue that pays more. */
  short: Venue;
  long: Venue;
  scans: number;
  hoursObserved: number;
  /** Average funding difference per hour over the window, with the direction held fixed. */
  gapHourly: number;
  annualPct: number;
  /** Share of scans where the difference had the same sign as its average. */
  consistency: number;
  cost: number;
  /** Hours of the average gap needed to pay for the round trip. */
  breakEvenHours: number;
  /** Funding collected over the observed hours minus one round trip, as a fraction of notional. */
  netOverWindow: number;
  hlSpread: number | null;
  hlVolume: number | null;
  /** The same pair's difference in the latest scan, signed in the direction above. Null when a venue dropped out. */
  nowHourly: number | null;
}

const rateOf = (row: ScanRow, venue: Venue) => venue === 'hl' ? row.hl_rate : venue === 'binance' ? row.binance_rate : row.bybit_rate;

/**
 * The best venue pair per market, judged on the average signed difference rather than the best
 * pair of each scan: a position cannot swap venues every five minutes, so only a gap that keeps
 * its direction is collectable.
 */
export function summariseGaps(summary: SummaryRow[], latest: ScanRow[] = [], minScans = 12): GapResult[] {
  const current = new Map(latest.map(row => [row.symbol, row]));
  const out: GapResult[] = [];
  for (const row of summary) {
    let best: GapResult | null = null;
    for (const [a, b] of PAIRS) {
      const key = `${a}_${b}` as 'hl_binance' | 'hl_bybit' | 'binance_bybit';
      const n = Number(row[`${key}_n`]), gap = finite(row[`${key}_gap`]), above = finite(row[`${key}_above`]);
      if (!(n >= minScans) || gap == null || above == null || gap === 0) continue;
      // A positive average means `a` pays more: short `a`, long `b`.
      const [short, long] = gap > 0 ? [a, b] : [b, a];
      const gapHourly = Math.abs(gap);
      const hoursObserved = n * SCAN_MINUTES / 60;
      const spread = finite(row.hl_spread);
      const cost = roundTripCost(a, b, spread);
      const now = current.get(row.symbol);
      const shortNow = now ? rateOf(now, short) : null, longNow = now ? rateOf(now, long) : null;
      const result: GapResult = {
        symbol: row.symbol, short, long, scans: n, hoursObserved, gapHourly, annualPct: gapHourly * 24 * 365 * 100,
        consistency: gap > 0 ? above : 1 - above, cost, breakEvenHours: cost / gapHourly,
        netOverWindow: gapHourly * hoursObserved - cost, hlSpread: spread, hlVolume: finite(row.hl_volume),
        nowHourly: shortNow != null && longNow != null ? shortNow - longNow : null,
      };
      if (!best || result.netOverWindow > best.netOverWindow) best = result;
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => y.netOverWindow - x.netOverWindow || x.symbol.localeCompare(y.symbol));
}
