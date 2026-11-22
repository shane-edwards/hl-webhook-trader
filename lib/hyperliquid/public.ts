// Read-only Hyperliquid data that needs no key: the market overview and an
// account's own history as the exchange recorded it.

const MAINNET_URL = 'https://api.hyperliquid.xyz';
const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';
const HOURS_PER_YEAR = 24 * 365;

async function info<T>(body: unknown, isTestnet = false): Promise<T> {
  const res = await fetch(`${isTestnet ? TESTNET_URL : MAINNET_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Hyperliquid info error ${res.status}: ${await res.text()}`);
  return res.json();
}

const num = (v: unknown): number => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
};

export interface Market {
  coin: string;
  price: number;
  /** 24h price change as a fraction. */
  change24h: number;
  /** Current hourly funding rate (longs pay shorts when positive). */
  fundingHourly: number;
  /** The hourly rate annualised, as a fraction (0.11 = 11%/yr). */
  fundingAnnual: number;
  /** Perp price relative to the oracle (spot) price, as a fraction. */
  premium: number;
  openInterestUsd: number;
  volume24hUsd: number;
  maxLeverage: number;
}

export async function getMarkets(): Promise<Market[]> {
  const [meta, ctxs] = await info<[{ universe: Array<Record<string, unknown>> }, Array<Record<string, unknown>>]>({
    type: 'metaAndAssetCtxs',
  });
  const out: Market[] = [];
  meta.universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || asset.isDelisted) return;
    const price = num(ctx.markPx);
    const prev = num(ctx.prevDayPx);
    if (!(price > 0)) return;
    const fundingHourly = num(ctx.funding);
    out.push({
      coin: String(asset.name),
      price,
      change24h: prev > 0 ? price / prev - 1 : 0,
      fundingHourly,
      fundingAnnual: fundingHourly * HOURS_PER_YEAR,
      premium: num(ctx.premium),
      openInterestUsd: num(ctx.openInterest) * price,
      volume24hUsd: num(ctx.dayNtlVlm),
      maxLeverage: num(asset.maxLeverage),
    });
  });
  return out;
}

export interface SeriesPoint { t: number; v: number }

export interface AccountHistory {
  /** Account value over time as the exchange recorded it. */
  equity: SeriesPoint[];
  /** Cumulative profit and loss over the period (deposits and withdrawals excluded). */
  pnl: SeriesPoint[];
  volumeUsd: number;
}

export interface AccountTruth {
  periods: Record<'day' | 'week' | 'month' | 'allTime', AccountHistory>;
  /** Last 30 days, straight from the exchange's fill and funding records. */
  last30d: {
    fees: number;
    /** Net funding: negative means paid. */
    funding: number;
    realizedPnl: number;
    fills: number;
    /** True if the fill list hit the API's page limit, so fees/realised P&L are a lower bound. */
    truncated: boolean;
  };
}

const PERIODS = ['day', 'week', 'month', 'allTime'] as const;
const FILL_PAGE_LIMIT = 2000;

export async function getAccountTruth(address: string, isTestnet: boolean): Promise<AccountTruth> {
  const startTime = Date.now() - 30 * 86_400_000;
  const [portfolio, fills, funding] = await Promise.all([
    info<Array<[string, { accountValueHistory?: Array<[number, string]>; pnlHistory?: Array<[number, string]>; vlm?: string }]>>(
      { type: 'portfolio', user: address }, isTestnet),
    info<Array<{ fee?: string; closedPnl?: string }> | null>({ type: 'userFillsByTime', user: address, startTime }, isTestnet),
    info<Array<{ delta?: { type?: string; usdc?: string } }> | null>({ type: 'userFunding', user: address, startTime }, isTestnet),
  ]);

  const byName = new Map(portfolio ?? []);
  const series = (rows?: Array<[number, string]>): SeriesPoint[] => (rows ?? []).map(([t, v]) => ({ t, v: num(v) }));
  const periods = {} as AccountTruth['periods'];
  for (const p of PERIODS) {
    const d = byName.get(p);
    periods[p] = { equity: series(d?.accountValueHistory), pnl: series(d?.pnlHistory), volumeUsd: num(d?.vlm) };
  }

  const fillList = fills ?? [];
  return {
    periods,
    last30d: {
      fees: fillList.reduce((a, f) => a + num(f.fee), 0),
      realizedPnl: fillList.reduce((a, f) => a + num(f.closedPnl), 0),
      funding: (funding ?? []).reduce((a, f) => a + (f.delta?.type === 'funding' ? num(f.delta.usdc) : 0), 0),
      fills: fillList.length,
      truncated: fillList.length >= FILL_PAGE_LIMIT,
    },
  };
}
