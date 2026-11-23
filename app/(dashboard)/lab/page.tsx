'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Header } from '@/components/layout/Header';
import { ChartTooltip, Stat } from '@/components/ui/stat';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertTriangle, FlaskConical, Loader2, Play } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Stats {
  cagr: number; sharpe: number; vol: number; maxDrawdown: number; worstYear: number; bestYear: number;
  avgExposure: number; tradesPerYear: number; timeInMarket: number; byYear: Record<string, number>;
}
interface Point { date: string; strategy: number; hold: number; exposure: number; drawdown: number }
interface LabResult {
  coin: string; from: string; to: string; liquidated: string | null; trades: number; feesPaid: number; fundingPaid: number;
  stats: Stats; holdStats: Stats; series: Point[];
}
interface Research {
  coins: string[];
  carry: Array<{ coin: string; avgAnnualFunding: number; shareOfDaysPositive: number; cagr: number; maxDrawdown: number; byYear: Record<string, number>; from: string }>;
  basket: { stats: Stats; btcOnly: Stats; perCoin: Array<{ coin: string; cagr: number; sharpe: number }> };
}

const MA_PRESETS: Record<string, { label: string; value: number[] }> = {
  default: { label: '50 / 100 / 150 / 200 days', value: [50, 100, 150, 200] },
  fast: { label: '20 / 50 / 100 days (faster)', value: [20, 50, 100] },
  wide: { label: '30 / 60 / 120 / 240 days', value: [30, 60, 120, 240] },
  single100: { label: '100 days only', value: [100] },
  single200: { label: '200 days only', value: [200] },
};
const START_YEARS = ['2014', '2016', '2018', '2020', '2022', '2024'];

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const signed = (v: number, d = 0) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`;
const money = (v: number) => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v.toFixed(0)}`);
const axisTick = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 };

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full" style={{ background: 'var(--series-1)' }} />Strategy</span>
      <span className="flex items-center gap-1.5"><span className="w-3 h-0.5 rounded-full" style={{ background: 'var(--series-2)' }} />Buy &amp; hold</span>
    </div>
  );
}

