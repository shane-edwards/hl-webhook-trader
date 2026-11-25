/**
 * Who may use this deployment.
 *
 * Supabase decides who can sign in; this decides who may use the app once
 * signed in. `ALLOWED_EMAILS` is a comma-separated list. When it is set, any
 * other account is refused on every page and API route, even if sign-ups are
 * open on the Supabase project. When it is not set, every signed-in account is
 * allowed (the behaviour before this check existed).
 */
export function allowedEmails(): Set<string> | null {
  const list = (process.env.ALLOWED_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  return list.length ? new Set(list) : null;
}

export function accountAllowed(email: string | null | undefined): boolean {
  const allowed = allowedEmails();
  return !allowed || (!!email && allowed.has(email.trim().toLowerCase()));
}

/**
 * Where to send someone after sign-in. Only a path on this site is accepted:
 * anything that could leave it (`//host`, `/\host`, `@host`, a full URL) falls
 * back to the default page.
 */
export function safeRedirectPath(next: string | null | undefined, origin: string, fallback = '/strategies'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  try {
    const target = new URL(next, origin);
    const path = `${target.pathname}${target.search}${target.hash}`;
    // Normalising can itself produce `//host` (from `/.//host`), so the result is checked as well.
    return target.origin === new URL(origin).origin && !path.startsWith('//') && new URL(path, origin).origin === target.origin ? path : fallback;
  } catch {
    return fallback;
  }
}
