'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ClipboardCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Calibration, ScoreRow } from '@/lib/scorecard';

interface Paired { ideas: number; level: { hitRate: number; avgPct: number; avgStopPct: number }; volatility: { hitRate: number; avgPct: number; avgStopPct: number } }
interface Historical {
  generatedThrough?: string; coins?: string[]; ideas?: number; costPct?: number; verdict?: string; edge?: string;
  periods?: Array<{ name: string; ideas: number; avgPct: number; rows: ScoreRow[]; paired: Paired }>;
}
interface Data { available: boolean; live: { since: string | null; rows: ScoreRow[]; calibration?: Calibration }; historical: Historical }

const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`);
const toneOf = (v: number | null | undefined) => (v == null ? '' : v > 0 ? 'text-profit' : v < 0 ? 'text-loss' : '');

function Table({ rows }: { rows: ScoreRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead><tr><th>Group</th><th>Ideas</th><th>Reached target first</th><th>Avg result</th><th>After 1 day</th><th>After 3 days</th><th>After 7 days</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.group}>
              <td className="font-medium">{r.group}</td>
              <td className="num">{r.ideas}</td>
              <td className="num">{r.hitRate == null ? '—' : `${r.hitRate.toFixed(0)}% of ${r.decided}`}</td>
              <td className={cn('num', toneOf(r.avgR))}>{r.avgR == null ? '—' : `${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)}R`}</td>
              <td className={cn('num', toneOf(r.avgRet1d))}>{pct(r.avgRet1d)}</td>
              <td className={cn('num', toneOf(r.avgRet3d))}>{pct(r.avgRet3d)}</td>
              <td className={cn('num', toneOf(r.avgRet7d))}>{pct(r.avgRet7d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const share = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);

/** Predicted chance of target before stop, against how often it happened. */
function CalibrationBlock({ c }: { c: Calibration }) {
  const verdict = c.scored < 30 || c.skill == null ? { label: `Testing · ${c.scored} of 30 scored`, tone: 'text-muted-foreground' }
    : c.skill > 0.02 ? { label: 'Predictions are helping', tone: 'text-profit' }
    : c.skill < -0.02 ? { label: 'Predictions are misleading', tone: 'text-loss' }
    : { label: 'Predictions add nothing yet', tone: 'text-muted-foreground' };
  return (
    <div className="pt-5">
      <div className="px-5 pb-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold">Predicted against actual</h3>
          <span className={cn('text-xs font-medium', verdict.tone)}>{verdict.label}</span>
        </div>
        {c.scored > 0 && <p className="mt-1 text-sm tabular-nums">
          <span className="text-muted-foreground">Predicted</span> {share(c.meanPredicted)} <span className="text-muted-foreground">· reached target</span> {share(c.hitRate)}
        </p>}
      </div>
      {c.scored > 0 && <div className="overflow-x-auto">
        <table className="data-table">
          <thead><tr><th>Predicted</th><th>Ideas</th><th>Avg predicted</th><th>Reached target</th></tr></thead>
          <tbody>
            {c.buckets.filter(b => b.ideas > 0).map(b => (
              <tr key={b.label}>
                <td className="font-medium">{b.label}</td>
                <td className="num">{b.ideas}</td>
                <td className="num">{share(b.predicted)}</td>
                <td className="num">{share(b.actual)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </div>
  );
}

/** How the trade ideas have actually done: the live record so far, and a replay over history. */
export function Scorecard() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState(0);

  useEffect(() => {
    fetch('/api/scorecard').then(r => (r.ok ? r.json() : null)).then(d => { setData(d); setPeriod(Math.max(0, (d?.historical?.periods?.length ?? 1) - 1)); }).catch(() => {});
  }, []);

  const h = data?.historical;
  const live = data?.live;
  const liveIdeas = live?.rows[0]?.ideas ?? 0;
  const p = h?.periods?.[period];

  return (
    <section className="surface" aria-label="Scorecard for trade ideas">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex w-full items-start gap-3 px-5 py-4 text-left">
        <ClipboardCheck className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Have these ideas worked?</h2>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {h?.edge ?? 'Loading the record…'} {h?.verdict ? `Stops: ${h.verdict}` : ''}
          </p>
        </div>
        <ChevronDown className={cn('w-4 h-4 text-muted-foreground shrink-0 mt-0.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open && data && (
        <div className="border-t border-border/70 pb-4">
          <div className="px-5 pt-4 pb-2">
            <h3 className="text-xs font-semibold">Live record</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {!data.available ? 'Needs database migration 006.'
                : liveIdeas === 0 ? 'No ideas logged yet. One is logged each time a market turns long or short, then scored over the following week.'
                : `${liveIdeas} ideas logged since ${new Date(live!.since!).toLocaleDateString()}. Too few to judge until there are a few dozen.`}
            </p>
          </div>
          {liveIdeas > 0 && <Table rows={live!.rows} />}
          {liveIdeas > 0 && live?.calibration && <CalibrationBlock c={live.calibration} />}

          {h?.periods?.length ? (
            <>
              <div className="px-5 pt-5 pb-2 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold">Replay over history</h3>
                  <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                    The same rules run hour by hour over {h.coins?.join(', ')} through {h.generatedThrough}. &quot;R&quot; is the result in multiples of the amount risked, before costs.
                    The direction read has seen this data before, so treat it as a description of the past, not a test.
                  </p>
                </div>
                <div className="inline-flex rounded-lg bg-secondary p-0.5 border border-border">
                  {h.periods.map((x, i) => (
                    <button key={x.name} type="button" onClick={() => setPeriod(i)} aria-pressed={i === period}
                      className={cn('px-2.5 h-7 rounded-md text-xs font-medium', i === period ? 'bg-background text-foreground shadow' : 'text-muted-foreground')}>
                      {x.name}
                    </button>
                  ))}
                </div>
              </div>
              {p && (
                <>
                  <Table rows={p.rows} />
                  <p className="px-5 pt-3 text-xs text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">Same entries, both kinds of stop</span> ({p.paired.ideas} ideas where a level was available), result per idea after {h.costPct}% costs:
                    beyond the level <span className={cn('num', toneOf(p.paired.level.avgPct))}>{pct(p.paired.level.avgPct)}</span> (average stop {p.paired.level.avgStopPct.toFixed(1)}%, target first {p.paired.level.hitRate.toFixed(0)}%);
                    volatility only <span className={cn('num', toneOf(p.paired.volatility.avgPct))}>{pct(p.paired.volatility.avgPct)}</span> (average stop {p.paired.volatility.avgStopPct.toFixed(1)}%, target first {p.paired.volatility.hitRate.toFixed(0)}%).
                  </p>
                </>
              )}
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
