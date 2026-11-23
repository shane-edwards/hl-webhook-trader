import { CATALYST_INSTRUMENTS, CATALYST_UNIVERSE, type CatalystMarket } from './catalyst-universe';
import { catalystDecision, catalystEntryTime, catalystOpening, catalystSectorMove, type CatalystFiling, type CatalystObservation } from './catalyst';
import type { EtoroClient } from './etoro';
import { freshStockAsk, previousStockSession, stockMarketClock, stockSessionMinute } from './session';

const DAY = 86_400_000;
const MINUTE = 60_000;
const secHeaders = { 'User-Agent': process.env.SEC_USER_AGENT || 'Tideframe Research (https://hl-webhook-trader.vercel.app)', Accept: 'application/json' };
type SecRecent = { form: string[]; items: string[]; acceptanceDateTime: string[]; accessionNumber: string[]; primaryDocDescription?: string[] };

export function openingCatalysts(recent: SecRecent, market: CatalystMarket, first: number, cutoff: number) {
  const filing: CatalystFiling[] = [];
  for (const [i, form] of recent.form.entries()) {
    if (form !== '8-K') continue;
    const at = recent.acceptanceDateTime[i];
    const time = Date.parse(at);
    const accession = recent.accessionNumber[i];
    if (!(time > first && time <= cutoff) || !/^\d{10}-\d{2}-\d{6}$/.test(accession ?? '')) continue;
    const items = recent.items[i]?.split(/[,;]/).map(item => item.trim()) ?? [];
    const kind = items.includes('2.02') ? 'Earnings'
      : items.includes('7.01') && /guidance|business outlook/i.test(recent.primaryDocDescription?.[i] ?? '') ? 'Guidance' : null;
    if (!kind) continue;
    filing.push({ at, accession, kind, url: `https://www.sec.gov/Archives/edgar/data/${market.cik}/${accession.replaceAll('-', '')}/${accession}-index.html` });
  }
  return filing.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

async function getFiling(market: CatalystMarket, earliest: number, cutoff: number) {
  const response = await fetch(`https://data.sec.gov/submissions/CIK${String(market.cik).padStart(10, '0')}.json`, {
    headers: secHeaders, signal: AbortSignal.timeout(4500), next: { revalidate: 240 },
  });
  if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
  const { filings } = await response.json() as { filings: { recent: SecRecent } };
  return openingCatalysts(filings.recent, market, earliest, cutoff);
}

export function catalystWindow(now: number) {
  const clock = stockMarketClock(now);
  return clock.open && clock.minutes >= 587 && clock.minutes < 596;
}

export async function readCatalystFilings(day: string) {
  const open = stockSessionMinute(day, 570);
  const prior = previousStockSession(open);
  if (!prior) throw new Error('Previous US session is unavailable');
  const priorClock = stockMarketClock(stockSessionMinute(prior, 570));
  const earliest = stockSessionMinute(prior, priorClock.close);
  const result: { market: CatalystMarket; filing: CatalystFiling | null; available: boolean }[] = [];
  for (let offset = 0; offset < CATALYST_UNIVERSE.length; offset += 7) {
    const limit = new Promise(resolve => setTimeout(resolve, 1000));
    const entries = await Promise.all(CATALYST_UNIVERSE.slice(offset, offset + 7).map(async market => {
      try { return { market, filing: await getFiling(market, earliest, open), available: true }; }
      catch { return { market, filing: null, available: false }; }
    }));
    result.push(...entries);
    await limit;
  }
  return result;
}

export async function scanCatalysts(broker: EtoroClient, environment: CatalystObservation['environment'], now = Date.now()) {
  if (!catalystWindow(now)) throw new Error('The opening scan runs from 9:47 to 9:56 a.m. ET');
  const { day } = stockMarketClock(now);
  const opened = stockSessionMinute(day, 570);
  const signal = opened + 15 * MINUTE;
  const filings = await readCatalystFilings(day);
  const events = filings.filter(item => item.filing);
  if (!filings.some(item => item.available)) throw new Error('SEC submissions are temporarily unavailable');
  const universe = { scanned: filings.length, unavailable: filings.filter(item => !item.available).map(item => item.market.symbol) };
  if (!events.length) return { rows: [], events: [], ...universe };

  // Per sector, choose at most two liquid peers from a fixed list before seeing outcomes.
  const sectors = [...new Set(events.map(item => item.market.etf))];
  const controls = new Map(sectors.map(etf => [etf, filings.filter(item => item.available && !item.filing && item.market.etf === etf).slice(0, 2)]));
  const watch = [...new Map([...events, ...[...controls.values()].flat()].map(item => [item.market.symbol, item])).values()];
  const marketInputs = new Map<string, ReturnType<typeof catalystOpening>>();
  const sectorInputs = new Map<string, number | null>();
  const tasks = [
    ...watch.map(item => async () => {
      const id = CATALYST_INSTRUMENTS[item.market.symbol];
      const bars = await broker.intradayCandles(id, signal - 27 * DAY, signal, undefined, '5m', true);
      marketInputs.set(item.market.symbol, catalystOpening(bars, day));
    }),
    ...sectors.map(etf => async () => {
      const bars = await broker.intradayCandles(CATALYST_INSTRUMENTS[etf], opened, signal, undefined, '5m', true);
      sectorInputs.set(etf, catalystSectorMove(bars, day));
    }),
  ];
  for (let offset = 0; offset < tasks.length; offset += 7) await Promise.allSettled(tasks.slice(offset, offset + 7).map(task => task()));
  const quotes = await broker.quotes(watch.map(item => CATALYST_INSTRUMENTS[item.market.symbol])).catch(() => []);
  const observed = Date.now();
  if (!catalystWindow(observed)) throw new Error('The opening quotes arrived after the capture window');
  const entry = catalystEntryTime(observed);
  const fields = { observed_at: new Date(observed).toISOString(), eligible_at: new Date(entry).toISOString(),
    settle_after: new Date(entry + 95 * MINUTE).toISOString(), session_day: day, environment, outcomes: null };
  const bar = (item: typeof filings[number], lane: CatalystObservation['lane'], target: string): CatalystObservation => {
    const input = marketInputs.get(item.market.symbol);
    const id = CATALYST_INSTRUMENTS[item.market.symbol];
    const quote = quotes.find(quote => quote.instrumentId === id);
    const ask = freshStockAsk(quote, observed);
    const snapshot = ask && quote?.bid && quote.date ? { bid: quote.bid, ask, at: quote.date } : null;
    return { ...fields, symbol: item.market.symbol, instrument_id: id, sector: item.market.etf, for_symbol: target, lane,
      filing: item.filing, quote: snapshot, decision: catalystDecision(input ?? null, sectorInputs.get(item.market.etf) ?? null, snapshot) };
  };
  const rows = events.flatMap(event => {
    const candidate = bar(event, 'catalyst', event.market.symbol);
    if (candidate.decision.status === 'Watch') universe.unavailable.push(event.market.symbol);
    const control = (controls.get(event.market.etf) ?? []).map(peer => bar(peer, 'control', candidate.symbol))
      .filter(item => item.decision.status === 'Qualified').sort((a, b) => Math.abs(a.decision.relativeBps! - (candidate.decision.relativeBps ?? 0)) -
      Math.abs(b.decision.relativeBps! - (candidate.decision.relativeBps ?? 0)) || a.symbol.localeCompare(b.symbol))[0];
    return control ? [candidate, control] : [candidate];
  });
  return { rows, events: events.map(item => ({ symbol: item.market.symbol, ...item.filing! })), ...universe };
}
