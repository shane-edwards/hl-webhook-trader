import { ideaId, IDEA_RULES, ideaSearchFrame, type StrategyIdea } from './ideas';
import { automationVersion, type AutomationMarket, type AutomationProfile, type Evidence } from './model';
import type { NamedTrial } from './forward-trials';
import type { PaperResults } from './policy';
import { RULE_INTERPRETER_VERSION, ruleKey, ruleName, searchKey, searchOutcomes,
  RECOMMENDATION_FRESH_MS, type SearchReport } from '@/lib/strategy-search/model';

export type Stage = 'ready' | 'paper' | 'live' | 'activity';
export type PaperScore = { count: number; net: number; drawdown: number; unit: 'usd' | 'fraction'; source: string };
export type StrategyRow = { id: string; market: AutomationMarket; symbol: string; name: string; frame: string; stage: Stage;
  status: string; backtest: string; paper?: PaperScore; backtestNet?: number; backtestTrades?: number; through?: string;
  live: string; version?: string; admission?: string; rule?: string };
export type Workspace = { comparison?: import('./crypto-paper-comparison').ComparisonSummary | null; rows: StrategyRow[]; markets: { market: AutomationMarket; connected: boolean; enabled: boolean;
  discovery: { completed24h: number; lastCompleted: string | null; pending: number };
  needsSetup: boolean; account: boolean; demo: boolean; active: string[]; paused: boolean; budget: number | null; order: number | null }[] };

export const catalogIdeas = (market: AutomationMarket): StrategyIdea[] => IDEA_RULES.filter(i => i.market === market)
  .flatMap(i => i.symbols.map(symbol => ({ ...i, symbol, id: ideaId(market, i.rule, symbol) })));

export function liveVersions(profile?: AutomationProfile | null): string[] {
  if (profile?.mode !== 'live') return [];
  return profile.scan_for_opportunities ? profile.live_scan_versions ?? [] : profile.live_version ? [profile.live_version] : [];
}

export function namedRow(idea: StrategyIdea, e: Evidence | undefined, asOf: string | undefined, trial: NamedTrial | undefined,
  broker: PaperResults | undefined, profile: AutomationProfile | null, brokerTracking: boolean, demo: boolean, now: number): StrategyRow {
  const version = automationVersion(idea.market, idea.symbol, idea.rule);
  const fresh = !!asOf && now - Date.parse(asOf) < RECOMMENDATION_FRESH_MS && Date.parse(asOf) <= now;
  const passed = fresh && e?.qualified === true && e.version === version;
  const ready = idea.executable && passed && broker?.passed;
  const live = liveVersions(profile).includes(version);
  const backtest = !e ? 'Awaiting backtest' : !fresh ? 'Awaiting fresh backtest' : e.qualified ? 'Passed' : e.reason;
  const hasTrial = trial?.version === version;
  const tracking = hasTrial && ['tracking', 'data-gap'].includes(trial.state);
  const stage = live ? 'live' : ready ? 'ready' : tracking || brokerTracking ? 'paper' : 'activity';
  const useBroker = (ready || live || brokerTracking) && !!broker;
  const paper: PaperScore | undefined = useBroker ? { count: broker.closed, net: broker.net, drawdown: broker.drawdown, unit: 'usd',
    source: idea.market === 'stocks' ? 'eToro Demo' : 'Crypto paper fills' } : hasTrial ? { count: trial.count ?? trial.fills.length,
    net: trial.equity - 1, drawdown: trial.drawdown, unit: 'fraction', source: 'Forward simulation' } : undefined;
  let status = backtest;
  if (live) status = !profile?.enabled || profile.entries_paused ? 'Entries paused' : !ready ? 'Waiting for qualifying evidence' : 'Live entries enabled';
  else if (ready) status = 'Ready for review';
  else if (!profile?.enabled && (tracking || brokerTracking)) status = 'Research paused';
  else if (useBroker) status = broker.closed < 10 ? `${broker.closed} of 10 closed trades` :
    broker.days < 5 ? `${broker.days} of 5 trading days` : 'Waiting for paper results to qualify';
  else if (hasTrial) status = trial.state === 'data-gap' ? 'Waiting for market data' : trial.state === 'stopped' ? 'Stopped at drawdown limit' :
    trial.state === 'completed' ? 'Paper trial complete' : `${trial.count ?? trial.fills.length} closed trades`;
  const liveStatus = live ? status : ready ? 'Ready for your approval' : !idea.executable ? 'Paper only' :
    !passed ? 'Requires a passed backtest' : idea.market === 'stocks' && !demo ? 'Requires eToro Demo fills' : 'Awaiting qualifying paper fills';
  return { id: idea.id, name: idea.name, frame: ideaSearchFrame(idea), market: idea.market, symbol: idea.symbol, version,
    backtest, stage, status, paper, live: liveStatus, backtestNet: e?.stress, backtestTrades: e?.holdoutTrades, through: e?.through,
    admission: hasTrial && trial.admission === 'sample' ? 'Small-sample trial' : hasTrial && trial.admission === 'exploratory' ? 'Exploratory paper test' : undefined };
}

