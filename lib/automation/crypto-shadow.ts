import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { estimateFill, liquidityVerdict } from '@/lib/liquidity';
import { computeIndicators, type Bar } from '@/lib/autopilot/strategies';
import { BARS_NEEDED, entrySignal, HOUR_MS as hour } from '@/lib/autopilot/signals';
import { AUTOMATION_REVISION, CRYPTO_RESEARCH_RULES, CRYPTO_RESEARCH_SYMBOLS } from './model';

type Db = ReturnType<typeof createServiceClient>;
type Shadow = { version: string; symbol: string; strategy: string; signal_bar: string; observed_at: string; decision: 'quiet' | 'qualified' | 'skipped';
  detail: string; stop_pct: number | null; assumed_slippage_bps: number | null; entry_after: string; settle_after: string };
const notional = 1_000;
const fee = 0.00045;

export function settleCryptoShadow(row: Pick<Shadow, 'entry_after' | 'stop_pct' | 'assumed_slippage_bps'>, bars: Bar[], funding: Map<number, number>) {
  const entry = Date.parse(row.entry_after);
  const opening = bars.find(bar => bar.t === entry);
  if (!opening || row.stop_pct == null || row.assumed_slippage_bps == null) return null;
  const byTime = new Map(bars.map(bar => [bar.t, bar]));
  const friction = Math.max(2, row.assumed_slippage_bps) / 10_000;
  const ask = opening.o * (1 + friction);
  const stop = ask * (1 - row.stop_pct);
  let fundingPaid = 0;
  for (let offset = 0; offset <= 24; offset++) {
    const t = entry + offset * hour;
    const bar = byTime.get(t);
    if (!bar) return null;
    if (offset === 24 || bar.l <= stop) {
      const bid = (offset === 24 ? bar.o : Math.min(bar.o, stop)) * (1 - friction);
      const net = bid / ask - 1 - fee * (1 + bid / ask) - fundingPaid;
      return { pnlUsd: net * notional, netBps: net * 10_000, closedAt: new Date(t).toISOString(),
        exit: offset === 24 ? '24-hour exit' : 'Modeled stop' };
    }
    const rate = funding.get(t + hour);
    if (rate == null) return null;
    fundingPaid += rate * bar.c / ask;
  }
  return null;
}

export async function updateCryptoShadow(db: Db, now: number) {
  const profiles = await db.from('automation_profiles').select('user_id').eq('market', 'crypto').eq('enabled', true).limit(1);
  if (profiles.error) throw new Error('Could not read Crypto observation settings.');
  if (!profiles.data?.length) return;
  const hl = marketDataClient();
  const close = Math.floor(now / hour) * hour;
  const current = await db.from('automation_crypto_shadow').select('symbol').eq('version', AUTOMATION_REVISION)
    .eq('signal_bar', new Date(close - hour).toISOString());
  if (current.error) throw new Error('Could not read the current Crypto observations.');
  const assets = new Set(current.data.map(item => item.symbol));
  const calculations = await Promise.allSettled(CRYPTO_RESEARCH_SYMBOLS.filter(symbol => !assets.has(symbol)).map(async symbol => {
    const [prices, book] = await Promise.all([hl.getCandles(symbol, '1h', close - (BARS_NEEDED + 5) * hour, close), hl.getBook(symbol)]);
    const bars = prices.filter(bar => bar.t < close);
    const bar = bars.at(-1);
    if (!bar || bar.t !== close - hour || bars.length < BARS_NEEDED) throw new Error('The latest hourly bar is unavailable.');
    const ind = computeIndicators(bars);
    const fill = estimateFill(book, 'buy', notional);
    const liquidity = liquidityVerdict(fill, .35);
    const savedAt = new Date().toISOString();
    const inspect = CRYPTO_RESEARCH_RULES.map((strategy): Shadow => {
      const signal = entrySignal(strategy, { bars, ind, last: bars.length - 1 }, now, false);
      const decision = !signal ? 'quiet' : liquidity.level === 'block' ? 'skipped' : 'qualified';
      return { symbol, strategy, version: AUTOMATION_REVISION, signal_bar: new Date(bar.t).toISOString(), observed_at: savedAt, decision,
        detail: !signal ? 'No signal on the completed hourly bar.' : decision === 'skipped' ? liquidity.message! : signal.reason,
        stop_pct: signal?.stopPct ?? null, assumed_slippage_bps: fill?.slippageBps ?? null,
        entry_after: new Date(close + hour).toISOString(), settle_after: new Date(close + 26 * hour).toISOString() };
    });
    const result = await db.from('automation_crypto_shadow').upsert(inspect, { onConflict: 'version,symbol,strategy,signal_bar', ignoreDuplicates: true });
    if (result.error) throw new Error('Could not save the Crypto observations.');
  }));
  const ready = await db.from('automation_crypto_shadow').select('*').eq('version', AUTOMATION_REVISION).eq('decision', 'qualified')
    .is('outcome', null).lte('settle_after', new Date(now).toISOString()).order('settle_after', { ascending: false }).limit(36);
  if (ready.error) throw new Error('Could not read Crypto shadow outcomes.');
  const rows = ready.data as Shadow[];
  for (const symbol of new Set(rows.map(row => row.symbol))) {
    const items = rows.filter(row => row.symbol === symbol);
    const start = Math.min(...items.map(row => Date.parse(row.entry_after)));
    const end = Math.max(...items.map(row => Date.parse(row.settle_after)));
    const [bars, rates] = await Promise.all([hl.getCandles(symbol, '1h', start, end), hl.getFundingRates(symbol, start, end)]);
    const funding = new Map(rates.map(rate => [Math.round(rate.time / hour) * hour, rate.rate]));
    for (const row of items) {
      const outcome = settleCryptoShadow(row, bars, funding);
      if (!outcome && now - Date.parse(row.settle_after) < 48 * hour) continue;
      const saved = await db.from('automation_crypto_shadow').update({ outcome: outcome ?? { exit: 'Missing historical data' } })
        .match({ version: row.version, symbol, strategy: row.strategy, signal_bar: row.signal_bar }).is('outcome', null);
      if (saved.error) throw new Error('Could not record the Crypto shadow outcome.');
    }
  }
  if (calculations.some(result => result.status === 'rejected')) throw new Error('One or more Crypto shadow markets missed their data window.');
}
