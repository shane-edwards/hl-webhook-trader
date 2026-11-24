import type { createServiceClient } from '@/lib/supabase/server';
import { marketDataClient } from '@/lib/hyperliquid/from-settings';
import { COST, STOP_SLIPPAGE, simulate, type Run } from '@/lib/autopilot/simulate';
import { getStrategy, WARMUP_BARS } from '@/lib/autopilot/strategies';
import { LAB_SYMBOLS, summarizeStockLab, type LabSymbol } from '@/lib/stocks/intraday-lab';
import { loadLabMarket } from '@/lib/stocks/intraday-lab-data';
import { etoroFromConnection } from '@/lib/stocks/connection';
import { loadPortfolioReplayMarket } from '@/lib/stocks/portfolio-replay-data';
import { replayStockPortfolio, type StockPortfolioInput } from '@/lib/stocks/portfolio-replay';
import { DEFAULT_STOCK_PORTFOLIO } from '@/lib/stocks/portfolio';
import { researchStock } from '@/lib/stocks/research';
import { previousStockSession } from '@/lib/stocks/session';
import { STOCK_TRADE_RULES, type StockTradeSymbol } from '@/lib/stocks/trade-rules';
import { refreshScheduledStockJournal } from './stock-journal';
import { CRYPTO_RESEARCH_RULES, CRYPTO_RESEARCH_SYMBOLS, STOCK_RESEARCH_RULES, STOCK_RESEARCH_SYMBOLS, isoDay, researchWindow,
  studyEvidence, type AutomationKind, type AutomationMarket, type Evidence, type RunReport } from './model';

type Db = ReturnType<typeof createServiceClient>;
const hour = 3_600_000;
const stockCosts = { amount: 1000, commission: 1, slipBps: 3, leverage: 1 as const };
const labCosts = { fee: 1, slipBps: 3 };
type LabMarket = Parameters<typeof summarizeStockLab>[0][number];
export type ResearchStep = { symbol: string; stock?: StockPortfolioInput; lab?: LabMarket; evidence?: Evidence[];
  journal?: Awaited<ReturnType<typeof refreshScheduledStockJournal>>; problem?: string };

export function researchPlan(market: AutomationMarket, kind: AutomationKind) {
  return market === 'crypto' ? [...CRYPTO_RESEARCH_SYMBOLS] : kind === 'weekly' ? [...LAB_SYMBOLS] : [...STOCK_RESEARCH_SYMBOLS, 'eToro journal'];
}

class UnavailableData extends Error {}

export function permanentResearchProblem(error: unknown) {
  return error instanceof UnavailableData;
}

async function stockFeed(db: Db, userId: string) {
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

async function cryptoStudy(symbol: string, asOf: number, kind: AutomationKind) {
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
    const bars = rule === 'inside-day' ? stock.regular : stock.daily;
    const result = researchStock(bars, rule, stockCosts, (prev, current) =>
      (current.askOpen - current.bidOpen) / current.askOpen <= .003 &&
      (current.day < '2025-01-01' || previousStockSession(Date.parse(`${current.day}T15:00:00Z`)) === prev.day));
    return result ? [studyEvidence({ market, symbol, rule, name: STOCK_TRADE_RULES.find(item => item.id === rule)!.name, trades: result.trades,
      holdoutTrades: result.holdoutTrades, from: result.from, through: result.to, early: result.earlyReturn, later: result.holdoutReturn,
      stress: result.stressReturn, benchmark: result.holdoutHold * (stockCosts.amount / 10_000), drawdown: result.drawdown })] : [];
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
