'use client';

import { usePathname } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const pageTitles: Record<string, { title: string; description: string }> = {
  '/dashboard': { title: 'Dashboard', description: 'Account, positions and automation at a glance' },
  '/autopilot': { title: 'Autopilot', description: 'Scans markets and trades by tested rules, within your risk limits' },
  '/trades': { title: 'Trades', description: 'Every trade this app has placed' },
  '/markets': { title: 'Markets', description: 'Live funding, open interest and volume across Hyperliquid' },
  '/lab': { title: 'Strategy Lab', description: 'Backtest ideas with real costs before risking money' },
  '/lab/scalping': { title: 'Scalping research', description: 'TradingView ideas tested against perpetual futures data' },
  '/analytics': { title: 'Analytics', description: 'Performance statistics from your trade log' },
  '/settings': { title: 'Settings', description: 'Exchange connection, webhook and strategy' },
};

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Extra controls shown on the right, before the refresh button. */
  actions?: React.ReactNode;
}

export function Header({ onRefresh, refreshing, actions }: HeaderProps) {
  const pathname = usePathname();
  const page = pageTitles[pathname] ?? { title: 'HL Trader', description: '' };

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-3 px-4 lg:px-8 h-16 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-tight text-foreground truncate">{page.title}</h1>
        <p className="text-xs text-muted-foreground hidden sm:block truncate">{page.description}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {actions}
        {onRefresh && (
          <Button variant="ghost" size="icon" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        )}
      </div>
    </header>
  );
}
