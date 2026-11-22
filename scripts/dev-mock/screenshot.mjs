#!/usr/bin/env node
// Full-page screenshots of every dashboard route, at desktop and phone widths.
// Expects scripts/dev-mock/server.mjs and `next dev` (started with env.example) to be running.
//
//   node scripts/dev-mock/screenshot.mjs [outDir] [--routes=/dashboard,/analytics]
//        [--base=http://localhost:3000] [--supabase=http://localhost:54321] [--wait=8000]
//
// It signs in the way a browser that already had a session would: by presenting the
// @supabase/ssr session cookie. The app itself is not modified and has no bypass.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionCookies } from './session.mjs';

const ROUTES = ['/dashboard', '/autopilot', '/trades', '/markets', '/lab', '/analytics', '/settings'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, isMobile: false, deviceScaleFactor: 1 },
  { name: 'phone', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

// ---- arguments
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  return hit && hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/dev-mock/screenshot.mjs [outDir] [--routes=/a,/b] [--base=URL] [--supabase=URL] [--wait=ms]');
  process.exit(0);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(args.find(a => !a.startsWith('--')) ?? path.join(here, 'out'));
const base = flag('base', 'http://localhost:3000').replace(/\/$/, '');
const supabaseUrl = flag('supabase', process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://localhost:54321');
const idleWait = Number(flag('wait', '8000'));
const routes = flag('routes', ROUTES.join(',')).split(',').map(r => r.trim()).filter(Boolean).map(r => (r.startsWith('/') ? r : `/${r}`));

// ---- playwright is installed globally, not in this repo's node_modules
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Could not load "playwright". Install it globally (and its Chromium) or add its location to NODE_PATH.');
  process.exit(2);
}

async function reachable(url) {
  try { await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) }); return true; } catch { return false; }
}
if (!(await reachable(`${supabaseUrl}/auth/v1/health`))) {
  console.error(`No mock Supabase at ${supabaseUrl}. Start it: node scripts/dev-mock/server.mjs`);
  process.exit(2);
}
if (!(await reachable(`${base}/login`))) {
  console.error(`No app at ${base}. Start it with the variables in scripts/dev-mock/env.example.`);
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const cookies = sessionCookies(supabaseUrl).map(c => ({ ...c, url: base, httpOnly: false, sameSite: 'Lax' }));
const slug = (route) => route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-') || 'root';
const short = (url) => (url.startsWith(base) ? url.slice(base.length) || '/' : url);

const browser = await chromium.launch();
let problems = 0;

for (const viewport of VIEWPORTS) {
  const { name, ...contextOptions } = viewport;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: contextOptions.deviceScaleFactor,
    isMobile: contextOptions.isMobile,
    hasTouch: contextOptions.hasTouch ?? false,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await context.addCookies(cookies);

  for (const route of routes) {
    const page = await context.newPage();
    const notes = [];
    page.on('console', msg => { if (msg.type() === 'error') notes.push(`console: ${msg.text().slice(0, 300)}`); });
    page.on('pageerror', err => notes.push(`uncaught: ${String(err.message).slice(0, 300)}`));
    page.on('requestfailed', req => {
      const reason = req.failure()?.errorText ?? 'failed';
      if (reason !== 'net::ERR_ABORTED') notes.push(`request failed: ${req.method()} ${short(req.url())} (${reason})`);
    });
    page.on('response', res => { if (res.status() >= 400) notes.push(`HTTP ${res.status()}: ${res.request().method()} ${short(res.url())}`); });

    const file = path.join(outDir, `${slug(route)}-${name}.png`);
    let fatal = null;
    try {
      // The first visit to a route makes `next dev` compile it, which can take a while.
      await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      // Pages that poll never go idle, so this is a best effort with a ceiling.
      await page.waitForLoadState('networkidle', { timeout: idleWait }).catch(() => notes.push(`network still busy after ${idleWait} ms (polling?)`));
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      await page.waitForTimeout(600); // let charts finish drawing
      if (new URL(page.url()).pathname.startsWith('/login')) fatal = 'redirected to /login: the session cookie was not accepted (is the app pointed at the mock?)';
      // Hide the `next dev` badge, then grow the viewport to the page height: a plain full-page capture
      // paints position:fixed chrome (sidebar, phone tab bar) one screen down, in the middle of the content.
      await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' }).catch(() => {});
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height > viewport.height) {
        await page.setViewportSize({ width: viewport.width, height: Math.min(height, 12_000) });
        await page.waitForTimeout(400);
      }
      await page.screenshot({ path: file, fullPage: true });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
    } catch (err) {
      fatal = String(err.message ?? err).split('\n')[0];
    }

    const unique = [...new Set(notes)];
    if (fatal) problems++;
    console.log(`${fatal ? 'FAIL' : unique.length ? 'warn' : 'ok  '}  ${name.padEnd(7)} ${route.padEnd(12)} -> ${path.relative(process.cwd(), file)}`);
    if (fatal) console.log(`        ${fatal}`);
    for (const note of unique.slice(0, 15)) console.log(`        ${note}`);
    if (unique.length > 15) console.log(`        ... and ${unique.length - 15} more`);
    await page.close();
  }
  await context.close();
}

await browser.close();
console.log(problems ? `\n${problems} page(s) failed.` : `\nSaved ${routes.length * VIEWPORTS.length} screenshots to ${outDir}`);
process.exit(problems ? 1 : 0);
