'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Header } from '@/components/layout/Header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { StockPortfolioFields } from '@/components/stocks/StockPortfolioFields';
import { researchRequest, ResearchRequestError } from '@/components/stocks/research-requests';
import { DEFAULT_STOCK_PORTFOLIO, stockPortfolioSchema, type StockPortfolio } from '@/lib/stocks/portfolio';
import { replayStockPortfolio, type StockPortfolioInput } from '@/lib/stocks/portfolio-replay';
import { stockReplaySchema } from '@/lib/stocks/replay';
import { stockMarketClock } from '@/lib/stocks/session';
import { STOCK_TRADE_RULES, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { formatCurrency } from '@/lib/utils';

const DAY = 86_400_000;
const money = (value: number) => formatCurrency(value);
const pct = (value: number) => `${(100 * value).toFixed(2)}%`;
const selectClass = 'mt-1 w-full rounded-md border border-border bg-background px-3 h-10';
const names = Object.fromEntries(STOCK_TRADE_RULES.map(rule => [rule.id, rule.name]));
const skipLabels = { position: 'Position limit', exposure: 'Gross exposure', group: 'Concentration', dailyLoss: 'Daily loss', cash: 'Cash or stop', spread: 'Spread', cost: 'Costs', evidence: 'Evidence' };
type Result = ReturnType<typeof replayStockPortfolio>;

export default function StockPortfolioReplayPage() {
  const [settings, setSettings] = useState<StockPortfolio>({ ...DEFAULT_STOCK_PORTFOLIO, symbols: ['AAPL', 'NVDA', 'AMZN', 'JPM', 'XOM'],
    strategies: ['inside-day', 'breakout', 'pullback'] });
  const [from, setFrom] = useState(() => stockMarketClock(Date.now() - 100 * DAY).day);
  const [latest] = useState(() => stockMarketClock(Date.now() - DAY).day);
  const [to, setTo] = useState(latest);
  const [amount, setAmount] = useState('1000');
  const [capital, setCapital] = useState('10000');
  const [leverage, setLeverage] = useState('1');
  const [stopMarginPct, setStop] = useState('10');
  const [slip, setSlip] = useState('3');
  const [fee, setFee] = useState('1');
  const [cfdFee, setCfdFee] = useState('15');
  const [annual, setAnnual] = useState('11.4');
  const [progress, setProgress] = useState('');
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<{ value: Result; missing: StockTradeSymbol[]; from: string; to: string } | null>(null);
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  async function loadSettings() {
    setProblem('');
    try {
      const { settings: saved } = await researchRequest<{ settings: { portfolio?: StockPortfolio; amount: number; leverage: number; stop_margin_pct: number | null } | null }>('/api/stocks/autopilot');
      if (!saved?.portfolio) throw new Error('Save a Portfolio setup in Autopilot to reuse its limits.');
      setSettings(saved.portfolio); setAmount(String(saved.amount)); setLeverage(String(saved.leverage));
      if (saved.stop_margin_pct != null) setStop(String(saved.stop_margin_pct));
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not load Autopilot settings.'); }
  }

  async function run(event: FormEvent) {
    event.preventDefault();
    const risk = stockPortfolioSchema.safeParse(settings);
    const sizing = stockReplaySchema.safeParse({ amount: Number(amount), leverage: Number(leverage), stopMarginPct: Number(stopMarginPct),
      slipBps: Number(slip), commission: leverage === '1' ? Number(fee) : 0, cfdFeeBps: Number(cfdFee), annualFinancingPct: Number(annual) });
    const cash = Number(capital);
    if (!risk.success || !sizing.success || !Number.isFinite(cash) || cash < Number(amount) || cash < 1 || cash > 1_000_000 ||
        Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 126 * DAY) {
      setProblem('Check the stock and strategy choices, capital, portfolio limits and date range. Use up to 126 calendar days.'); return;
    }
    if (running.current) return;
    const abort = new AbortController();
    running.current = abort;
    setProblem(''); setResult(null); setProgress('Loading SPY benchmark…');
    try {
      const series = new Map<StockTradeSymbol, StockPortfolioInput>();
      const missing: StockTradeSymbol[] = [];
      const symbols = [...new Set<StockTradeSymbol>(['SPY', ...risk.data.symbols])];
      for (const [index, symbol] of symbols.entries()) {
        setProgress(`Loading ${symbol} · ${index + 1} of ${symbols.length}`);
        const query = new URLSearchParams({ view: 'portfolio-input', symbol, from, to, leveraged: String(leverage !== '1') });
        for (const rule of risk.data.strategies) query.append('rule', rule);
        try {
          const data = await researchRequest<StockPortfolioInput>(`/api/stocks?${query}`, abort.signal);
          if (data.daily.length || data.regular.length || risk.data.strategies.includes('earnings-rebound')) series.set(symbol, data);
          else missing.push(symbol);
        } catch (error) {
          if (abort.signal.aborted || symbol === 'SPY' || !(error instanceof ResearchRequestError) || [401, 409].includes(error.status)) throw error;
          missing.push(symbol);
        }
      }
      const spy = series.get('SPY')?.daily;
      if (!spy?.length) throw new Error('SPY data is unavailable for this period.');
      if (!risk.data.symbols.some(symbol => series.has(symbol))) throw new Error('No selected stocks returned replay data.');
      const value = replayStockPortfolio([...series.values()], spy, { ...risk.data, from, to, capital: cash }, sizing.data);
      if (!value.sessions) throw new Error('There are no completed SPY sessions in this date range.');
      setResult({ value, missing, from, to });
    } catch (error) {
      if (!abort.signal.aborted) setProblem(error instanceof Error ? error.message : 'The replay could not complete.');
    } finally { running.current = null; setProgress(''); }
  }

  return <><Header /><div className="p-4 lg:p-8 space-y-4 max-w-[1400px] w-full mx-auto">
    <section className="surface p-4 lg:p-6 space-y-4">
      <div className="flex justify-between items-start flex-wrap gap-2">
        <div><h2 className="font-semibold">Replay strategies together</h2><p className="text-sm text-muted-foreground">One balance and one set of exposure limits for every simulated trade.</p></div>
        <Button size="sm" variant="outline" disabled={!!progress} onClick={() => void loadSettings()}>Use Autopilot settings</Button>
      </div>
      <form onSubmit={run}>
        <fieldset disabled={!!progress} className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <label className="text-sm">From<Input type="date" min="2025-01-01" required value={from} onChange={e => setFrom(e.target.value)} /></label>
            <label className="text-sm">Through<Input type="date" min="2025-01-02" max={latest} required value={to} onChange={e => setTo(e.target.value)} /></label>
            <label className="text-sm">Starting balance (USD)<Input type="number" min="1" max="1000000" required value={capital} onChange={e => setCapital(e.target.value)} /></label>
            <label className="text-sm">{leverage === '1' ? 'Amount per order (USD)' : 'Margin per order (USD)'}<Input type="number" min="1" max="10000" step="0.01" required value={amount} onChange={e => setAmount(e.target.value)} /></label>
            <label className="text-sm">Leverage<select aria-label="Leverage" className={selectClass} value={leverage} onChange={e => setLeverage(e.target.value)}><option value="1">1× · Cash</option><option value="2">2× · CFD</option><option value="5">5× · CFD</option></select></label>
            {leverage !== '1' && <label className="text-sm">Stop loss (% of margin)<Input type="number" min="0.01" max="50" step="0.01" required value={stopMarginPct} onChange={e => setStop(e.target.value)} /></label>}
          </div>
          <StockPortfolioFields settings={settings} onChange={setSettings} />
          <details className="text-sm"><summary className="cursor-pointer">Trading costs</summary><div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
            <label>Slippage (bps per side)<Input type="number" min="0" max="100" step="0.1" required value={slip} onChange={e => setSlip(e.target.value)} /></label>
            {leverage === '1' ? <label>Commission (USD per side)<Input type="number" min="0" max="30" step="0.01" required value={fee} onChange={e => setFee(e.target.value)} /></label> : <>
              <label>CFD fee (bps per side)<Input type="number" min="0" max="100" step="0.1" required value={cfdFee} onChange={e => setCfdFee(e.target.value)} /></label>
              <label>Annual financing (%)<Input type="number" min="0" max="100" step="0.01" required value={annual} onChange={e => setAnnual(e.target.value)} /></label>
            </>}
          </div></details>
          <Button type="submit">Run portfolio replay</Button>
        </fieldset>
      </form>
      {settings.evidenceOnly && leverage !== '1' && <p className="text-sm text-muted-foreground">Leveraged setups are marked Watch until their stop and costs have qualifying evidence. The evidence filter will skip them.</p>}
      {progress && <div className="flex items-center gap-3 text-sm" role="status">{progress}<Button size="sm" variant="outline" onClick={() => running.current?.abort()}>Cancel</Button></div>}
      {problem && <p role="alert" className="text-sm text-loss">{problem}</p>}
    </section>
    {result && <section className="surface p-4 lg:p-6 space-y-4" aria-live="polite">
      <h2 className="font-semibold">Portfolio results</h2>
      <p className="text-sm text-muted-foreground">{result.from} through {result.to} · {result.value.sessions} sessions · {result.value.trades} closed trades</p>
      {result.missing.length > 0 && <p className="text-sm text-loss">Partial replay. History unavailable for {result.missing.join(', ')}.</p>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Net return', pct(result.value.return)], ['Higher-cost return', pct(result.value.stressedReturn)], ['Max drawdown', pct(result.value.drawdown)],
          ['SPY at average exposure', pct(result.value.spy)], ['Cash baseline', '0.00%'], ['Average exposure', money(result.value.averageExposure)],
          ['Winning trades', `${result.value.wins} / ${result.value.trades}`], ['Financing', money(result.value.financing)],
        ].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="font-semibold tabular-nums">{value}</dd></div>)}
      </dl>
      <div className="h-52" aria-label="Portfolio equity"><ResponsiveContainer width="100%" height="100%"><LineChart data={result.value.curve}>
        <XAxis dataKey="day" minTickGap={70} tick={{ fontSize: 10 }} /><YAxis width={68} domain={['auto', 'auto']} tick={{ fontSize: 10 }} tickFormatter={value => formatCurrency(Number(value), 0)} />
        <Tooltip formatter={value => money(Number(value))} /><Line dataKey="equity" dot={false} stroke="var(--series-1)" />
      </LineChart></ResponsiveContainer></div>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th>Strategy</th><th>Return on its own</th><th>Drawdown on its own</th><th>P&L in portfolio</th></tr></thead>
        <tbody>{result.value.standalone.map(row => <tr key={row.rule} className="border-t"><td className="py-2">{names[row.rule]}</td><td>{pct(row.return)}</td><td>{pct(row.drawdown)}</td><td>{money(result.value.contribution.find(item => item.rule === row.rule)?.pnl ?? 0)}</td></tr>)}</tbody>
      </table></div>
      <p className="text-xs text-muted-foreground">{Object.entries(result.value.skips).filter(([, count]) => count > 0).map(([key, count]) => `${skipLabels[key as keyof typeof skipLabels]} ${count}`).join(' · ') || 'No entry skips recorded.'}</p>
      {(result.value.missingBars > 0 || result.value.missingEvents > 0 || result.value.openAtEnd > 0) && <p className="text-xs text-loss">{result.value.missingBars} missing position bars · {result.value.missingEvents} earnings windows with missing quotes · {result.value.openAtEnd} positions marked with the last observed bid at the end.</p>}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Replay assumptions</summary><p className="mt-2">Daily rules use the next opening quote. Earnings trades use the 10 a.m. and 3:50 p.m. quotes. Daily stop checks use session highs and lows, with opening gaps handled first. The SPY benchmark scales buy-and-hold to the portfolio&rsquo;s average gross exposure. The replay starts with cash and excludes unrelated eToro positions.</p></details>
    </section>}
  </div></>;
}
