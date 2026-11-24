import { cryptoContext, DAY } from './context';

type Observation = { timestamp?: string; openInterest?: string; fundingRateTimestamp?: string; fundingRate?: string };

async function observations(symbol: string, start: number, end: number, interest: boolean, deadline: AbortSignal) {
  const rows: Observation[] = [];
  let until = end;
  while (until >= start) {
    const query = new URLSearchParams({ symbol, category: 'linear', startTime: String(start), endTime: String(until), limit: '200' });
    if (interest) query.set('intervalTime', '1d');
    const path = interest ? 'open-interest' : 'funding/history';
    const res = await fetch(`https://api.bytick.com/v5/market/${path}?${query}`,
      { next: { revalidate: 86400 }, signal: AbortSignal.any([deadline, AbortSignal.timeout(4000)]) });
    if (!res.ok) throw new Error('Positioning feed unavailable');
    const body = await res.json();
    if (body.retCode !== 0 || body.result?.category !== 'linear' || !Array.isArray(body.result.list) ||
      (interest && body.result.symbol !== symbol)) throw new Error('Invalid positioning history');
    const page: Observation[] = body.result.list;
    rows.push(...page);
    if (page.length < 200) break;
    const earliest = Math.min(...page.map(r => Number(interest ? r.timestamp : r.fundingRateTimestamp)));
    if (!(earliest >= start && earliest <= until)) throw new Error('Invalid positioning timestamps');
    until = earliest - 1;
  }
  return rows;
}

export async function positioningContext(asset: string, now: number) {
  const symbol = asset + 'USDT';
  const today = Math.floor(now / DAY) * DAY;
  const oi = new Map<number, number>(), funding = new Map<number, number>();
  const date = new Date(today);
  const deadline = AbortSignal.timeout(10_000);
  const months = Array.from({ length: 39 }, (_, i) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 38 + i, 1));
  // Fetch fixed historical windows for cache reuse across timeframes. Missing windows stay missing.
  const tasks = months.flatMap((start, i) => [true, false].map(interest => async () => {
    const end = (months[i + 1] ?? today) - 1;
    if (end < start) return;
    const rows = await observations(symbol, start, end, interest, deadline);
    const settlements = new Map<number, number>();
    for (const row of rows) {
      const t = Number(interest ? row.timestamp : row.fundingRateTimestamp);
      const value = Number(interest ? row.openInterest : row.fundingRate);
      if (!Number.isFinite(value) || !(t >= start && t <= end)) continue;
      if (interest && value > 0) oi.set(Math.floor(t / DAY) * DAY, value);
      if (!interest) settlements.set(t, value);
    }
    for (let day = start; !interest && day <= end; day += DAY) {
      const stamps = [...settlements.keys()].filter(t => t >= day && t < day + DAY).sort((a,b) => a-b);
      if (![3,6,12,24].includes(stamps.length) || stamps.some((t, i) => Math.abs(t - day - i * DAY / stamps.length) > 60_000)) continue;
      funding.set(day, stamps.reduce((total,t) => total + settlements.get(t)!, 0));
    }
  }));
  for (let i = 0; i < tasks.length && !deadline.aborted; i += 8)
    await Promise.allSettled(tasks.slice(i, i+8).map(task => task()));
  return cryptoContext(oi, funding);
}
