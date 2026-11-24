import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { COST, STOP_SLIPPAGE, simulate, type Run } from '@/lib/autopilot/simulate';
import { getStrategy, WARMUP_BARS } from '@/lib/autopilot/strategies';
import { LAB_SYMBOLS, summarizeStockLab, type LabSymbol } from '@/lib/stocks/intraday-lab';
import { loadIntradaySessions, loadLabMarket } from '@/lib/stocks/intraday-lab-data';
import { replayStockIntraday, type IntradayTrade } from '@/lib/stocks/intraday';
import { stockLabWindows } from '@/lib/stocks/intraday-lab';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { loadPortfolioReplayMarket } from '@/lib/stocks/portfolio-replay-data';
import { replayStockPortfolio, type StockPortfolioInput } from '@/lib/stocks/portfolio-replay';
import { DEFAULT_STOCK_PORTFOLIO } from '@/lib/stocks/portfolio';
import { researchStock, simulateStockRule } from '@/lib/stocks/research';
import { previousStockSession } from '@/lib/stocks/session';
import { STOCK_TRADE_RULES, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import type { DailyStockRule, StockBar } from '@/lib/stocks/research';
import type { StrategyIdea } from './ideas';
import type { Experiment, SearchReport } from '@/lib/strategy-search/model';
import type { PositionDay } from '@/lib/strategy-search/positioning';
import { refreshScheduledStockJournal } from './stock-journal';
import { CRYPTO_RESEARCH_RULES, CRYPTO_RESEARCH_SYMBOLS, STOCK_RESEARCH_RULES, STOCK_RESEARCH_SYMBOLS, isoDay, researchWindow,
  studyEvidence, type AutomationKind, type AutomationMarket, type Evidence, type RunReport } from './model';
import { updateTrial, type NamedTrial, type TrialFill } from './forward-trials';

type Db = ReturnType<typeof createServiceClient>;
const hour = 3_600_000;
const stockCosts = { amount: 1000, commission: 1, slipBps: 3, leverage: 1 as const };
const labCosts = { fee: 1, slipBps: 3 };
type LabMarket = Parameters<typeof summarizeStockLab>[0][number];
export type ResearchStep = { symbol: string; stock?: StockPortfolioInput; lab?: LabMarket; evidence?: Evidence[];
  trial?: NamedTrial | null; experiments?: Experiment[]; discoveryThrough?: number; positioning?: PositionDay[];
  journal?: Awaited<ReturnType<typeof refreshScheduledStockJournal>>; search?: SearchReport; problem?: string };

export function researchPlan(market: AutomationMarket, kind: AutomationKind) {
  return market === 'crypto' ? [...CRYPTO_RESEARCH_SYMBOLS] : kind === 'weekly' ? [...LAB_SYMBOLS] : [...STOCK_RESEARCH_SYMBOLS, 'eToro journal'];
}

class UnavailableData extends Error {}

export function permanentResearchProblem(error: unknown) {
  return error instanceof UnavailableData;
}

export async function stockFeed(db: Db, userId: string) {
  const connection = await db.from('etoro_connections').select('environment, credentials_encrypted').eq('user_id', userId)
    .order('environment', { ascending: false }).limit(1).maybeSingle();
  if (connection.error) throw new Error('Could not read the eToro connection.');
  if (!connection.data) throw new UnavailableData('Connect an eToro market-data feed.');
  return etoroFromConnection(connection.data);
}

function performance(run: Run) {
  let value = 1, peak = 1, drawdown = 0;
  for (const row of run.hourly) {
    value *= 1 + row.r;
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, 1 - value / peak);
  }
  return { gain: value - 1, drawdown };
}

const stockEntryAllowed = (prev: StockBar, current: StockBar) =>
  (current.askOpen - current.bidOpen) / current.askOpen <= .003 &&
  (current.day < '2025-01-01' || previousStockSession(Date.parse(`${current.day}T15:00:00Z`)) === prev.day);

