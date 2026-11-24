'use client';

import Link from 'next/link';
import { toast } from 'sonner';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { APP_NAME } from '@/lib/brand';
import {
  LogOut, CandlestickChart, Layers, ChevronRight, SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
const workspaces = [
  { id: '/strategies', label: 'Strategies', icon: Layers },
  { id: '/tools', label: 'Tools', icon: SlidersHorizontal },
] as const;

export function SignOutButton() {
  const router = useRouter();
  async function handleLogout() {
    const { error } = await createClient().auth.signOut();
    if (error) { toast.error('Sign out failed. Please try again.'); return; }
    router.replace('/login');
    router.refresh();
  }
  return (
    <button
      onClick={handleLogout}
      className="flex items-center gap-3 px-3 h-9 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors w-full"
    >
      <LogOut className="w-4 h-4 shrink-0" />
      Sign out
    </button>
  );
}

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="hidden lg:flex flex-col w-60 fixed inset-y-0 left-0 z-40 border-r border-border bg-card/60 backdrop-blur-xl">
      <div className="flex items-center gap-3 px-5 h-16 border-b border-border">
        <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-[hsl(250_70%_60%)] shadow-lg shadow-primary/20">
          <CandlestickChart className="w-[18px] h-[18px] text-white" />
        </div>
        <div className="leading-tight">
          <span className="text-[15px] font-semibold tracking-tight text-foreground block">{APP_NAME}</span>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1" aria-label="Trading workflow">
        {workspaces.map(({ id, label, icon: Icon }) => {
          const active = path === id || (id === '/strategies' && path.startsWith('/journey/'));
          return (
            <Link
              key={id}
              href={id}
              aria-current={active ? 'location' : undefined}
              className={cn(
                'flex items-center gap-3 px-3 h-11 rounded-lg text-sm font-semibold transition-colors',
                active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              {label}
              {active && <ChevronRight className="w-4 h-4 ml-auto" aria-hidden="true" />}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-border">
        <SignOutButton />
      </div>
    </aside>
  );
}

// Mobile bottom nav
export function MobileNav() {
  const path = usePathname();

  return (
    <nav
      aria-label="Trading workflow"
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 grid grid-cols-2 gap-1 border-t border-border bg-card/95 backdrop-blur-xl px-2 pt-1.5 pb-safe"
    >
      {workspaces.map(({ id, label, icon: Icon }) => {
        const active = path === id || (id === '/strategies' && path.startsWith('/journey/'));
        return (
          <Link
            key={id}
            href={id}
            aria-current={active ? 'location' : undefined}
            className={cn(
              'flex items-center justify-center gap-2 min-h-11 rounded-lg text-sm font-semibold transition-colors',
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground active:text-foreground'
            )}
          >
            <Icon className="w-4 h-4" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
