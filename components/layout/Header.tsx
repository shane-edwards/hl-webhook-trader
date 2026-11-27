'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { RefreshCw, SlidersHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { APP_NAME } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { isStocksPath, stockSection, stockSections } from './workspaces';

const pageTitles: Record<string, string> = {
  '/automation': 'Automation Center',
  '/dashboard': 'Trade crypto',
  '/autopilot': 'Crypto Autopilot',
  '/trades': 'Trade history',
  '/markets': 'Crypto markets',
  '/stocks/intraday': 'Intraday stock research',
  '/stocks/lab': 'US stock intraday lab',
  '/stocks/portfolio': 'Stock portfolio replay',
  '/stocks/journal': 'Stock execution journal',
  '/stocks/catalysts': 'Catalyst scanner and shadow book',
  '/stocks/scorecard': 'Stock strategy scorecard',
  '/stocks/opening': 'Opening volume research',
  '/stocks/factors': 'Earnings and reversal research',
  '/lab': 'Strategy Lab',
  '/lab/scalping': 'Scalping research',
  '/lab/funding': 'Funding gap scanner',
  '/analytics': 'Crypto analytics',
  '/settings': 'Crypto settings',
  '/strategies': 'Strategies',
  '/tools': 'Tools and settings',
  '/journey/find': 'Find a strategy',
  '/journey/test': 'Test a strategy',
  '/journey/trade': 'Trade a strategy',
};

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Header({ onRefresh, refreshing }: HeaderProps) {
  const pathname = usePathname();
  const query = useSearchParams();
  const stocks = isStocksPath(pathname);
  const shared = pathname === '/automation' || pathname === '/tools' || pathname === '/strategies' || pathname.startsWith('/journey/');
  const workspace = shared ? APP_NAME : stocks ? 'Stocks' : 'Crypto';
  const stockTab = pathname === '/stocks' ? stockSection(query.get('tab')) : 'research';
  const title = pathname === '/stocks' ? stockSections.find(section => section.id === stockTab)!.title : pageTitles[pathname] ?? APP_NAME;
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-xl">
        <div className="w-full max-w-[1400px] mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between gap-3 min-h-14 py-2">
            <div className="min-w-0">
              <p className="text-[11px] leading-tight font-medium text-muted-foreground">{workspace}</p>
              <h1 className="text-base sm:text-lg font-semibold tracking-tight text-foreground truncate">{title}</h1>
            </div>
            <div className="flex items-center gap-1">
            {onRefresh && (
              <Button variant="ghost" size="icon" className="shrink-0" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
                <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
              </Button>
            )}
            {pathname !== '/tools' && pathname !== '/strategies' && <Button asChild variant="ghost" size="icon" className="lg:hidden shrink-0" aria-label="Tools and settings">
              <Link href="/tools"><SlidersHorizontal className="w-4 h-4" /></Link>
            </Button>}
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
