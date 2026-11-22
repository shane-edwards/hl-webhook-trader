import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { WARMUP_BARS } from '@/lib/autopilot/strategies';
import { buildSuggestion, type Suggestion } from '@/lib/suggestions';
import { normalizeSymbol } from '@/lib/webhook';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const MAX_SYMBOLS = 12;

// ?symbol=BTC    one market (used by the trade ticket)
// ?scope=market  every liquid market, ranked, from the cache the market scan keeps fresh
// (no query)     the markets the Autopilot watches (used by the dashboard)
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  if (params.get('scope') === 'market') {
    const { data, error } = await createServiceClient().from('suggestions_cache').select('payload, volume_24h_usd, updated_at');
    if (error) return NextResponse.json({ suggestions: [], available: false, asOf: Date.now() });
    const rows = (data ?? [])
      .map(r => ({ ...(r.payload as Suggestion), volume24hUsd: Number(r.volume_24h_usd), updatedAt: r.updated_at as string }))
      // Strongest reads first; among equals, the most traded market.
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.volume24hUsd - a.volume24hUsd);
    const oldest = rows.length ? Math.min(...rows.map(r => new Date(r.updatedAt).getTime())) : null;
    return NextResponse.json({ suggestions: rows, available: true, asOf: Date.now(), oldest });
  }
  const one = params.get('symbol');
  let symbols: string[];
  if (one) {
    const symbol = normalizeSymbol(one);
    if (!/^[A-Z0-9]{1,20}$/.test(symbol)) return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 });
    symbols = [symbol];
  } else {
    const { data: settings } = await createServiceClient().from('settings').select('*').eq('user_id', user.id).single();
    const list = Array.isArray(settings?.autopilot_symbols) && settings.autopilot_symbols.length ? settings.autopilot_symbols : DEFAULT_SYMBOLS;
    symbols = list.map((s: unknown) => String(s).toUpperCase()).slice(0, MAX_SYMBOLS);
  }

  // Public market data only: suggestions never need the user's key.
  const hl = marketDataClient();
  try {
    const mids = await hl.getAllMids();
    const results = await Promise.all(symbols.map(async (symbol): Promise<Suggestion | { symbol: string; error: string }> => {
      try {
        const price = parseFloat(mids[symbol] ?? '');
        if (!(price > 0)) return { symbol, error: 'Not listed on Hyperliquid' };
        const bars = await hl.getHourlyCandles(symbol, WARMUP_BARS + 30);
        if (bars.length < 30) return { symbol, error: 'Not enough price history' };
        return buildSuggestion(symbol, bars, price);
      } catch (err) {
        return { symbol, error: err instanceof Error ? err.message : 'Unknown error' };
      }
    }));
    return NextResponse.json({ suggestions: results, asOf: Date.now() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 502 });
  }
}
