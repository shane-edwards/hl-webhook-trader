import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string;
  description?: string;
  icon?: LucideIcon;
  status?: 'positive' | 'negative' | 'neutral' | 'warning';
  large?: boolean;
}

const statusColors = {
  positive: 'text-profit',
  negative: 'text-loss',
  warning: 'text-warning',
  neutral: 'text-foreground',
};

export function MetricCard({ label, value, description, icon: Icon, status = 'neutral', large }: MetricCardProps) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 hover:border-primary/20 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
      </div>
      <p className={cn(
        'font-bold tabular-nums leading-none',
        large ? 'text-3xl' : 'text-xl',
        statusColors[status]
      )}>
        {value}
      </p>
      {description && (
        <p className="text-xs text-muted-foreground mt-1.5">{description}</p>
      )}
    </div>
  );
}
