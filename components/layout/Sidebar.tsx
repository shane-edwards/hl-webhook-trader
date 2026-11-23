'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/brand';
import {
  LayoutDashboard, ArrowLeftRight, BarChart3, Settings, LogOut, CandlestickChart, FlaskConical, Radar, Bot, Landmark,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem { href: string; label: string; short: string; icon: LucideIcon }

const navGroups: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Trade',
    items: [
      { href: '/dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard },
      { href: '/autopilot', label: 'Autopilot', short: 'Auto', icon: Bot },
      { href: '/trades', label: 'Trades', short: 'Trades', icon: ArrowLeftRight },
    ],
  },
  {
    title: 'Research',
    items: [
      { href: '/markets', label: 'Crypto Markets', short: 'Crypto', icon: Radar },
      { href: '/stocks', label: 'US Stocks', short: 'Stocks', icon: Landmark },
      { href: '/lab', label: 'Strategy Lab', short: 'Lab', icon: FlaskConical },
      { href: '/analytics', label: 'Analytics', short: 'Stats', icon: BarChart3 },
    ],
  },
  {
    title: 'System',
    items: [{ href: '/settings', label: 'Settings', short: 'Settings', icon: Settings }],
  },
];
const allItems = navGroups.flatMap(g => g.items);

const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="hidden lg:flex flex-col w-60 fixed inset-y-0 left-0 z-40 border-r border-border bg-card/60 backdrop-blur-xl">
      <div className="flex items-center gap-3 px-5 h-16 border-b border-border">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-[hsl(250_70%_60%)] shadow-lg shadow-primary/20">
          <CandlestickChart className="w-[18px] h-[18px] text-white" />
        </div>
        <div className="leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-foreground block">{APP_NAME}</span>
          <span className="text-[11px] text-muted-foreground">Crypto and US stocks</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6" aria-label="Main">
        {navGroups.map(group => (
          <div key={group.title}>
            <p className="eyebrow px-3 mb-1.5">{group.title}</p>
            <div className="space-y-0.5">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-3 px-3 h-9 rounded-lg text-sm font-medium transition-colors',
                      active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
                    )}
                  >
                    {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />}
                    <Icon className={cn('w-4 h-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                    {label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-border">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 h-9 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors w-full"
        >
          <LogOut className="w-4 h-4 shrink-0" />
          Sign out
        </button>
      </div>
    </aside>
  );
}

// Mobile bottom nav
export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/85 backdrop-blur-xl px-1 pt-1.5 pb-safe grid"
      style={{ gridTemplateColumns: `repeat(${allItems.length}, minmax(0, 1fr))` }}
    >
      {allItems.map(({ href, short, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-col items-center gap-1 py-1.5 rounded-lg transition-colors min-w-0',
              active ? 'text-primary' : 'text-muted-foreground active:text-foreground'
            )}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] font-medium truncate max-w-full">{short}</span>
          </Link>
        );
      })}
    </nav>
  );
}
