import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { hasCoin } from '@/backtest/data';
import { computeStats } from '@/backtest/engine';
import { BASKET, runBasketTrend, runCarry, runHold, runTrend } from '@/backtest/research';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POINTS = 500;

function inRange(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Keep charts light: sample long series down to MAX_POINTS, always keeping the last point. */
function sample<T>(rows: T[]): T[] {
  if (rows.length <= MAX_POINTS) return rows;
  const step = rows.length / MAX_POINTS;
  const out: T[] = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(rows[Math.floor(i * step)]);
  out[out.length - 1] = rows[rows.length - 1];
  return out;
}

// Research summary: funding capture per coin and the multi-coin basket.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const carry = BASKET.map(coin => {
      const r = runCarry({ coin });
      return {
        coin,
        avgAnnualFunding: r.avgAnnualFunding,
        shareOfDaysPositive: r.shareOfDaysPositive,
        cagr: r.stats.cagr,
        maxDrawdown: r.stats.maxDrawdown,
        byYear: r.stats.byYear,
        from: r.dates[0],
        to: r.dates[r.dates.length - 1],
      };
    });
    const basket = runBasketTrend(BASKET, '2021-01-01');
    const btcOnly = computeStats(runTrend({ coin: 'BTC', source: 'binance', startDate: '2021-01-01' }));
    return NextResponse.json({
      coins: BASKET,
      carry,
      basket: { stats: basket.stats, perCoin: basket.perCoin.map(c => ({ coin: c.coin, cagr: c.stats.cagr, sharpe: c.stats.sharpe })), btcOnly },
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}

// Runs the trend strategy with the caller's parameters against buy & hold.
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const coin = String(body.coin ?? 'BTC').toUpperCase();
  if (!hasCoin(coin)) return NextResponse.json({ error: `No data for ${coin}` }, { status: 400 });

  const smaLookbacks = (Array.isArray(body.smaLookbacks) ? body.smaLookbacks : [50, 100, 150, 200])
    .map(Number)
    .filter((n: number) => Number.isInteger(n) && n >= 5 && n <= 400)
    .slice(0, 6);
  if (smaLookbacks.length === 0) return NextResponse.json({ error: 'Give at least one moving average between 5 and 400 days' }, { status: 400 });

  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate)) ? String(body.startDate) : '2020-01-01';
  // BTC has a longer history on Bitstamp; every other coin uses the Binance set.
  const source = coin === 'BTC' ? 'bitstamp' : 'binance';

  try {
    const result = runTrend({
      coin,
      source,
      startDate,
      spotFirst: body.spotFirst === true,
      band: inRange(body.band, 0.01, 1, 0.25),
      fundingMultiplier: inRange(body.fundingMultiplier, 0, 5, 1),
      config: {
        smaLookbacks,
        volLookback: Math.round(inRange(body.volLookback, 5, 180, 30)),
        targetVol: inRange(body.targetVol, 0.05, 1.5, 0.4),
        maxLeverage: inRange(body.maxLeverage, 0.1, 5, 2),
        allowShort: body.allowShort === true && body.spotFirst !== true,
      },
    });
    if (result.dates.length < 30) return NextResponse.json({ error: 'Not enough data after that start date' }, { status: 400 });

    const hold = runHold(coin, source, startDate);
    const holdByDate = new Map(hold.dates.map((d, i) => [d, hold.equity[i]]));
    let peak = 0;
    const series = result.dates.map((date, i) => {
      const equity = result.equity[i];
      peak = Math.max(peak, equity);
      return {
        date,
        strategy: Math.round(equity),
        hold: Math.round(holdByDate.get(date) ?? 0),
        exposure: +result.exposure[i].toFixed(3),
        drawdown: peak > 0 ? +((equity / peak - 1) * 100).toFixed(2) : 0,
      };
    });

    return NextResponse.json({
      coin,
      from: result.dates[0],
      to: result.dates[result.dates.length - 1],
      liquidated: result.liquidated,
      trades: result.trades,
      feesPaid: result.feesPaid,
      fundingPaid: result.fundingPaid,
      stats: computeStats(result),
      holdStats: computeStats(hold),
      series: sample(series),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unknown error' }, { status: 500 });
  }
}
