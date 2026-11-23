'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { APP_NAME } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { cryptoActivity, cryptoResearch, cryptoSections, isStocksPath, stockHref, stockResearch, stockSection, stockSections } from './workspaces';

const pageTitles: Record<string, string> = {
  '/dashboard': 'Trade crypto',
  '/autopilot': 'Crypto Autopilot',
  '/trades': 'Trade history',
  '/markets': 'Crypto markets',
  '/stocks/intraday': 'Intraday stock research',
  '/stocks/opening': 'Opening volume research',
  '/stocks/factors': 'Earnings and reversal research',
  '/lab': 'Strategy Lab',
  '/lab/scalping': 'Scalping research',
  '/analytics': 'Crypto analytics',
  '/settings': 'Crypto settings',
};

interface HeaderProps {
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function Header({ onRefresh, refreshing }: HeaderProps) {
  const pathname = usePathname();
  const query = useSearchParams();
  const stocks = isStocksPath(pathname);
  const workspace = stocks ? 'Stocks' : 'Crypto';
  const stockTab = pathname === '/stocks' ? stockSection(query.get('tab')) : 'research';
  const cryptoTab = pathname === '/analytics' ? '/trades' : pathname === '/lab/scalping' ? '/lab' : pathname;
  const title = pathname === '/stocks' ? stockSections.find(section => section.id === stockTab)!.title : pageTitles[pathname] ?? APP_NAME;
  const sections = stocks
    ? stockSections.map(section => ({ label: section.label, href: stockHref(section.id), active: stockTab === section.id }))
    : cryptoSections.map(section => ({ ...section, active: cryptoTab === section.href }));
  const subnav = stocks
    ? stockTab === 'research' ? stockResearch : []
    : cryptoTab === '/lab' ? cryptoResearch : cryptoTab === '/trades' ? cryptoActivity : [];

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur-xl">
        <div className="w-full max-w-[1400px] mx-auto px-4 lg:px-8">
          <div className="flex items-center justify-between gap-3 min-h-14 py-2">
            <div className="min-w-0">
              <p className="text-[11px] leading-tight font-medium text-muted-foreground">{workspace}</p>
              <h1 className="text-base sm:text-lg font-semibold tracking-tight text-foreground truncate">{title}</h1>
            </div>
            {onRefresh && (
              <Button variant="ghost" size="icon" className="shrink-0" onClick={onRefresh} disabled={refreshing} aria-label="Refresh">
                <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
              </Button>
            )}
          </div>
          <nav aria-label={`${workspace} sections`} className="grid grid-cols-3 gap-1 sm:flex sm:flex-wrap pb-2">
            {sections.map(({ label, href, active }) => (
              <Link key={href} href={href} aria-current={active ? 'location' : undefined} className={cn(
                'flex min-h-10 sm:min-h-9 items-center justify-center px-2 sm:px-4 rounded-lg text-xs sm:text-sm font-medium transition-colors',
                active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}>{label}</Link>
            ))}
          </nav>
        </div>
      </header>
      {subnav.length > 0 && (
        <nav aria-label={`${workspace} ${cryptoTab === '/trades' ? 'activity' : 'research'}`} className="w-full max-w-[1400px] mx-auto flex flex-wrap gap-x-5 gap-y-1 px-4 lg:px-8 pt-2">
          {subnav.map(item => {
            const active = pathname === ('pathname' in item ? item.pathname : item.href);
            return <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined} className={cn(
              'py-2 border-b-2 text-xs sm:text-sm font-medium hover:text-foreground',
              active ? 'text-foreground border-primary' : 'text-muted-foreground border-transparent'
            )}>{item.label}</Link>;
          })}
        </nav>
      )}
    </>
  );
}
