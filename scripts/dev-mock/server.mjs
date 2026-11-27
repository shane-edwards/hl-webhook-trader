#!/usr/bin/env node
// A stand-in for Supabase, for local UI previews only. No dependencies.
//
//   node scripts/dev-mock/server.mjs            # listens on :54321 (PORT overrides)
//
// It answers the parts of GoTrue (/auth/v1) and PostgREST (/rest/v1) this app uses,
// from an in-memory copy of fixtures.json. Nothing is verified and nothing is saved:
// every token is the dev user, and a restart resets the data.

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { devSession, devUser } from './session.mjs';

const PORT = Number(process.env.PORT ?? 54321);
const QUIET = process.env.MOCK_QUIET === '1';
const FIXTURES = fileURLToPath(new URL('./fixtures.json', import.meta.url));

// What the real schema enforces and the app relies on. Tables not listed here
// get `id` as their key and an `id` + `created_at` default on insert.
const TABLES = {
  settings: { key: ['id'], unique: [['user_id']], stamps: ['created_at', 'updated_at'], touch: true },
  trades: { key: ['id'], stamps: ['created_at', 'updated_at'], touch: true },
  webhook_logs: { key: ['id'], stamps: ['created_at'] },
  strategy_runs: { key: ['id'], stamps: ['created_at'] },
  autopilot_state: { key: ['user_id', 'mode'], stamps: [], noId: true },
  autopilot_positions: { key: ['id'], unique: [['user_id', 'mode', 'symbol', 'strategy_id', 'entry_bar_t']], stamps: [] },
  autopilot_events: { key: ['id'], stamps: ['created_at'] },
};
const DEFAULT_TABLE = { key: ['id'], stamps: ['created_at'] };
const spec = (table) => TABLES[table] ?? DEFAULT_TABLE;

// ---------------------------------------------------------------- fixtures

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Relative times, so seeded data is always fresh:
 *   "@now"  "@now-3h"  "@now+15m"   ISO timestamp
 *   "@date-2d"                      YYYY-MM-DD (DATE columns)
 *   "@ms-3h"                        epoch milliseconds, as a number
 */
function expand(value, now) {
  if (Array.isArray(value)) return value.map(v => expand(v, now));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, now)]));
  if (typeof value !== 'string') return value;
  const m = value.match(/^@(now|date|ms)(?:([+-])(\d+(?:\.\d+)?)([mhd]))?$/);
  if (!m) return value;
  const t = now + (m[2] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) * UNIT_MS[m[4]] : 0);
  if (m[1] === 'ms') return Math.round(t);
  const iso = new Date(t).toISOString();
  return m[1] === 'date' ? iso.slice(0, 10) : iso;
}

function loadFixtures() {
  const raw = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const now = Date.now();
  const db = {};
  for (const [table, rows] of Object.entries(raw)) {
    if (table.startsWith('$') || !Array.isArray(rows)) continue; // "$comment" and the like
    db[table] = rows.map(row => expand(row, now));
  }
  return db;
}

let db = loadFixtures();

// ---------------------------------------------------------------- PostgREST

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'and', 'or']);

