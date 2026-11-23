const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// https://www.nyse.com/trade/hours-calendars
const holidays: Record<string, readonly string[]> = {
  '2026': ['01-01', '01-19', '02-16', '04-03', '05-25', '06-19', '07-03', '09-07', '11-26', '12-25'],
  '2027': ['01-01', '01-18', '02-15', '03-26', '05-31', '06-18', '07-05', '09-06', '11-25', '12-24'],
  '2028': ['01-17', '02-21', '04-14', '05-29', '06-19', '07-04', '09-04', '11-23', '12-25'],
};
const halfDays = new Set(['2026-11-27', '2026-12-24', '2027-11-26', '2028-07-03', '2028-11-24']);

export function stockMarketClock(now: number) {
  const t = Object.fromEntries(clock.formatToParts(now).map(part => [part.type, part.value]));
  const md = `${t.month}-${t.day}`;
  const day = `${t.year}-${md}`;
  const weekday = t.weekday !== 'Sat' && t.weekday !== 'Sun';
  const tradingDay = weekday && !!holidays[t.year] && !holidays[t.year].includes(md);
  const minutes = Number(t.hour) * 60 + Number(t.minute);
  const close = halfDays.has(day) ? 780 : 960;
  return { day, tradingDay, open: tradingDay && minutes >= 570 && minutes < close, minutes, close };
}

export function previousStockSession(now: number) {
  for (let offset = 1; offset <= 7; offset++) {
    const session = stockMarketClock(now - offset * 86_400_000);
    if (session.tradingDay) return session.day;
  }
  return null;
}

export function freshStockAsk(quote: { date: string | null; bid: number | null; ask: number | null; quoteType?: string | null } | undefined, now: number) {
  if (!quote?.date || quote.bid == null || quote.ask == null || quote.quoteType !== 'realtime') return null;
  const quoted = Date.parse(quote.date);
  const age = now - quoted;
  const session = stockMarketClock(now);
  if (!session.open || !Number.isFinite(age) || age < -5000 || age > 60_000 || !stockMarketClock(quoted).open || session.day !== stockMarketClock(quoted).day
    || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) return null;
  return quote.ask;
}