function stockEvidence(symbol: string, rule: DailyStockRule, bars: StockBar[]) {
  const result = researchStock(bars, rule, stockCosts, stockEntryAllowed);
  return result ? studyEvidence({ market: 'stocks', symbol, rule, name: STOCK_TRADE_RULES.find(item => item.id === rule)!.name, trades: result.trades,
    holdoutTrades: result.holdoutTrades, from: result.from, through: result.to, early: result.earlyReturn, later: result.holdoutReturn,
    stress: result.stressReturn, benchmark: result.holdoutHold * (stockCosts.amount / 10_000), drawdown: result.drawdown }) : null;
}

function intradayPerformance(trades: IntradayTrade[], cost: 'netBps' | 'stressBps') {
  let equity = 1, peak = 1, drawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade[cost] / 10_000;
    peak = Math.max(equity, peak);
    drawdown = Math.max(drawdown, 1 - equity / peak);
  }
  return { result: equity - 1, drawdown };
}

export async function runIdeaResearch(db: Db, userId: string, idea: StrategyIdea, asOf: string): Promise<ResearchStep> {
  const now = Date.parse(asOf);
  const checkpoint = await db.from('automation_runs').select('trial:report->data->trial').eq('user_id', userId)
    .eq('market', idea.market).eq('idea_id', idea.id).eq('kind', 'focused').eq('status', 'completed')
    .not('report->data->trial', 'is', null).order('as_of', { ascending: false }).limit(1).maybeSingle();
  if (checkpoint.error) throw new Error('Could not read the strategy paper record.');
  const prior = (checkpoint.data?.trial ?? null) as unknown as NamedTrial | null;
  const fills: TrialFill[] = [];
  const finish = (evidence: Evidence, availableFrom: number, through: number) => ({ symbol: idea.symbol, evidence: [evidence],
    trial: updateTrial(evidence, prior, fills, availableFrom, through, Date.now()) });
  const resume = prior?.fills.at(-1)?.exit ?? prior?.started ?? Infinity;
  if (idea.market === 'crypto') {
    let complete = true;
    const studies = await cryptoStudy(idea.symbol, now, 'daily', (bars, rates) => {
      const start = bars.findIndex(b => b.t > resume && (!!prior?.fills.length || b.t - hour >= resume));
      if (start === -1) return;
      if (start < WARMUP_BARS || bars.slice(start).some(b => !rates.has(b.t + hour))) {
        complete = false;
        return;
      }
      const run = simulate(bars, getStrategy(idea.rule)!, false, new Map(), start, { hourlyFunding: rates });
      for (const t of run.trades) fills.push({ entry: t.entryT, exit: t.exitT, net: t.net });
    });
    return finish(studies.find(e => e.rule === idea.rule)!, complete ? now - 1900 * hour : Infinity, Math.floor(now / hour) * hour);
  }
  const broker = await stockFeed(db, userId);
  if (idea.executable) {
    const rule = idea.rule as DailyStockRule;
    const { from, to } = researchWindow(now, 'stocks');
    const stock = await loadPortfolioReplayMarket(broker, idea.symbol as StockTradeSymbol, [rule], from, to, false, 570);
    const evidence = stockEvidence(idea.symbol, rule, rule === 'inside-day' ? stock.regular : stock.daily);
    if (!evidence) throw new Error('Paired stock history is unavailable for this rule.');
    const bars = rule === 'inside-day' ? stock.regular : stock.daily;
    const start = bars.findIndex(b => Date.parse(b.day) >= resume);
    if (start >= (rule === 'inside-day' ? 50 : 100)) {
      simulateStockRule(bars, rule, start, bars.length, stockCosts, stockEntryAllowed, (entry, exit, net) =>
        fills.push({ entry: Date.parse(entry.day), exit: Date.parse(exit.day), net }));
    }
    return finish(evidence, start >= 0 && start < (rule === 'inside-day' ? 50 : 100) ? Infinity : Date.parse(bars[rule === 'inside-day' ? 50 : 100].day), Date.parse(bars.at(-1)!.day));
  }
  const end = isoDay(now);
  const { validationFrom, holdoutFrom } = stockLabWindows(end);
  const sessions = await loadIntradaySessions(broker, idea.symbol, end);
  const usable = sessions?.filter(session => session.day >= validationFrom) ?? [];
  if (!sessions || usable.filter(s => s.day < holdoutFrom).length < 20 || usable.filter(s => s.day >= holdoutFrom).length < 20 ||
      Date.parse(end) - Date.parse(usable.at(-1)!.day) > 7 * 86_400_000) {
    throw new Error('Paired five-minute stock history is unavailable.');
  }
  if (idea.rule !== 'close' && usable.filter(s => s.bars.slice(0, 30).every(bar => bar.volume > 0)).length < usable.length * .8) {
    throw new Error('The eToro history lacks usable intraday volume.');
  }
  const rule = idea.rule as 'orb-rvol' | 'vwap' | 'close' | 'close-volume';
  const control = { 'orb-rvol': 'orb', vwap: 'vwap-unfiltered', close: 'close', 'close-volume': 'close' } as const;
  const cost = { slipBps: 3, fee: 1, stressSlipBps: 6, stressFee: 2 };
  const early = replayStockIntraday(sessions, rule, validationFrom, holdoutFrom, cost);
  const later = replayStockIntraday(sessions, rule, holdoutFrom, end, cost);
  const baseline = rule === 'close' ? [] : replayStockIntraday(sessions, control[rule], holdoutFrom, end, cost);
  const earlier = intradayPerformance(early, 'netBps');
  const heldOut = intradayPerformance(later, 'netBps');
  const stressed = intradayPerformance(later, 'stressBps');
  const evidence = studyEvidence({ market: 'stocks', symbol: idea.symbol, rule, name: idea.name,
    trades: early.length + later.length, holdoutTrades: later.length, early: earlier.result, later: heldOut.result,
    stress: stressed.result, benchmark: intradayPerformance(baseline, 'netBps').result,
    drawdown: Math.max(earlier.drawdown, heldOut.drawdown, stressed.drawdown), from: usable[0].day, through: usable.at(-1)!.day });
  for (const trade of later) {
    const day = Date.parse(trade.day);
    fills.push({ entry: day, exit: day, net: trade.netBps / 10_000 });
  }
  return finish(evidence, Date.parse(holdoutFrom), Date.parse(usable.at(-1)!.day));
}