export default function LabPage() {
  const [coins, setCoins] = useState<string[]>(['BTC']);
  const [coin, setCoin] = useState('BTC');
  const [startYear, setStartYear] = useState('2020');
  const [targetVol, setTargetVol] = useState('40');
  const [maxLeverage, setMaxLeverage] = useState('2');
  const [preset, setPreset] = useState('default');
  const spotFirst = false; // perps only: this platform trades perpetuals
  const [allowShort, setAllowShort] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LabResult | null>(null);
  const [research, setResearch] = useState<Research | null>(null);

  const run = useCallback(async (params: Record<string, unknown>) => {
    setRunning(true);
    try {
      const res = await fetch('/api/lab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? 'Backtest failed'); return; }
      setResult(data);
    } catch {
      toast.error('Backtest failed');
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    run({ coin: 'BTC', startDate: '2020-01-01' });
    fetch('/api/lab')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d) { setResearch(d); setCoins(d.coins); } })
      .catch(() => {});
  }, [run]);

  function submit() {
    run({
      coin,
      startDate: `${startYear}-01-01`,
      targetVol: parseFloat(targetVol) / 100,
      maxLeverage: parseFloat(maxLeverage),
      smaLookbacks: MA_PRESETS[preset].value,
      spotFirst,
      allowShort: allowShort && !spotFirst,
    });
  }

  // One x-axis tick per calendar year (the first data point of each year).
  const yearTicks = (result?.series ?? [])
    .filter((p, i, arr) => i > 0 && p.date.slice(0, 4) !== arr[i - 1].date.slice(0, 4))
    .map(p => p.date);

  const s = result?.stats;
  const h = result?.holdStats;
  const years = s ? Object.keys(s.byYear) : [];
  const carryYears = research ? [...new Set(research.carry.flatMap(c => Object.keys(c.byYear)))].sort() : [];

  return (
    <div className="flex flex-col min-h-full">
      <Header actions={<Button asChild variant="outline" size="sm"><Link href="/lab/scalping">Scalping research</Link></Button>} />

      <div className="p-4 lg:p-8 space-y-4 lg:space-y-6 flex-1 w-full max-w-[1400px] mx-auto">
        <div className="surface px-4 py-3 flex gap-3 text-xs text-muted-foreground leading-relaxed">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" />
          <p>
            <span className="text-foreground font-medium">A backtest is not a forecast.</span> It shows how a rule did on one
            stretch of history, after fees, slippage, funding and intraday liquidation checks. The more settings you try,
            the more likely the best-looking one is luck. Prefer rules that still work when you change them a little.
          </p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4 lg:gap-6 items-start">
          {/* Controls */}
          <section className="surface p-5 space-y-4 xl:sticky xl:top-20" aria-label="Backtest settings">
            <div className="flex items-center gap-2">
              <FlaskConical className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold">Trend strategy</h2>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Market</Label>
                <Select value={coin} onValueChange={setCoin}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{coins.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>From</Label>
                <Select value={startYear} onValueChange={setStartYear}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{START_YEARS.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Target volatility %</Label>
                <Input type="number" min="5" max="150" step="5" value={targetVol} onChange={e => setTargetVol(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Max leverage ×</Label>
                <Input type="number" min="0.1" max="5" step="0.5" value={maxLeverage} onChange={e => setMaxLeverage(e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Moving averages</Label>
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(MA_PRESETS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <label className={cn('flex items-start justify-between gap-3 cursor-pointer', spotFirst && 'opacity-50')}>
              <span>
                <span className="text-sm font-medium block">Short in downtrends</span>
                <span className="text-xs text-muted-foreground">Otherwise go flat</span>
              </span>
              <Switch checked={allowShort && !spotFirst} onCheckedChange={setAllowShort} disabled={spotFirst} />
            </label>

            <Button className="w-full" onClick={submit} disabled={running}>
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Run backtest
            </Button>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Data: Bitstamp (BTC) and Binance daily candles; real Hyperliquid funding from May 2023, 0.03%/day assumed before.
              If a market has less history than the chosen start, the test begins when its data does.
            </p>
          </section>

          {/* Results */}
          <div className="space-y-4 lg:space-y-6 min-w-0">
            {result?.liquidated && (
              <div className="rounded-xl border border-loss/30 bg-loss/10 px-4 py-3 text-sm text-loss flex gap-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>With these settings the account was <strong>liquidated on {result.liquidated}</strong> and lost everything.</span>
              </div>
            )}

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
              <Stat label="Return / year" value={s ? signed(s.cagr) : '—'} hint={h ? `Buy & hold ${signed(h.cagr)}` : undefined} tone={s ? (s.cagr > 0 ? 'up' : 'down') : 'neutral'} loading={!result} />
              <Stat label="Worst drawdown" value={s ? `-${pct(s.maxDrawdown)}` : '—'} hint={h ? `Buy & hold -${pct(h.maxDrawdown)}` : undefined} loading={!result} />
              <Stat label="Sharpe ratio" value={s ? s.sharpe.toFixed(2) : '—'} hint={h ? `Return per unit of risk · hold ${h.sharpe.toFixed(2)}` : undefined} loading={!result} />
              <Stat label="Worst year" value={s ? signed(s.worstYear) : '—'} hint={h ? `Buy & hold ${signed(h.worstYear)}` : undefined} tone={s && s.worstYear < 0 ? 'down' : 'neutral'} loading={!result} />
            </div>

            <section className="surface p-5" aria-label="Growth chart">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-sm font-semibold">Growth of $10,000{result ? ` · ${result.coin}` : ''}</h2>
                  <p className="text-xs text-muted-foreground">{result ? `${result.from} → ${result.to} · log scale` : ' '}</p>
                </div>
                <Legend />
              </div>
              <div className={cn('h-64 sm:h-80 transition-opacity', running && 'opacity-50')}>
                {!result ? <Skeleton className="h-full w-full rounded-lg" /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={result.series.map(p => ({ ...p, strategy: Math.max(p.strategy, 1), hold: Math.max(p.hold, 1) }))} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="date" ticks={yearTicks} tickFormatter={d => d.slice(0, 4)} tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis scale="log" domain={['auto', 'auto']} tickFormatter={money} width={52} tick={axisTick} tickLine={false} axisLine={false} allowDataOverflow />
                      <Tooltip
                        cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeOpacity: 0.4 }}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const p = payload[0].payload as Point;
                          return (
                            <ChartTooltip
                              title={p.date}
                              rows={[
                                { label: 'Strategy', value: `$${p.strategy.toLocaleString('en-US')}`, color: 'var(--series-1)' },
                                { label: 'Buy & hold', value: `$${p.hold.toLocaleString('en-US')}`, color: 'var(--series-2)' },
                                { label: 'Position', value: `${p.exposure.toFixed(2)}×` },
                              ]}
                            />
                          );
                        }}
                      />
                      <Line type="monotone" dataKey="hold" stroke="var(--series-2)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} isAnimationActive={false} />
                      <Line type="monotone" dataKey="strategy" stroke="var(--series-1)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'hsl(var(--card))' }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
              <section className="surface p-5" aria-label="Drawdown chart">
                <h2 className="text-sm font-semibold">Drawdown</h2>
                <p className="text-xs text-muted-foreground mb-3">How far the strategy was below its previous high</p>
                <div className="h-44">
                  {!result ? <Skeleton className="h-full w-full rounded-lg" /> : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={result.series} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
                        <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="date" ticks={yearTicks} tickFormatter={d => d.slice(0, 4)} tick={axisTick} tickLine={false} axisLine={false} minTickGap={24} />
                        <YAxis tickFormatter={v => `${v}%`} width={44} tick={axisTick} tickLine={false} axisLine={false} />
                        <Tooltip
                          cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeOpacity: 0.4 }}
                          content={({ active, payload }) => {
                            if (!active || !payload?.length) return null;
                            const p = payload[0].payload as Point;
                            return <ChartTooltip title={p.date} rows={[{ label: 'Below peak', value: `${p.drawdown.toFixed(1)}%`, color: 'var(--series-1)' }]} />;
                          }}
                        />
                        <Area type="monotone" dataKey="drawdown" stroke="var(--series-1)" strokeWidth={1.5} fill="var(--series-1)" fillOpacity={0.15} dot={false} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </section>

              <section className="surface p-5" aria-label="Costs and activity">
                <h2 className="text-sm font-semibold">Costs and activity</h2>
                <p className="text-xs text-muted-foreground mb-3">On a $10,000 start, over the whole test</p>
                {!result || !s ? <Skeleton className="h-44 w-full rounded-lg" /> : (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 text-sm">
                    {[
                      ['Funding paid', money(Math.max(0, result.fundingPaid))],
                      ['Fees and slippage', money(result.feesPaid)],
                      ['Trades per year', s.tradesPerYear.toFixed(0)],
                      ['Time in the market', pct(s.timeInMarket)],
                      ['Average position', `${s.avgExposure.toFixed(2)}×`],
                      ['Ending value', money(result.series[result.series.length - 1].strategy)],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="eyebrow">{k}</dt>
                        <dd className="num text-base font-medium mt-0.5">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            </div>

            {s && h && (
              <section className="surface overflow-hidden" aria-label="Returns by year">
                <div className="px-5 pt-5 pb-3"><h2 className="text-sm font-semibold">Year by year</h2></div>
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>Year</th>{years.map(y => <th key={y}>{y}</th>)}</tr></thead>
                    <tbody>
                      {([['Strategy', s], ['Buy & hold', h]] as const).map(([name, st]) => (
                        <tr key={name}>
                          <td className="text-foreground font-medium">{name}</td>
                          {years.map(y => {
                            const v = st.byYear[y];
                            return <td key={y} className={cn('num', v == null ? '' : v > 0 ? 'text-profit' : v < 0 ? 'text-loss' : 'text-muted-foreground')}>{v == null ? '—' : signed(v)}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>

        {/* Research */}
        <section className="surface p-5" aria-label="Scalping and swing study">
          <h2 className="text-sm font-semibold">Scalping vs swing: what survived costs</h2>
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed max-w-3xl">
            Eight textbook rules were run on hourly BTC, ETH and SOL data since 2020 with Hyperliquid fees, slippage and funding.
            Every scalping and intraday rule (RSI dips, fading spikes, fast EMA crosses, 24-hour breakouts) <span className="text-loss font-medium">lost
            16–38% a year after costs</span>: their average trade made under 10 basis points before fees, and a round trip costs about 13.
            Slow trend rules that trade a few dozen times a year or less (20-day breakouts, price above its 30-day average) stayed
            profitable, <span className="text-foreground font-medium">+26% to +31% a year since 2023</span>, with deep drawdowns.
          </p>
          <p className="text-xs text-muted-foreground mt-3 leading-relaxed max-w-3xl">
            <span className="text-foreground font-medium">What that means for your own strategies:</span> check the average profit per trade
            before fees. If it is not comfortably above 13 basis points, no amount of leverage or win rate will save it. Full table
            in <code className="bg-secondary px-1 py-0.5 rounded">backtest/INTRADAY.md</code>.
          </p>
        </section>

        <div className="pt-2">
          <h2 className="text-base font-semibold tracking-tight">Research notes</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Other ideas tested on the same data. Full write-up in <code className="text-xs bg-secondary px-1 py-0.5 rounded">backtest/RESULTS.md</code>.</p>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 lg:gap-6 items-start">
          <section className="surface overflow-hidden xl:col-span-2" aria-label="Funding capture">
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-sm font-semibold">Funding capture: long spot, short the perp</h3>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                Price moves cancel out and the short collects funding. Return on total capital per year, after costs, with half the
                capital in spot and half as margin{research?.carry[0] ? `, since ${research.carry[0].from}` : ''}.
              </p>
            </div>
            {!research ? <div className="px-5 pb-5"><Skeleton className="h-64 w-full rounded-lg" /></div> : (
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Market</th><th>Avg funding / yr</th><th>Return / yr</th>
                      {carryYears.map(y => <th key={y} className="hidden sm:table-cell">{y}</th>)}
                      <th>Worst dip</th>
                    </tr>
                  </thead>
                  <tbody>
                    {research.carry.map(c => (
                      <tr key={c.coin}>
                        <td className="font-medium text-foreground">{c.coin}</td>
                        <td className="num text-muted-foreground">{pct(c.avgAnnualFunding, 1)}</td>
                        <td className="num font-medium">{signed(c.cagr, 1)}</td>
                        {carryYears.map(y => (
                          <td key={y} className={cn('num hidden sm:table-cell', (c.byYear[y] ?? 0) < 0 ? 'text-loss' : 'text-muted-foreground')}>
                            {c.byYear[y] == null ? '—' : signed(c.byYear[y], 1)}
                          </td>
                        ))}
                        <td className="num text-muted-foreground">-{pct(c.maxDrawdown, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-5 py-3 border-t border-border text-xs text-muted-foreground leading-relaxed">
              <span className="text-foreground font-medium">Verdict:</span> steady but small, and shrinking since 2024. Worth doing
              only when funding spikes; check the Markets page for that. Exchange failure and long stretches of negative funding are not modelled.
            </p>
          </section>

          <section className="surface p-5" aria-label="Multi-coin trend">
            <h3 className="text-sm font-semibold">Same trend rule across {research?.coins.length ?? 10} coins</h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">Equal capital per coin, default settings, since 2021.</p>
            {!research ? <Skeleton className="h-52 w-full rounded-lg mt-4" /> : (
              <>
                <table className="w-full text-sm mt-4">
                  <thead>
                    <tr className="eyebrow text-right"><th className="text-left font-medium pb-2"> </th><th className="font-medium pb-2">Basket</th><th className="font-medium pb-2">BTC only</th></tr>
                  </thead>
                  <tbody className="[&_td]:py-2 [&_td]:border-t [&_td]:border-border/70">
                    {([
                      ['Return / year', signed(research.basket.stats.cagr), signed(research.basket.btcOnly.cagr)],
                      ['Sharpe ratio', research.basket.stats.sharpe.toFixed(2), research.basket.btcOnly.sharpe.toFixed(2)],
                      ['Worst drawdown', `-${pct(research.basket.stats.maxDrawdown)}`, `-${pct(research.basket.btcOnly.maxDrawdown)}`],
                      ['Worst year', signed(research.basket.stats.worstYear), signed(research.basket.btcOnly.worstYear)],
                    ] as const).map(([k, a, b]) => (
                      <tr key={k}><td className="text-muted-foreground">{k}</td><td className="num text-right font-medium">{a}</td><td className="num text-right text-muted-foreground">{b}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-xs text-muted-foreground leading-relaxed mt-3 pt-3 border-t border-border">
                  <span className="text-foreground font-medium">Verdict:</span> spreading the rule over more coins gave a smoother ride.
                  But these coins were picked because they are big today, and the ones that died are missing, so the real benefit is smaller than shown.
                </p>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