function ruleSettings(rule: NonNullable<SearchReport['rule']>) {
  return [rule.recipe ? `Confirm within ${rule.recipe.within} bars` : `${rule.setting}-bar lookback`,
    ...(rule.trend ? [`${rule.trend}-bar trend filter`] : []), ...(rule.volume ? [`${rule.volume}× average volume`] : []),
    `${rule.stop}× ATR stop`, `${rule.reward}× risk target`, `Up to ${rule.maxBars} bars`].join(' · ');
}

export function searchRows(report: SearchReport, enabled: boolean): StrategyRow[] {
  const {pair} = report;
  const prefix = searchKey(pair);
  const outcomes = searchOutcomes(report);
  const rows = new Map<string, StrategyRow>();
  for (const book of report.forward ?? []) {
    const key = ruleKey(book.rule);
    const id = `${prefix}:${book.version}:${key}`;
    const active = book.version === RULE_INTERPRETER_VERSION && (book.state === 'tracking' || book.state === 'data-gap');
    const small = book.admission === 'sample';
    const test = book.backtest ?? outcomes.flatMap(o => o.rule && ruleKey(o.rule) === key && o.stress ?
      [{ net: o.stress.net, trades: o.stress.trades, through: report.through }] : [])[0];
    rows.set(id, { id, ...pair, name: `${book.rule.side === 'short' ? 'Short' : 'Long'} · ${ruleName(book.rule)}`, stage: active ? 'paper' : 'activity', rule: ruleSettings(book.rule),
      status: active && !enabled ? 'Research paused' : book.state === 'data-gap' ? 'Waiting for market data' :
        active ? `${book.count} closed trades` : book.state === 'stopped' ? 'Stopped at drawdown limit' :
        book.state === 'completed' ? 'Paper trial complete' : 'Archived',
      backtest: book.admission === 'exploratory' ? 'Exploratory paper test' : small ? 'Promising · Small sample' : 'Passed at enrollment', through: test?.through, backtestNet: test?.net,
      backtestTrades: test?.trades, live: 'Paper only', paper: { count: book.count, net: book.equity - 1,
        drawdown: book.drawdown, unit: 'fraction', source: 'Forward simulation' } });
  }
  for (const o of outcomes) {
    if (!o.rule) continue;
    const key = ruleKey(o.rule), id = `${prefix}:${RULE_INTERPRETER_VERSION}:${key}`;
    if (!rows.has(id)) rows.set(id, { id, ...pair, rule: ruleSettings(o.rule), name: `${o.rule.side === 'short' ? 'Short' : 'Long'} · ${ruleName(o.rule)}`, stage: 'activity',
      status: o.verdict === 'venue-failed' ? 'Venue test failed' : o.verdict === 'paper-candidate' ? 'Passed backtest' :
        o.verdict === 'small-sample' ? 'Small sample' : 'Backtest did not pass',
      backtest: o.verdict === 'paper-candidate' ? 'Passed' : o.verdict === 'small-sample' ? 'Small sample' : 'Did not pass',
      backtestNet: o.stress?.net, backtestTrades: o.stress?.trades, through: report.through, live: 'Paper only' });
  }
  if (!rows.size) rows.set(prefix, { id: prefix, ...pair, name: 'Strategy search', stage: 'activity',
    status: report.tried ? `${report.tried} variants tested` : 'Waiting for price history', backtest: 'No qualifier',
    through: report.through, live: 'Paper only' });
  return [...rows.values()];
}
