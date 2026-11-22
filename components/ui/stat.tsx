import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

interface StatProps {
  label: string;
  value: string;
  hint?: string;
  /** Colours the value: profit green, loss red, or plain. */
  tone?: 'up' | 'down' | 'neutral';
  loading?: boolean;
  className?: string;
}

/** A labelled figure. Used in grids of headline numbers. */
export function Stat({ label, value, hint, tone = 'neutral', loading, className }: StatProps) {
  return (
    <div className={cn('surface px-4 py-3.5', className)}>
      <p className="eyebrow">{label}</p>
      {loading ? (
        <Skeleton className="h-7 w-24 mt-2" />
      ) : (
        <p className={cn('num text-xl sm:text-2xl font-semibold mt-1.5 leading-none', tone === 'up' && 'text-profit', tone === 'down' && 'text-loss')}>
          {value}
        </p>
      )}
      {hint && <p className="text-xs text-muted-foreground mt-1.5 truncate">{hint}</p>}
    </div>
  );
}

/** Tooltip body shared by the charts, so they all read the same way. */
export function ChartTooltip({ title, rows }: { title: string; rows: Array<{ label: string; value: string; color?: string }> }) {
  return (
    <div className="rounded-lg border border-border bg-popover/95 backdrop-blur px-3 py-2 shadow-xl text-xs min-w-[150px]">
      <p className="text-muted-foreground mb-1.5">{title}</p>
      <div className="space-y-1">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              {r.color && <span className="w-2 h-2 rounded-full" style={{ background: r.color }} />}
              {r.label}
            </span>
            <span className="num font-medium text-foreground">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
