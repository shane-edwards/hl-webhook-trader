import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const MACHINE_PATHS = new Set([
  '/api/webhook', '/api/health', '/api/cron/strategy', '/api/cron/autopilot', '/api/cron/market',
  '/api/cron/fast', '/api/cron/stocks', '/api/cron/stock-autopilot', '/api/cron/stock-catalysts', '/api/cron/automation',
]);

// Next 16 calls this file proxy.ts (it was middleware.ts before).
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: Record<string, unknown> }>) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as Parameters<typeof supabaseResponse.cookies.set>[2])
          );
        },
      },
    }
  );

  const pathname = request.nextUrl.pathname;
  const { data: { user } } = MACHINE_PATHS.has(pathname) ? { data: { user: null } } : await supabase.auth.getUser();

  // Machine endpoints authenticate themselves (webhook secret / CRON_SECRET), and
  // /api/health is public by design (it exposes no account data).
  // Exact matches only, so /api/webhook-logs still goes through session auth.
  if (MACHINE_PATHS.has(pathname)) return NextResponse.next();

  // API callers get a 401, not a redirect to an HTML login page.
  if (!user && pathname.startsWith('/api/') && !pathname.startsWith('/api/auth')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Allow auth callback
  if (pathname.startsWith('/api/auth')) {
    return supabaseResponse;
  }

  // Redirect unauthenticated users to login
  if (!user && !pathname.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Redirect authenticated users away from login
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  // Redirect root to dashboard
  if (user && pathname === '/') {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
