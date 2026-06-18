import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface StatsCardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
  loading?: boolean;
  iconColor?: string;
}

export function StatsCard({
  title, value, subtitle, icon: Icon, trend, className, loading, iconColor = 'text-primary',
}: StatsCardProps) {
  if (loading) {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
        <div className="flex items-start justify-between mb-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-8 rounded-lg" />
        </div>
        <Skeleton className="h-7 w-32 mb-1" />
        <Skeleton className="h-3 w-20" />
      </div>
    );
  }

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5 hover:border-primary/20 transition-colors', className)}>
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{title}</p>
        <div className={cn('flex items-center justify-center w-8 h-8 rounded-lg bg-secondary', iconColor)}>
          <Icon className="w-4 h-4" />
        </div>
      </div>

      <div className="space-y-0.5">
        <p
          className={cn(
            'text-2xl font-bold tabular-nums leading-none',
            trend === 'up' ? 'text-profit' : trend === 'down' ? 'text-loss' : 'text-foreground'
          )}
        >
          {value}
        </p>
        {subtitle && (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
