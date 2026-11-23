import { stockFillMetrics, type StockJournalOrder } from './execution-journal';
import { STOCK_TRADE_RULES, type StockTradeRule } from './trade-rules';

export type StockGuardSettings = { enabled: boolean; minimum_trades: number; max_slippage_bps: number; max_net_loss_usd: number };
export type StockGuardState = { strategy: StockTradeRule; reset_at: string; halted_at: string | null; reason: string | null };
export type StockScoreOrder = Pick<StockJournalOrder, 'strategy' | 'state' | 'broker_state' | 'created_at' | 'submission_quote' |
  'fill_metrics' | 'close_execution' | 'statement_result' | 'planned_slippage_bps' | 'planned_net_bps' | 'request'>;
export const DEFAULT_STOCK_GUARD: StockGuardSettings = { enabled: false, minimum_trades: 10, max_slippage_bps: 15, max_net_loss_usd: 100 };
export const SCORE_ORDER_FIELDS = 'strategy, state, broker_state, submission_quote, fill_metrics, close_execution, statement_result, planned_slippage_bps, planned_net_bps, request, created_at';

export function brokerStockGross(row: Pick<StockJournalOrder, 'fill_metrics' | 'close_execution'>) {
  const fill = row.fill_metrics;
  const exits = Object.values(row.close_execution ?? {});
  if (!fill || !exits.length || !exits.every(exit => exit.complete && exit.units != null && exit.rate != null && exit.units > 0 && exit.rate > 0)) return null;
  const units = exits.reduce((sum, exit) => sum + exit.units!, 0);
  if (Math.abs(units - fill.units) > Math.max(0.000001, units * 0.00001)) return null;
  return exits.reduce((sum, exit) => sum + (exit.rate! - fill.price) * exit.units!, 0);
}

export function stockStrategyScore(orders: StockScoreOrder[], states: StockGuardState[], settings: StockGuardSettings) {
  return STOCK_TRADE_RULES.map(({ id: rule, name }) => {
    const state = states.find(item => item.strategy === rule);
    const reset = Date.parse(state?.reset_at ?? '');
    const eligible = (at: string) => Number.isFinite(Date.parse(at)) && (!Number.isFinite(reset) || Date.parse(at) > reset);
    const rows = orders.filter(row => row.strategy === rule && row.state === 'filled' && row.broker_state !== 5);
    const slippage = rows.flatMap(row => {
      const at = row.fill_metrics?.executionAt ?? row.created_at;
      const metrics = stockFillMetrics(row);
      return metrics && eligible(at) ? [{ at, slip: metrics.slipBps, planned: row.planned_slippage_bps }] : [];
    }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
    const latest = rows.flatMap(row => {
      const statement = row.statement_result;
      if (!statement || !eligible(statement.closedAt) || !Number.isFinite(statement.netUsd)) return [];
      const exposure = Number(row.request?.amount) * Number(row.request?.leverage);
      const plannedUsd = row.planned_net_bps == null || !Number.isFinite(exposure) || exposure <= 0 ? null : row.planned_net_bps * exposure / 10_000;
      return [{ ...statement, plannedUsd }];
    }).sort((a, b) => a.closedAt.localeCompare(b.closedAt)).slice(-30);
    const broker = rows.flatMap(row => { const gross = brokerStockGross(row); return gross != null ? [gross] : []; });
    const p75 = (values: number[]) => values.length ? values.sort((a, b) => a - b)[Math.ceil(0.75 * values.length) - 1] : null;
    const slipBps = p75(slippage.map(row => row.slip));
    const slipDriftBps = p75(slippage.flatMap(row => row.planned == null ? [] : [row.slip - row.planned]));
    let net = 0, peak = 0, drawdown = 0;
    for (const row of latest) {
      net += row.netUsd;
      peak = Math.max(peak, net);
      drawdown = Math.max(drawdown, peak - net);
    }
    const slipBreach = slippage.length >= settings.minimum_trades && slipBps != null && slipBps > settings.max_slippage_bps;
    const lossBreach = latest.length >= settings.minimum_trades && drawdown >= settings.max_net_loss_usd;
    const plannedCloses = latest.filter(row => row.plannedUsd != null);
    const netVsPlan = plannedCloses.length ? plannedCloses.reduce((sum, row) => sum + row.netUsd - row.plannedUsd!, 0) : null;
    const reasons = [
      ...(slipBreach ? [`75th-percentile slippage ${slipBps.toFixed(1)} bps exceeded the ${settings.max_slippage_bps} bps limit`] : []),
      ...(lossBreach ? [`Statement net drawdown $${drawdown.toFixed(2)} reached the $${settings.max_net_loss_usd} limit`] : []),
    ];
    return { rule, name, fills: slippage.length, slipBps, slipDriftBps, closes: latest.length, net, drawdown, netVsPlan,
      plannedCloses: plannedCloses.length, brokerCloseCount: broker.length,
      brokerGross: broker.reduce((sum, value) => sum + value, 0), reason: reasons.join(' · ') || null, state: state ?? null };
  });
}
