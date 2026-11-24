'use client';

import { useEffect, useState } from 'react';
import { FAMILIES, searchPair, type SearchMarket, type SearchPair, type SearchReport, type SearchFrame } from '@/lib/strategy-search/model';

type SearchState = { status: string; report: SearchReport | null; canStart: boolean; detail?: string };
export const frameNames: Record<SearchFrame, string> = { '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '4h': '4 hours', '1d': 'Daily' };

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;

function readStatus(payload: SearchState | null) {
  if (!payload) return 'Checking research…';
  if (payload.status === 'unsupported') return 'Research unavailable for this market and timeframe';
  if (payload.status === 'connect') return 'Connect eToro to run this search';
  if (payload.status === 'failed') return 'Research needs attention';
  if (payload.status === 'busy') return 'Research queue is full';
  if (payload.status === 'queued' || payload.status === 'new') return 'Search queued';
  if (payload.status === 'running') return 'Testing strategies…';
  if (payload.report?.verdict === 'insufficient-history') return 'More price history needed';
  if (payload.report?.verdict === 'paper-candidate' && payload.report.rule) return `Paper candidate · ${FAMILIES[payload.report.rule.family]}`;
  return 'No indicator combination passed';
}

export function StrategySearch({ market, symbol, frame, active = true, compact = false }: {
  market: SearchMarket; symbol: string; frame: SearchFrame; active?: boolean; compact?: boolean;
}) {
  const pair = searchPair(market, symbol, frame);
  const key = pair ? `${market}/${symbol}/${frame}` : null;
  const [data, setData] = useState<{ key: string; payload: SearchState }>();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !key) return;
    const match: SearchPair = { market, symbol, frame };
    const controller = new AbortController();
    const request = async () => {
      try {
        const response = await fetch(`/api/strategy-search?${new URLSearchParams(match)}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        let payload = await response.json() as SearchState;
        if (payload.canStart) {
          const queued = await fetch('/api/strategy-search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(match), signal: controller.signal });
          if (!queued.ok) throw new Error();
          payload = await queued.json();
        }
        if (!controller.signal.aborted) { setData({ key, payload }); setFailed(null); }
      } catch {
        if (!controller.signal.aborted) setFailed(key);
      }
    };
    const start = setTimeout(() => void request(), 500);
    const poll = setInterval(() => void request(), 20_000);
    return () => { controller.abort(); clearTimeout(start); clearInterval(poll); };
  }, [market, symbol, frame, key, active]);
  if (!active) return null;
  const payload = key ? data?.key === key ? data.payload : null : { status: 'unsupported', report: null, canStart: false };
  const { report } = payload ?? {};
  return <section className={compact ? 'rounded-lg border border-border p-3 space-y-1' : 'surface p-4 sm:p-5 space-y-3'} aria-label="Strategy research">
    {!compact && <h2 className="font-semibold">{symbol} · {frameNames[frame]}</h2>}
    <p role="status" className="text-sm font-medium">{failed === key && key ? 'Research temporarily unavailable' : readStatus(payload)}</p>
    {!!report?.tried && <p className="text-xs text-muted-foreground">{report.tried.toLocaleString()} setups tested · {report.from} to {report.through}</p>}
    {report && <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Search results</summary>
      <div className="space-y-1 mt-2">
        <p>{report.source} · {report.bars.toLocaleString()} candles</p>
        <p>{report.validationPassed} qualified for the final test · {report.testedOnLaterData} tested on later data</p>
        {report.holdout && <p>{report.holdout.trades} later trades · {pct(report.holdout.net)} after costs · {pct(report.stress?.net ?? 0)} with higher costs · {pct(report.stress?.drawdown ?? 0)} drawdown</p>}
        {report.venue && <p>Hyperliquid check · {report.venue.trades} trades · {pct(report.venue.net)} after costs and funding</p>}
        {report.note && <p>{report.note}</p>}
        {report.verdict === 'paper-candidate' && report.rule && <p>{report.rule.setting}-bar setting · {report.rule.stop}× ATR stop · {report.rule.reward}× risk target · {report.rule.maxBars} bars max</p>}
      </div>
    </details>}
  </section>;
}
