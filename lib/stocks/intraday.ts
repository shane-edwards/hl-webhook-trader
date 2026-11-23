import type { IntradayBar } from './etoro';

export const STOCK_INTRADAY_RULES = [
  { id: 'orb', name: '5-minute opening breakout', description: 'Break above the first five-minute high before 10:30 a.m. ET. This is the baseline for the volume filter.', source: 'https://www.tradingview.com/script/Rvy6qSBY-5-Min-ORB-with-Volume-Spike/' },
  { id: 'orb-rvol', name: 'Opening breakout with relative volume', description: 'Same opening breakout, with first-bar volume at least 1.5× the average of the previous 20 opens.', source: 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284' },
  { id: 'vwap', name: 'VWAP reclaim', description: 'After 10:00 a.m. ET, a close reclaims session VWAP above the first bar’s open, with at least 1.5× the prior six bars’ average volume.', source: 'https://www.tradingview.com/script/ROhPgKS9-FlowScope-VWAP-Reclaim-v1-0/' },
  { id: 'close', name: 'SPY final-half-hour momentum', description: 'Buy SPY at 3:30 p.m. ET if its first 30 minutes closed above the previous session’s close. Exit at the same day’s close.', source: 'https://www.sciencedirect.com/science/article/pii/S0304405X18301351', spyOnly: true },
  { id: 'noise', name: 'SPY volatility band breakout', description: 'Check on the half hour. Hold SPY while it closes above session VWAP and a band based on its typical move at that time over the last 14 sessions.', source: 'https://www.sfi.ch/en/publications/n-24-97-beat-the-market-an-effective-intraday-momentum-strategy-for-s-p500-etf-spy', spyOnly: true },
] as const;
export type IntradayRule = typeof STOCK_INTRADAY_RULES[number]['id'];
type Session = { day: string; bars: IntradayBar[] };
type Trade = { day: string; minutes: number; netBps: number; stressBps: number };
const sessionClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fiveMinutes = 300_000;
const notional = 10_000;
// Listed NYSE early closes for the study and recent-replay calendar range.
const shortened = new Set(['2025-07-03', '2025-11-28', '2025-12-24', '2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

export function regularStockSessions(input: IntradayBar[]) {
  const grouped = new Map<string, Map<number, IntradayBar>>();
  for (const bar of input) {
    const parts = Object.fromEntries(sessionClock.formatToParts(bar.t).map(p => [p.type, p.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (minute < 570 || minute >= 960 || minute % 5 !== 0 || bar.t % fiveMinutes !== 0) continue;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (shortened.has(day) || [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue;
    const group = grouped.get(day) ?? new Map<number, IntradayBar>();
    if (group.has(minute)) throw new Error('Duplicate regular-session candle');
    group.set(minute, bar);
    grouped.set(day, group);
  }
  const sessions: Session[] = [];
  for (const [day, group] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.size === 78) sessions.push({ day, bars: [...group.values()].sort((a, b) => a.t - b.t) });
  }
  return { sessions, incomplete: grouped.size - sessions.length };
}

function tradeReturn(buy: number, sell: number, slipBps: number, fee: number) {
  const slippage = slipBps / 10_000;
  const units = (notional - fee) / (buy * (1 + slippage));
  return (units * sell * (1 - slippage) - fee) / notional * 10_000 - 10_000;
}

export function replayStockIntraday(sessions: Session[], rule: IntradayRule, from: string, to: string): Trade[] {
  const trades: Trade[] = [];
  for (let dayIndex = 0; dayIndex < sessions.length; dayIndex++) {
    const { day, bars } = sessions[dayIndex];
    if (day < from || day >= to) continue;
    const first = bars[0];
    const record = (i: number, price: number, minutes: number) => {
      const buy = bars[i].askOpen;
      trades.push({ day, minutes, netBps: tradeReturn(buy, price, 2, 1), stressBps: tradeReturn(buy, price, 5, 2) });
    };
    if (rule === 'close') {
      const previous = sessions[dayIndex - 1];
      if (previous && Date.parse(day) - Date.parse(previous.day) <= 4 * 86_400_000 && bars[5].bidClose > previous.bars[77].bidClose) record(72, bars[77].bidClose, 30);
      continue;
    }

    if (rule === 'noise') {
      const lookback = sessions.slice(Math.max(0, dayIndex - 14), dayIndex);
      if (lookback.length !== 14 || bars.some(b => !Number.isFinite(b.volume) || b.volume <= 0)) continue;
      const anchor = Math.max(first.bidOpen, lookback[13].bars[77].bidClose);
      let weighted = 0, volume = 0, entry: number | undefined;
      for (let i = 0; i < bars.length - 1; i++) {
        const b = bars[i];
        weighted += (b.bidHigh + b.bidLow + b.bidClose) / 3 * b.volume;
        volume += b.volume;
        if ((i + 1) % 6 !== 0) continue;
        const typicalMove = lookback.reduce((sum, s) => sum + Math.abs(s.bars[i].bidClose / s.bars[0].bidOpen - 1), 0) / 14;
        const above = b.bidClose > Math.max(anchor * (1 + typicalMove), weighted / volume);
        if (above && entry == null) entry = i + 1;
        if (!above && entry != null) {
          record(entry, bars[i + 1].bidOpen, (i + 1 - entry) * 5);
          entry = undefined;
        }
      }
      if (entry != null) record(entry, bars[77].bidClose, (78 - entry) * 5);
      continue;
    }

    if (rule === 'orb-rvol') {
      const volumes = sessions.slice(Math.max(0, dayIndex - 20), dayIndex).map(s => s.bars[0].volume);
      if (!Number.isFinite(first.volume) || volumes.length < 20 || volumes.some(v => !Number.isFinite(v) || v <= 0) || first.volume < 1.5 * volumes.reduce((a, b) => a + b, 0) / 20) continue;
    }
    let weighted = 0, sumVolume = 0;
    let vwap = Number.NaN;
    for (let i = 0; i < (rule === 'vwap' ? 30 : 12); i++) {
      const b = bars[i];
      const priorVwap = vwap;
      const volume = Number.isFinite(b.volume) && b.volume > 0 ? b.volume : 0;
      weighted += (b.bidHigh + b.bidLow + b.bidClose) / 3 * volume;
      sumVolume += volume;
      vwap = sumVolume > 0 ? weighted / sumVolume : NaN;
      const recent = rule === 'vwap' && i >= 6 ? bars.slice(i - 6, i) : [];
      const reclaimed = recent.length === 6 && recent.every(x => Number.isFinite(x.volume) && x.volume > 0) &&
        volume >= 1.5 * recent.reduce((sum, x) => sum + x.volume, 0) / 6 && b.bidClose > first.bidOpen &&
        bars[i - 1].bidClose <= priorVwap && b.bidClose > vwap;
      const breakout = i > 0 && bars[i - 1].bidClose <= first.bidHigh && b.bidClose > first.bidHigh;
      if (!(rule === 'vwap' ? reclaimed : breakout)) continue;
      const fill = i + 1;
      const stop = rule === 'vwap' ? b.bidLow : first.bidLow;
      const risk = bars[fill].askOpen - stop;
      if (bars[fill].bidOpen <= stop || risk <= 0) continue;
      const target = bars[fill].askOpen + 1.5 * risk;
      const timeout = fill + 12;
      let exited = false;
      for (let j = fill; j < timeout; j++) {
        const next = bars[j];
        if (next.bidLow <= stop || next.bidHigh >= target) {
          const exit = next.bidLow <= stop ? Math.min(next.bidOpen, stop) : target;
          record(fill, exit, (j - fill + 1) * 5);
          exited = true;
          break;
        }
      }
      if (!exited) record(fill, bars[timeout].bidOpen, 60);
      break;
    }
  }
  return trades;
}

export function summarizeIntraday(byMarket: Trade[][]) {
  const trades = byMarket.flat();
  const total = (xs: Trade[], key: 'netBps' | 'stressBps' | 'minutes') => xs.reduce((sum, t) => sum + t[key], 0);
  // Pool by session day. Simultaneous stock trades are correlated.
  const daily = new Map<string, number>();
  for (const t of trades) daily.set(t.day, (daily.get(t.day) ?? 0) + t.netBps);
  const values = [...daily.values()];
  const avg = values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  const sd = values.length > 1 ? Math.sqrt(values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1)) : 0;
  return {
    trades: trades.length, activeDays: daily.size,
    positiveMarkets: byMarket.filter(ts => total(ts, 'netBps') > 0).length,
    netBps: trades.length ? total(trades, 'netBps') / trades.length : null,
    stressBps: trades.length ? total(trades, 'stressBps') / trades.length : null,
    averageMinutes: trades.length ? total(trades, 'minutes') / trades.length : null,
    tByDay: sd > 0 ? avg / sd * Math.sqrt(values.length) : null,
  };
}
