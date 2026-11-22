'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatPrice } from '@/lib/utils';

export interface ChartCandle { t: number; o: number; h: number; l: number; c: number }
export interface ChartLine {
  price: number;
  label: string;
  kind: 'entry' | 'stop' | 'target' | 'support' | 'resistance';
}

interface Props {
  candles: ChartCandle[];
  lines: ChartLine[];
  height?: number;
  className?: string;
  /** What one candle covers, for the caption: "hourly", "4-hour" and so on. */
  interval?: string;
}

// Entry uses the first chart series colour; stop and target use the same
// red/green as everywhere else and are also told apart by label and dash
// pattern, so the chart does not rely on colour alone.
const STYLE: Record<ChartLine['kind'], { color: string; dash?: string; width: number }> = {
  entry: { color: 'var(--series-1)', width: 1.5 },
  stop: { color: '#ef4444', dash: '6 3', width: 1.5 },
  target: { color: '#22c55e', dash: '2 3', width: 1.5 },
  support: { color: 'hsl(var(--muted-foreground))', dash: '1 4', width: 1 },
  resistance: { color: 'hsl(var(--muted-foreground))', dash: '1 4', width: 1 },
};
const UP = 'hsl(var(--muted-foreground))';
const DOWN = 'hsl(var(--foreground))';

/**
 * Candles with horizontal price lines: support and resistance, and the
 * trade's entry, stop and target. Plain SVG sized to its container, so it
 * stays readable at phone width; the lines follow their props as the user
 * edits the stop or target.
 */
export function LevelsChart({ candles, lines, height = 200, className, interval = 'hourly' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    if (!candles.length || width < 80) return null;
    const labelW = 112;
    const plotW = width - labelW, padY = 10, plotH = height - 2 * padY - 14;
    // Trade lines always fit; support and resistance are shown only when near the price action.
    const trade = lines.filter(l => l.kind === 'entry' || l.kind === 'stop' || l.kind === 'target');
    let lo = Math.min(...candles.map(c => c.l), ...trade.map(l => l.price));
    let hi = Math.max(...candles.map(c => c.h), ...trade.map(l => l.price));
    const pad = (hi - lo) * 0.06 || hi * 0.01;
    lo -= pad; hi += pad;
    const y = (p: number) => padY + ((hi - p) / (hi - lo)) * plotH;
    const step = plotW / candles.length;
    const body = Math.max(1, Math.min(9, step * 0.64));

    // Labels are nudged apart so they never overlap; trade lines take priority over levels.
    const visible = lines.filter(l => l.price >= lo && l.price <= hi)
      .sort((a, b) => Number(a.kind === 'support' || a.kind === 'resistance') - Number(b.kind === 'support' || b.kind === 'resistance'));
    const placed: Array<{ line: ChartLine; ly: number }> = [];
    for (const line of visible) {
      const ly = y(line.price);
      const isLevel = line.kind === 'support' || line.kind === 'resistance';
      if (isLevel && placed.some(p => Math.abs(p.ly - ly) < 12)) { placed.push({ line, ly: NaN }); continue; }
      let at = ly;
      for (let k = 0; k < 6 && placed.some(p => Math.abs(p.ly - at) < 12); k++) at += at >= ly ? 12 : -12;
      placed.push({ line, ly: Math.min(height - 16, Math.max(8, at)) });
    }
    const first = candles[0].t, last = candles[candles.length - 1].t;
    return { plotW, plotH, padY, y, step, body, placed, first, last };
  }, [candles, lines, width, height]);

  const day = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div className={className}>
      <div ref={ref} style={{ height }}>
      {view && (
        <svg width={width} height={height} role="img"
          aria-label={`Price chart, ${interval} candles, with ${lines.filter(l => l.kind !== 'support' && l.kind !== 'resistance').map(l => `${l.label} at ${formatPrice(l.price)}`).join(', ') || 'support and resistance levels'}`}>
          {candles.map((c, i) => {
            const x = i * view.step + view.step / 2, up = c.c >= c.o;
            const top = view.y(Math.max(c.o, c.c)), bottom = view.y(Math.min(c.o, c.c));
            return (
              <g key={c.t} stroke={up ? UP : DOWN} fill={up ? 'none' : DOWN} opacity={0.85}>
                <line x1={x} x2={x} y1={view.y(c.h)} y2={view.y(c.l)} strokeWidth={1} />
                <rect x={x - view.body / 2} y={top} width={view.body} height={Math.max(1, bottom - top)} strokeWidth={1} />
              </g>
            );
          })}
          {view.placed.map(({ line, ly }) => {
            const s = STYLE[line.kind], py = view.y(line.price);
            return (
              <g key={`${line.kind}-${line.label}-${line.price}`}>
                <line x1={0} x2={view.plotW} y1={py} y2={py} stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} />
                {Number.isFinite(ly) && (
                  <>
                    {Math.abs(ly - py) > 1 && <line x1={view.plotW} x2={view.plotW + 5} y1={py} y2={ly} stroke={s.color} strokeWidth={1} />}
                    <text x={view.plotW + 7} y={ly + 3.5} fontSize={10} fill={s.color} className="num">
                      {line.label} {formatPrice(line.price)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
          <text x={0} y={height - 2} fontSize={10} fill="hsl(var(--muted-foreground))">{day(view.first)}</text>
          <text x={view.plotW} y={height - 2} fontSize={10} textAnchor="end" fill="hsl(var(--muted-foreground))">{day(view.last)} · {interval}, UTC</text>
        </svg>
      )}
      </div>
    </div>
  );
}
