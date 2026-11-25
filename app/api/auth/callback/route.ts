import { createClient } from '@/lib/supabase/server';
import { safeRedirectPath } from '@/lib/access';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  // `next` comes from the link, so it is only ever used as a path on this site.
  const next = safeRedirectPath(searchParams.get('next'), origin);

  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(new URL(next, origin));
}
