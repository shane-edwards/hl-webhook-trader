'use client';

import { usePathname } from 'next/navigation';
import { Bell, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const pageTitles: Record<string, { title: string; description: string }> = {
  '/dashboard': { title: 'Dashboard', description: 'Portfolio overview and active positions' },
  '/trades': { title: 'Trades', description: 'Full trade history and management' },
  '/analytics': { title: 'Analytics', description: 'Performance metrics and quant analysis' },
  '/settings': { title: 'Settings', description: 'Configure trading parameters and webhook' },
};

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Header({ onRefresh, refreshing }: HeaderProps) {
  const pathname = usePathname();
  const page = pageTitles[pathname] ?? { title: 'HL Trader', description: '' };

  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-30">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{page.title}</h1>
        <p className="text-xs text-muted-foreground hidden sm:block">{page.description}</p>
      </div>

      <div className="flex items-center gap-2">
        {onRefresh && (
          <Button variant="ghost" size="icon" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        )}
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-4 h-4" />
        </Button>
      </div>
    </header>
  );
}
