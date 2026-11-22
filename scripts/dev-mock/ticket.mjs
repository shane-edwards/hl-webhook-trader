#!/usr/bin/env node
// Walks the one-click path from a trade idea to the trade ticket and
// screenshots each step, at desktop and phone width:
//   dashboard -> "Whole market" ideas -> expand the first idea (chart) ->
//   press its Long/Short button -> ticket opens pre-filled -> limit entry and
//   exit options.
// The mock seeds one long and one short read (fixtures.json: suggestions_cache)
// so the path can be exercised whatever the real market is doing. Nothing is
// submitted: no order is ever sent from this script.
//
//   node scripts/dev-mock/ticket.mjs [outDir] [--base=http://localhost:3000]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sessionCookies } from './session.mjs';

const args = process.argv.slice(2);
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const base = flag('base') ?? 'http://localhost:3000';
const supabaseUrl = flag('supabase') ?? 'http://localhost:54321';
const outDir = resolve(args.find(a => !a.startsWith('--')) ?? 'scripts/dev-mock/out');
mkdirSync(outDir, { recursive: true });

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
let failed = false;

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await context.addCookies(sessionCookies(supabaseUrl).map(c => ({ ...c, url: base, httpOnly: false, sameSite: 'Lax' })));
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') console.log(`  [${name}] console error: ${m.text().slice(0, 200)}`); });
  const shot = async step => { const file = join(outDir, `ticket-${step}-${name}.png`); await page.screenshot({ path: file }); console.log(`ok    ${name.padEnd(7)} ${step}`); };
  try {
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' });
    const ideas = page.getByRole('region', { name: 'Trade ideas', exact: true });
    // Wait for the watched list first: it shows the page is interactive.
    await ideas.locator('li').first().waitFor({ timeout: 30_000 });
    await ideas.getByRole('radio', { name: 'Whole market' }).click();
    await ideas.getByRole('button', { name: /^(Long|Short)$/ }).first().waitFor({ timeout: 30_000 });
    const first = ideas.locator('li').first();
    await first.getByRole('button', { expanded: false }).click();
    await ideas.locator('svg[role="img"]').first().waitFor({ timeout: 20_000 });
    await ideas.scrollIntoViewIfNeeded();
    await shot('1-idea-expanded');

    await first.getByRole('button', { name: /^(Long|Short)$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    // The ticket must open on the idea's market and side, with its stop pre-filled.
    await dialog.locator('svg[role="img"]').waitFor({ timeout: 20_000 });
    // The stop is filled in once the ticket has read the rules for this market itself.
    await page.waitForFunction(() => document.querySelector('#tt-sl')?.value, null, { timeout: 30_000 });
    const symbol = await dialog.locator('#tt-symbol').inputValue();
    const stop = await dialog.locator('#tt-sl').inputValue();
    console.log(`      ticket opened on ${symbol}, stop ${stop}%`);
    if (!symbol || !stop) throw new Error('ticket did not pre-fill from the idea');
    await shot('2-ticket-market');

    // Another timeframe: the chart reloads and the stop is re-sized from those candles.
    await dialog.getByRole('radio', { name: '4 hour' }).click();
    await page.waitForFunction(prev => { const v = document.querySelector('#tt-sl')?.value; return v && v !== prev; }, stop, { timeout: 30_000 });
    console.log(`      on the 4-hour chart the stop is ${await dialog.locator('#tt-sl').inputValue()}%`);
    await dialog.locator('svg[role="img"]').waitFor({ timeout: 20_000 });
    await shot('2b-ticket-4h');
    await dialog.getByRole('radio', { name: '1 hour' }).click();
    await page.waitForFunction(prev => document.querySelector('#tt-sl')?.value === prev, stop, { timeout: 30_000 });

    await dialog.getByRole('radio', { name: 'Limit price' }).click();
    await dialog.getByRole('button', { name: /Use nearest/ }).click().catch(() => dialog.locator('#tt-limit').fill('1'));
    await shot('3-ticket-limit');

    await dialog.getByRole('radio', { name: 'Market now' }).click();
    await dialog.getByRole('button', { name: /More exit options/ }).click();
    await dialog.locator('#tt-share').fill('50');
    await dialog.locator('#tt-tp2').fill(String(Number(await dialog.locator('#tt-tp').inputValue()) * 2));
    await dialog.locator('#tt-trail').fill('2');
    await dialog.locator('#tt-sl').fill(String(Number(stop) * 2)); // the chart's stop line and the size must follow
    await dialog.locator('#tt-trail').scrollIntoViewIfNeeded();
    await shot('4-ticket-exits');
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${name}: ${err.message}`);
    await page.screenshot({ path: join(outDir, `ticket-failed-${name}.png`) }).catch(() => {});
  }
  await context.close();
}
await browser.close();
console.log(`Saved to ${outDir}`);
process.exit(failed ? 1 : 0);