function coerce(text) {
  if (text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/** Compare the way Postgres would for the column types in play: numbers as numbers, the rest as text. */
function compare(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a === true || a === 'true') - Number(b === true || b === 'true');
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function unquote(s) {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1).replace(/\\"/g, '"') : s;
}

function splitList(body) {
  // a,b,"c,d"  ->  [a, b, "c,d"]
  const out = [];
  let cur = '', quoted = false;
  for (const ch of body) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur !== '' || body !== '') out.push(cur);
  return out.map(unquote);
}

function likeRegex(pattern, flags) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

function buildFilter(column, expression) {
  let negate = false;
  let rest = expression;
  if (rest.startsWith('not.')) { negate = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = dot === -1 ? rest : rest.slice(0, dot);
  const arg = dot === -1 ? '' : rest.slice(dot + 1);

  let test;
  switch (op) {
    case 'eq': test = v => v !== null && v !== undefined && compare(v, coerce(arg)) === 0; break;
    case 'neq': test = v => v !== null && v !== undefined && compare(v, coerce(arg)) !== 0; break;
    case 'gt': test = v => v != null && compare(v, arg) > 0; break;
    case 'gte': test = v => v != null && compare(v, arg) >= 0; break;
    case 'lt': test = v => v != null && compare(v, arg) < 0; break;
    case 'lte': test = v => v != null && compare(v, arg) <= 0; break;
    case 'is': { const want = coerce(arg); test = v => (want === null ? v === null || v === undefined : v === want); break; }
    case 'in': { const set = splitList(arg.replace(/^\(/, '').replace(/\)$/, '')); test = v => v != null && set.some(x => compare(v, x) === 0); break; }
    case 'like': { const re = likeRegex(arg, ''); test = v => typeof v === 'string' && re.test(v); break; }
    case 'ilike': { const re = likeRegex(arg, 'i'); test = v => typeof v === 'string' && re.test(v); break; }
    case 'cs': { const set = splitList(arg.replace(/^\{/, '').replace(/\}$/, '')); test = v => Array.isArray(v) && set.every(x => v.map(String).includes(x)); break; }
    default: test = () => true; // an operator this mock does not know: do not hide rows
  }
  return row => test(row[column]) !== negate;
}

function parseQuery(searchParams) {
  const filters = [];
  for (const [key, value] of searchParams) {
    if (!RESERVED.has(key)) filters.push(buildFilter(key, value));
  }
  const order = (searchParams.get('order') ?? '').split(',').filter(Boolean).map(part => {
    const [column, ...mods] = part.split('.');
    return { column, desc: mods.includes('desc'), nullsFirst: mods.includes('nullsfirst'), nullsLast: mods.includes('nullslast') };
  });
  const limit = searchParams.has('limit') ? Number(searchParams.get('limit')) : null;
  const offset = searchParams.has('offset') ? Number(searchParams.get('offset')) : 0;
  return { matches: row => filters.every(f => f(row)), order, limit, offset, select: searchParams.get('select') };
}

function sortRows(rows, order) {
  if (!order.length) return rows;
  return [...rows].sort((a, b) => {
    for (const o of order) {
      const av = a[o.column] ?? null, bv = b[o.column] ?? null;
      if (av === null || bv === null) {
        if (av === bv) continue;
        // Postgres: nulls sort as the largest value unless told otherwise.
        const nullsFirst = o.nullsFirst || (o.desc && !o.nullsLast);
        return (av === null) === nullsFirst ? -1 : 1;
      }
      const c = compare(av, bv);
      if (c !== 0) return o.desc ? -c : c;
    }
    return 0;
  });
}

function project(rows, select) {
  if (!select || select === '*' || select.includes('(')) return rows; // embedded resources are not modelled
  const columns = select.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [maybeAlias, maybeColumn] = s.split(':');
    const column = (maybeColumn ?? maybeAlias).split('::')[0];
    return { column, as: maybeColumn ? maybeAlias : column };
  });
  if (columns.some(c => c.column === '*')) return rows;
  return rows.map(row => Object.fromEntries(columns.map(c => [c.as, row[c.column] ?? null])));
}

function preferences(req) {
  const out = {};
  for (const part of String(req.headers.prefer ?? '').split(',')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = v ?? true;
  }
  return out;
}

const pgError = (status, code, message, details = null) => ({ status, body: { code, details, hint: null, message } });

/** Shapes rows for the response: single-object mode, count header, 406 on the wrong row count. */
function respondRows(req, rows, { status = 200, total = null, offset = 0 } = {}) {
  const headers = {};
  const prefer = preferences(req);
  if (prefer.count) {
    const range = rows.length ? `${offset}-${offset + rows.length - 1}` : '*';
    headers['Content-Range'] = `${range}/${total ?? rows.length}`;
  }
  if (String(req.headers.accept ?? '').includes('application/vnd.pgrst.object+json')) {
    if (rows.length !== 1) {
      return pgError(406, 'PGRST116', 'JSON object requested, multiple (or no) rows returned', `The result contains ${rows.length} rows`);
    }
    return { status, headers, body: rows[0] };
  }
  return { status, headers, body: rows };
}

function withDefaults(table, row) {
  const s = spec(table);
  const now = new Date().toISOString();
  const out = { ...row };
  if (!s.noId && out.id === undefined) out.id = randomUUID();
  for (const column of s.stamps) if (out[column] === undefined) out[column] = now;
  // Columns the caller left out read back as null, like a real nullable column, when a sibling row has them.
  const template = db[table]?.[0];
  if (template) for (const column of Object.keys(template)) if (out[column] === undefined) out[column] = null;
  return out;
}

const sameOn = (columns, a, b) => columns.every(c => a[c] !== undefined && a[c] !== null && compare(a[c], b[c]) === 0);

