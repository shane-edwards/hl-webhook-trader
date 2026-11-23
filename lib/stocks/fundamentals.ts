import { unstable_cache } from 'next/cache';
import type { StockSymbol } from './research';
import type { StockTradeSymbol } from './trade-rules';

export const STOCK_CIK: Partial<Record<StockTradeSymbol, number>> = {
  AAPL: 320193, MSFT: 789019, NVDA: 1045810, AMZN: 1018724, GOOGL: 1652044, META: 1326801,
  TSLA: 1318605, JPM: 19617, XOM: 34088, WMT: 104169, COST: 909832, UNH: 731766,
  AMD: 2488, AVGO: 1730168, BA: 12927, CAT: 18230, LLY: 59478, MU: 723125, PLTR: 1321655,
};
type Fact = { val: number; start?: string; end: string; filed: string; form: string };
type Facts = Record<string, { units: Record<string, Fact[]> }>;

export function annualFundamentals(facts: Facts, price: number, asOf: string) {
  const annual = (tags: string[], unit = 'USD') => tags.flatMap(tag => facts[tag]?.units[unit] ?? [])
    .filter(row => row.form === '10-K' && row.filed <= asOf && row.end <= asOf && row.start &&
      (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000 >= 330 &&
      (Date.parse(row.end) - Date.parse(row.start)) / 86_400_000 <= 390 && Number.isFinite(row.val))
    .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed));
  const revenues = annual(['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax']);
  const revenue = revenues[0];
  if (!revenue || revenue.val <= 0 || Date.parse(asOf) - Date.parse(revenue.end) > 490 * 86_400_000) return null;
  const prior = revenues.find(row => {
    const days = (Date.parse(revenue.end) - Date.parse(row.end)) / 86_400_000;
    return days >= 330 && days <= 400;
  });
  const sameYear = (tags: string[], unit?: string) => annual(tags, unit).find(row => row.end === revenue.end && row.start === revenue.start)?.val ?? null;
  const operatingIncome = sameYear(['OperatingIncomeLoss']);
  const netIncome = sameYear(['NetIncomeLoss']);
  const cash = sameYear(['NetCashProvidedByUsedInOperatingActivities']);
  const capex = sameYear(['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']);
  const eps = sameYear(['EarningsPerShareDiluted'], 'USD/shares');
  return {
    fiscalEnd: revenue.end,
    revenueGrowth: prior && prior.val > 0 ? revenue.val / prior.val - 1 : null,
    operatingMargin: operatingIncome == null ? null : operatingIncome / revenue.val,
    netMargin: netIncome == null ? null : netIncome / revenue.val,
    freeCashFlowMargin: cash == null || capex == null ? null : (cash - capex) / revenue.val,
    annualPE: eps != null && eps > 0 ? price / eps : null,
  };
}

const fetchFacts = unstable_cache(async (id: number) => {
  const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(id).padStart(10, '0')}.json`, {
    headers: { 'User-Agent': process.env.SEC_USER_AGENT || 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) throw new Error(`SEC returned ${r.status}`);
  const data = (await r.json()) as { facts?: { 'us-gaap'?: Facts } };
  // Cache only the facts the scanner uses, keeping the cache entry bounded.
  const tags = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'OperatingIncomeLoss', 'NetIncomeLoss', 'NetCashProvidedByUsedInOperatingActivities', 'PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'EarningsPerShareDiluted'];
  return Object.fromEntries(Object.entries(data.facts?.['us-gaap'] ?? {}).filter(([tag]) => tags.includes(tag)));
}, ['sec-stock-annual-v1'], { revalidate: 86_400 });

export async function getFundamentals(symbol: StockSymbol, price: number, asOf: string) {
  const id = STOCK_CIK[symbol];
  if (!id) return null;
  try { return annualFundamentals(await fetchFacts(id), price, asOf); }
  catch { return null; }
}
