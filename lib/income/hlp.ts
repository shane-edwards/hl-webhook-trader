// What a deposit in Hyperliquid's HLP vault has earned, from the vault's own public history.
// Read-only: nothing here deposits, withdraws or places an order.

export const HLP_VAULT = '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303';
const DAY = 86_400_000, YEAR = 365 * DAY;

/** The return over one stretch of the vault's history. */
export type Period = { from: number; to: number; ret: number };
type Point = [number, string | number];

/**
 * Period returns from the vault's account value and cumulative profit. Each period's profit is set
 * against the value at its start, so deposits and withdrawals, which move the value but not the
 * profit, drop out. Periods that start with nothing in the vault are skipped.
 */
export function vaultPeriods(accountValue: Point[], cumulativePnl: Point[]): Period[] {
  const pnl = new Map(cumulativePnl.map(([time, value]) => [Number(time), Number(value)]));
  const points = accountValue.map(([time, value]) => ({ time: Number(time), value: Number(value), pnl: pnl.get(Number(time)) }))
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value) && point.pnl != null && Number.isFinite(point.pnl))
    .sort((a, b) => a.time - b.time);
  const out: Period[] = [];
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1], now = points[i];
    if (!(before.value > 0) || now.time <= before.time) continue;
    out.push({ from: before.time, to: now.time, ret: (now.pnl! - before.pnl!) / before.value });
  }
  return out;
}

/** Compounded return of the periods that end after `since`, and the deepest fall from a high within them. */
export function compound(periods: Period[], since = -Infinity) {
  let equity = 1, peak = 1, dip = 0, from: number | null = null, to: number | null = null;
  for (const period of periods) {
    if (period.to <= since) continue;
    from ??= period.from; to = period.to;
    equity *= 1 + period.ret;
    peak = Math.max(peak, equity);
    dip = Math.max(dip, 1 - equity / peak);
  }
  const days = from != null && to != null ? (to - from) / DAY : 0;
  return { total: equity - 1, dip, days, annual: days > 0 ? equity ** (365 / days) - 1 : null };
}

export interface VaultIncome {
  updated: number | null;
  /** Compounded return over the last twelve months of history. */
  year: number | null;
  /** The last 90 days as a yearly rate: where the yield is now. */
  nowAnnual: number | null;
  /** Deepest fall from a high in the last twelve months. Points are about two weeks apart, so shorter dips are not seen. */
  dip: number | null;
  size: number | null;
  sizeYearAgo: number | null;
  years: Array<{ year: number; total: number; partial: boolean }>;
}

export function summariseVault(accountValue: Point[], cumulativePnl: Point[]): VaultIncome {
  const periods = vaultPeriods(accountValue, cumulativePnl);
  const values = accountValue.map(([time, value]) => ({ time: Number(time), value: Number(value) })).filter(p => Number.isFinite(p.value)).sort((a, b) => a.time - b.time);
  const last = periods[periods.length - 1];
  if (!last) return { updated: null, year: null, nowAnnual: null, dip: null, size: values.at(-1)?.value ?? null, sizeYearAgo: null, years: [] };
  const yearBack = compound(periods, last.to - YEAR), recent = compound(periods, last.to - 90 * DAY);
  const ago = values.reduce((best, point) => (Math.abs(point.time - (last.to - YEAR)) < Math.abs(best.time - (last.to - YEAR)) ? point : best), values[0]);
  const first = new Date(periods[0].from).getUTCFullYear(), final = new Date(last.to).getUTCFullYear();
  const years = [];
  for (let year = final; year >= first; year--) {
    const inYear = periods.filter(period => new Date(period.to).getUTCFullYear() === year);
    if (!inYear.length) continue;
    // A year is partial when the history starts or stops inside it.
    const partial = year === final || inYear[0].from > Date.UTC(year, 0, 20);
    years.push({ year, total: compound(inYear).total, partial });
  }
  return {
    updated: last.to,
    // Twelve months is only quoted when the history covers about that long.
    year: yearBack.days >= 330 ? yearBack.total : null,
    nowAnnual: recent.days >= 60 ? recent.annual : null,
    dip: yearBack.dip, size: values.at(-1)?.value ?? null,
    sizeYearAgo: Math.abs(ago.time - (last.to - YEAR)) < 45 * DAY ? ago.value : null, years,
  };
}

export async function readHlpVault(): Promise<VaultIncome> {
  const response = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'vaultDetails', vaultAddress: HLP_VAULT }), next: { revalidate: 3600 }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Vault history ${response.status}`);
  const body = await response.json() as { portfolio?: Array<[string, { accountValueHistory?: Point[]; pnlHistory?: Point[] }]> };
  const history = body.portfolio?.find(([name]) => name === 'allTime')?.[1];
  if (!history?.accountValueHistory?.length || !history.pnlHistory?.length) throw new Error('Vault history is empty');
  return summariseVault(history.accountValueHistory, history.pnlHistory);
}