function rest(req, url, body) {
  const table = decodeURIComponent(url.pathname.slice('/rest/v1/'.length)).replace(/\/$/, '');
  // Database functions are not modelled: one answers with its fixture rows if fixtures.json has any, else null.
  if (!table || table.startsWith('rpc/')) return { status: 200, body: db[table] ?? null };
  const q = parseQuery(url.searchParams);
  const prefer = preferences(req);
  const s = spec(table);
  const wantsRows = prefer.return === 'representation';

  if (req.method === 'GET' || req.method === 'HEAD') {
    const all = sortRows((db[table] ?? []).filter(q.matches), q.order); // unknown table: simply empty
    const page = all.slice(q.offset, q.limit === null ? undefined : q.offset + q.limit);
    return respondRows(req, project(page, q.select), { total: all.length, offset: q.offset });
  }

  if (req.method === 'POST') {
    const incoming = (Array.isArray(body) ? body : [body ?? {}]).filter(r => r && typeof r === 'object');
    const rows = (db[table] ??= []);
    const upsert = typeof prefer.resolution === 'string';
    const conflictColumns = url.searchParams.get('on_conflict')?.split(',') ?? s.key;
    const written = [];
    for (const raw of incoming) {
      const existing = upsert ? rows.find(r => sameOn(conflictColumns, raw, r)) : undefined;
      if (existing) {
        if (prefer.resolution === 'merge-duplicates') Object.assign(existing, raw);
        written.push(existing);
        continue;
      }
      const row = withDefaults(table, raw);
      const clash = [s.key, ...(s.unique ?? [])].find(columns => rows.some(r => sameOn(columns, row, r)));
      if (clash) return pgError(409, '23505', `duplicate key value violates unique constraint on ${table} (${clash.join(', ')})`);
      rows.push(row);
      written.push(row);
    }
    if (!wantsRows) return { status: 201, body: null };
    return respondRows(req, project(written, q.select), { status: 201 });
  }

  if (req.method === 'PATCH') {
    const patch = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const hit = (db[table] ?? []).filter(q.matches);
    for (const row of hit) {
      Object.assign(row, patch);
      if (s.touch && patch.updated_at === undefined) row.updated_at = new Date().toISOString(); // the handle_updated_at trigger
    }
    if (!wantsRows) return { status: 204, body: null };
    return respondRows(req, project(hit, q.select));
  }

  if (req.method === 'DELETE') {
    const rows = db[table] ?? [];
    const hit = rows.filter(q.matches);
    db[table] = rows.filter(r => !hit.includes(r));
    if (!wantsRows) return { status: 204, body: null };
    return respondRows(req, project(hit, q.select));
  }

  return pgError(405, 'PGRST117', `Unsupported method ${req.method}`);
}

// ---------------------------------------------------------------- GoTrue

function auth(req, url) {
  const path = url.pathname.slice('/auth/v1'.length);
  if (path === '/user') return { status: 200, body: devUser() }; // any bearer token is the dev user
  if (path === '/token' || path === '/signup' || path === '/verify') return { status: 200, body: devSession() }; // any login or refresh succeeds
  if (path === '/logout') return { status: 204, body: null };
  if (path === '/settings') return { status: 200, body: { external: { email: true }, disable_signup: false, mailer_autoconfirm: true } };
  if (path === '/health') return { status: 200, body: { name: 'dev-mock' } };
  return { status: 404, body: { code: 404, error_code: 'not_found', msg: `dev-mock has no ${req.method} /auth/v1${path}` } };
}

// ---------------------------------------------------------------- HTTP

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? 'authorization,apikey,content-type,prefer,accept,accept-profile,content-profile,range,x-client-info,x-supabase-api-version',
    'Access-Control-Expose-Headers': 'Content-Range,Content-Profile,X-Total-Count',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(undefined);
      try { resolve(JSON.parse(text)); } catch { resolve(undefined); }
    });
  });
}

async function route(req, url) {
  if (url.pathname.startsWith('/auth/v1/')) return auth(req, url);
  if (url.pathname.startsWith('/rest/v1/')) return rest(req, url, await readBody(req));
  if (url.pathname === '/__mock/reset' && req.method === 'POST') { db = loadFixtures(); return { status: 200, body: { ok: true } }; }
  if (url.pathname === '/__mock/db') return { status: 200, body: db };
  if (url.pathname === '/' || url.pathname === '/rest/v1' || url.pathname === '/rest/v1/') return { status: 200, body: { name: 'hl-webhook-trader dev-mock', tables: Object.keys(db) } };
  return { status: 404, body: { message: `dev-mock has no ${req.method} ${url.pathname}` } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const cors = corsHeaders(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  let result;
  try {
    result = await route(req, url);
  } catch (err) {
    result = { status: 500, body: { code: 'MOCK500', message: err instanceof Error ? err.message : String(err) } };
  }
  const hasBody = result.body !== null && result.body !== undefined && req.method !== 'HEAD' && result.status !== 204;
  const payload = hasBody ? JSON.stringify(result.body) : '';
  res.writeHead(result.status, {
    ...cors,
    ...(result.headers ?? {}),
    ...(hasBody ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) } : {}),
  });
  res.end(payload);
  if (!QUIET) console.log(`${new Date().toISOString().slice(11, 19)} ${result.status} ${req.method} ${url.pathname}${url.search}`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the mock already running? (PORT=... to change)` : err);
  process.exit(1);
});

server.listen(PORT, () => {
  const counts = Object.entries(db).map(([t, rows]) => `${t}:${rows.length}`).join('  ');
  console.log(`Supabase dev-mock on http://localhost:${PORT}  (${counts})`);
  console.log('Every token is dev@example.com. Data is in memory; POST /__mock/reset reloads fixtures.json.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
