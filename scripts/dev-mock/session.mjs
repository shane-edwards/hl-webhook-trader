// The one fake user the mock knows about, and the session that represents them.
// Shared by server.mjs (answers /auth/v1/*) and screenshot.mjs (forges the cookie).

export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEV_EMAIL = 'dev@example.com';

const FAR_FUTURE = 4102444800; // 2100-01-01, in seconds

export function devUser() {
  const created = '2025-01-01T00:00:00.000Z';
  return {
    id: DEV_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: DEV_EMAIL,
    email_confirmed_at: created,
    phone: '',
    confirmed_at: created,
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: created,
    updated_at: created,
    is_anonymous: false,
  };
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** JWT-shaped but unsigned: the mock never verifies it, and no real Supabase would accept it. */
export function devAccessToken() {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: 'dev-mock', sub: DEV_USER_ID, aud: 'authenticated', role: 'authenticated',
    email: DEV_EMAIL, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE, session_id: 'dev-mock-session',
  };
  return `${b64url(header)}.${b64url(payload)}.dev-mock-unsigned`;
}

export function devSession() {
  return {
    access_token: devAccessToken(),
    token_type: 'bearer',
    expires_in: FAR_FUTURE - Math.floor(Date.now() / 1000),
    expires_at: FAR_FUTURE,
    refresh_token: 'dev-mock-refresh-token',
    user: devUser(),
  };
}

/**
 * Cookies exactly as @supabase/ssr 0.5 writes them (see node_modules/@supabase/ssr/dist/main/cookies.js
 * and utils/chunker.js): name `sb-<first hostname label>-auth-token`, value `base64-` + base64url(JSON),
 * split into `.0`, `.1`, ... when the URI-encoded value is longer than 3180 characters.
 */
export function sessionCookies(supabaseUrl) {
  const name = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
  const value = 'base64-' + Buffer.from(JSON.stringify(devSession())).toString('base64url');
  const MAX_CHUNK_SIZE = 3180;
  if (value.length <= MAX_CHUNK_SIZE) return [{ name, value }]; // base64url needs no URI escaping
  const chunks = [];
  for (let i = 0; i < value.length; i += MAX_CHUNK_SIZE) chunks.push(value.slice(i, i + MAX_CHUNK_SIZE));
  return chunks.map((chunk, i) => ({ name: `${name}.${i}`, value: chunk }));
}
