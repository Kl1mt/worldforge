// Captures the ticket 8.6 Readiness tab at desktop (1440) and mobile (390): a fresh town (most
// entries not set), then a town part-way through the checklist (a season, an event and a staff
// name scheduled, some privacy ticks, a test letter sent, a recent backup).
// Needs the e2e server with a seeded admin, a legal dir and a backup status file, and the web
// dev server:
//   mkdir -p /tmp/wf-ready/legal /tmp/wf-ready/status
//   E2E_SEED_ADMIN=castellan@graumark.test LEGAL_DIR=/tmp/wf-ready/legal \
//   BACKUP_STATUS_FILE=/tmp/wf-ready/status/backup.json \
//   WORLDFORGE_GIT_SHA=$(git rev-parse --short HEAD) WORLDFORGE_BUILD_TIME=2026-11-11T12:00:00Z \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/readiness.mjs [baseUrl] [outDir] [stateDir]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-8');
const stateDir = resolve(process.argv[4] ?? '/tmp/wf-ready');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function api(ctx, method, path, data, key) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.json();
}

async function shoot(page, vp, name) {
  await page.addStyleTag({ content: '.notices { display: none !important; }' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/admin-readiness-${name}-${vp.name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

async function open(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  await api(ctx, 'POST', '/auth/login', { email: 'castellan@graumark.test', password: PASSWORD });
  // The game asks for a hero first; the panel sits behind it.
  const { characters } = await api(ctx, 'GET', '/characters');
  if (!characters.length) {
    await api(ctx, 'POST', '/characters', {
      name: 'Ysolde',
      classId: 'warrior',
      appearance: { banner: 'ember' },
    });
  }
  await api(ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  return { ctx, page };
}

async function board(page) {
  await page.goto(`${baseUrl}/#/admin/readiness`, { waitUntil: 'networkidle' });
  await page.locator('.readyroll__entry').first().waitFor();
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  // 1. A fresh town.
  for (const vp of VIEWPORTS) {
    const { ctx, page } = await open(browser, vp);
    await board(page);
    await shoot(page, vp, 'fresh', vp);
    await ctx.close();
  }

  // 2. Part-way: Season 1, the first event, a staff name, some ticks, a backup, a test letter.
  const { ctx } = await open(browser, VIEWPORTS[0]);
  const day = 24 * 60 * 60 * 1000;
  const monday = new Date(Date.now() + 5 * day);
  monday.setUTCHours(0, 0, 0, 0);
  await api(ctx, 'POST', '/admin/seasons', {
    startsAt: monday.toISOString(),
    endsAt: new Date(monday.getTime() + 56 * day).toISOString(),
  });
  await api(ctx, 'POST', '/admin/events', {
    definitionId: 'harvestOfBones',
    startsAt: new Date(monday.getTime() + 14 * day).toISOString(),
    endsAt: new Date(monday.getTime() + 21 * day).toISOString(),
  });
  await api(
    ctx,
    'POST',
    '/admin/reserved-names',
    { name: 'Ysolde', note: 'the owner', reason: 'staff name before launch' },
    randomUUID(),
  );
  const { privacy } = await api(ctx, 'GET', '/admin/readiness');
  await api(
    ctx,
    'PUT',
    '/admin/readiness/privacy',
    { expectedVersion: privacy.version, ticked: ['leaderboards', 'emails', 'provider'] },
    randomUUID(),
  );
  mkdirSync(join(stateDir, 'legal'), { recursive: true });
  mkdirSync(join(stateDir, 'status'), { recursive: true });
  writeFileSync(join(stateDir, 'legal', 'impressum.md'), '# Impressum\n\n(screenshot)\n');
  writeFileSync(
    join(stateDir, 'status', 'backup.json'),
    JSON.stringify({
      finishedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      bytes: 3_481_221,
    }),
  );
  await ctx.close();

  for (const vp of VIEWPORTS) {
    const { ctx: c, page } = await open(browser, vp);
    await board(page);
    // The test letter, typed and sent through the e2e server's capture transport.
    await page.getByLabel('Send to').fill('owner@example.test');
    await page.getByRole('button', { name: 'Send test letter' }).click();
    await page.locator('.readyroll-letter__result').waitFor();
    await page.locator('.readyroll__entry').first().waitFor();
    await shoot(page, vp, 'underway', vp);
    await c.close();
  }
} finally {
  await browser.close();
}