async function cryptoStudy(symbol: string, asOf: number, kind: AutomationKind,
  observe?: (bars: Awaited<ReturnType<ReturnType<typeof marketDataClient>['getCandles']>>, funding: Map<number, number>) => void) {
  const close = Math.floor(asOf / hour) * hour;
  const start = close - 4600 * hour;
  const hl = marketDataClient();
  const [history, rates] = await Promise.all([
    hl.getCandles(symbol, '1h', start, close),
    hl.getFundingRates(symbol, close - 2220 * hour, close),
  ]);
  const bars = history.filter(bar => bar.t < close);
  const funding = new Map(rates.map(rate => [Math.round(rate.time / hour) * hour, rate.rate]));
  if (bars.length < WARMUP_BARS + 1600 || bars.at(-1)?.t !== close - hour ||
      bars.some((bar, i) => i > 0 && bar.t - bars[i - 1].t !== hour) || funding.size < 1900) {
    throw new Error('Complete hourly prices and funding are unavailable.');
  }
  if (observe) observe(bars, funding);
  const split = WARMUP_BARS + Math.floor((bars.length - WARMUP_BARS) * .7);
  const benchmark = bars.at(-1)!.c / bars[split].o - 1 - 2 * COST;
  return CRYPTO_RESEARCH_RULES.map(id => {
    const rule = getStrategy(id)!;
    const withFunding = { hourlyFunding: funding };
    const early = simulate(bars.slice(0, split), rule, false, new Map(), WARMUP_BARS, withFunding);
    const later = simulate(bars, rule, false, new Map(), split, withFunding);
    const scale = kind === 'weekly' ? 2.5 : 2;
    const stress = simulate(bars, rule, false, new Map(), split, { ...withFunding, cost: COST * scale, stopSlippage: STOP_SLIPPAGE * scale });
    return studyEvidence({ market: 'crypto', symbol, rule: id, name: rule.name, trades: early.trades.length + later.trades.length,
      holdoutTrades: later.trades.length, early: performance(early).gain, later: performance(later).gain, stress: performance(stress).gain,
      benchmark, drawdown: Math.max(performance(early).drawdown, performance(later).drawdown, performance(stress).drawdown),
      from: isoDay(bars[WARMUP_BARS].t), through: isoDay(bars.at(-1)!.t) });
  });
}

