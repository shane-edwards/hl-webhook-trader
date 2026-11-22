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

// ?symbol=BTC  one market (used by the trade ticket)
// (no query)   the markets the Autopilot watches (used by the dashboard)
export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const one = new URL(request.url).searchParams.get('symbol');
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