export async function runResearchStep(db: Db, userId: string, market: AutomationMarket, kind: AutomationKind, symbol: string, asOf: string): Promise<ResearchStep> {
  const now = Date.parse(asOf);
  if (market === 'crypto') return { symbol, evidence: await cryptoStudy(symbol, now, kind) };
  if (symbol === 'eToro journal') return { symbol, journal: await refreshScheduledStockJournal(db, userId) };
  const broker = await stockFeed(db, userId);
  if (kind === 'weekly') {
    const lab = await loadLabMarket(broker, symbol as LabSymbol, isoDay(now), labCosts);
    if (!lab?.days.length) throw new Error('Paired five-minute stock quotes are unavailable.');
    return { symbol, lab };
  }
  const { from, to } = researchWindow(now, market);
  const stock = await loadPortfolioReplayMarket(broker, symbol as StockTradeSymbol, [...STOCK_RESEARCH_RULES], from, to, false, 570);
  if (stock.daily.length < 260) throw new Error('Paired daily stock quotes are unavailable.');
  const evidence = symbol === 'SPY' ? [] : STOCK_RESEARCH_RULES.flatMap(rule => {
    const result = stockEvidence(symbol, rule, rule === 'inside-day' ? stock.regular : stock.daily);
    return result ? [result] : [];
  });
  if (symbol !== 'SPY' && evidence.length !== STOCK_RESEARCH_RULES.length) throw new Error('One or more stock rules lack paired session history.');
  return { symbol, stock, evidence };
}

export function finishResearch(market: AutomationMarket, kind: AutomationKind, asOf: string, work: ResearchStep[]): RunReport {
  const missing = work.filter(item => item.problem).map(item => ({ symbol: item.symbol, detail: item.problem }));
  const evidence = work.flatMap(item => item.evidence ?? []).map(item => missing.some(row => row.symbol !== 'eToro journal')
    ? { ...item, qualified: false, reason: 'The scheduled basket has incomplete data' } : item);
  const qualifies = evidence.filter(item => item.qualified).length;
  if (market === 'stocks' && kind === 'weekly') {
    const report = summarizeStockLab(work.flatMap(item => item.lab ? [item.lab] : []), isoDay(Date.parse(asOf)), labCosts);
    return { evidence: [], data: { report, missing }, summary: `${report.markets.length} stocks tested · ${report.reports.filter(item => item.status === 'Paper candidate').length} lab candidates` };
  }
  if (market === 'stocks') {
    const inputs = work.flatMap(item => item.stock ? [item.stock] : []);
    const spy = inputs.find(item => item.symbol === 'SPY')?.daily;
    const { from, to } = researchWindow(Date.parse(asOf), market);
    const basket = spy?.length ? replayStockPortfolio(inputs, spy, { ...DEFAULT_STOCK_PORTFOLIO, capital: 10_000,
      from, to, symbols: inputs.filter(item => item.symbol !== 'SPY').map(item => item.symbol), strategies: [...STOCK_RESEARCH_RULES] }, stockCosts) : null;
    const journal = work.find(item => item.journal)?.journal ?? null;
    return { evidence, data: { missing, portfolio: basket, journal }, summary: `${evidence.length} stock tests · ${qualifies} meet the Paper gate` };
  }
  return { evidence, data: { missing, funding: 'Observed hourly Hyperliquid funding', benchmark: 'Same-market buy and hold over the holdout' },
    summary: `${evidence.length} crypto tests · ${qualifies} meet the Paper gate` };
}
