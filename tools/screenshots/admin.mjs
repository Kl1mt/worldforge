// Captures the ticket D.3 admin panel at desktop (1440) and mobile (390): invites (with a fresh
// code shown once), a player file, telemetry, server status and roles.
// Needs the e2e server with a seeded admin and moderator, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_MODERATOR=warden@graumark.test \
//   WORLDFORGE_GIT_SHA=$(git rev-parse --short HEAD) WORLDFORGE_BUILD_TIME=2026-11-06T12:00:00Z \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/admin.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/deploy');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function shoot(page, vp, name) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) console.warn(`! horizontal overflow on ${name} @ ${vp.name}`);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, height) });
  const file = `${outDir}/admin-${name}-${vp.name}.png`;
  await page.screenshot({ path: file });
  await page.setViewportSize({ width: vp.width, height: vp.height });
  console.log(`saved ${file}`);
}

async function context(browser, vp = VIEWPORTS[0]) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`! page error @ ${vp.name}: ${err.message}`));
  return { ctx, page };
}

async function api(ctx, method, path, data) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function register(browser, displayName, hero, inviteCode) {
  const c = await context(browser);
  const email = `${displayName.replace(/\s/g, '').toLowerCase()}-${Date.now()}@graumark.test`;
  const { account } = await api(c.ctx, 'POST', '/auth/register', {
    email,
    displayName,
    password: PASSWORD,
    ...(inviteCode ? { inviteCode } : {}),
  });
  let character = null;
  if (hero) {
    ({ character } = await api(c.ctx, 'POST', '/characters', {
      name: hero,
      classId: 'warrior',
      appearance: { banner: 'ember' },
    }));
  }
  return { ...c, account, character };
}

async function login(browser, email, hero, vp) {
  const c = await context(browser, vp);
  await api(c.ctx, 'POST', '/auth/login', { email, password: PASSWORD });
  const { characters } = await api(c.ctx, 'GET', '/characters');
  if (characters.length === 0) {
    await api(c.ctx, 'POST', '/characters', {
      name: hero,
      classId: 'warrior',
      appearance: { banner: 'dusk' },
    });
  }
  // Hide the first-steps guide so the panel is what the screenshots show.
  await api(c.ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
  return c;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Registration is limited to 5 an hour per IP: three accounts register here (the admin and the
// moderator are seeded by the server).
async function setup(browser) {
  mkdirSync(outDir, { recursive: true });
  const admin = await login(browser, 'castellan@graumark.test', 'Ysolde');
  const { code } = await api(admin.ctx, 'POST', '/admin/invites', {
    maxUses: 3,
    expiresInHours: 14 * 24,
    note: 'Guild friends from the old server',
  });
  await api(admin.ctx, 'POST', '/admin/invites', {
    maxUses: 1,
    expiresInHours: null,
    note: 'Playtester Wenna',
  });
  const old = await api(admin.ctx, 'POST', '/admin/invites', {
    maxUses: 1,
    expiresInHours: 24,
    note: 'Lost in the post',
  });
  await api(admin.ctx, 'POST', `/admin/invites/${old.invite.id}/revoke`, {});

  const offender = await register(browser, 'Grim Jester', 'Jester', code);
  const witness = await register(browser, 'Tilda Moor', 'Tilda', code);
  await register(browser, 'Iron Ada', null, code);

  // Some play, so telemetry has rows (the e2e clock runs 120× faster).
  for (const p of [offender, witness]) {
    await api(p.ctx, 'POST', `/characters/${p.character.id}/activity`, {
      areaId: 'abandonedFields',
    });
  }
  await sleep(12_000);
  for (const p of [offender, witness]) {
    await api(p.ctx, 'POST', `/characters/${p.character.id}/activity/settle`);
  }

  const { player: ref } = await api(witness.ctx, 'GET', '/players/lookup?name=Grim%20Jester');
  await api(witness.ctx, 'POST', '/reports', {
    target: { kind: 'player', handle: ref.handle },
    reason: 'spam',
    note: 'Keeps offering cheap gold in every corner of the town.',
  });
  await api(witness.ctx, 'POST', '/reports', {
    target: { kind: 'profileField', handle: ref.handle, field: 'displayName' },
    reason: 'harassment',
    note: 'The name mocks another player.',
  });
  const warden = await login(browser, 'warden@graumark.test', 'Brann');
  const { cases } = await api(warden.ctx, 'GET', '/mod/queue');
  const spam = cases.find((c) => c.target.kind === 'player');
  await api(warden.ctx, 'POST', `/mod/reports/${spam.reportId}/resolve`, {
    action: 'mute',
    reason: 'Spam in the town square.',
    durationHours: 24,
  });
  for (const c of [offender, witness, warden]) await c.ctx.close();
  await admin.ctx.close();
  return { handle: ref.handle };
}

async function run(browser, vp, { handle }) {
  const { ctx, page } = await login(browser, 'castellan@graumark.test', 'Ysolde', vp);

  // Invites: create one through the form, so the code is shown once.
  await page.goto(`${baseUrl}/#/admin/invites`);
  await page.locator('.invite').first().waitFor();
  await page.getByLabel('Uses').fill('5');
  await page.getByRole('button', { name: '30 days' }).click();
  await page
    .getByLabel(/Note/)
    .fill(vp.name === 'desktop' ? 'Discord raid group' : 'Cousin Merewyn');
  await page.getByRole('button', { name: 'Create invite' }).click();
  await page.locator('.keepseal').waitFor();
  await shoot(page, vp, 'invites');

  await page.goto(`${baseUrl}/#/admin/players/${handle}`);
  await page.getByLabel('Display name or handle').fill('jest');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('.seek__row').first().waitFor();
  await page.locator('.dossier').waitFor();
  await shoot(page, vp, 'players');

  await page.goto(`${baseUrl}/#/admin/telemetry`);
  await page.getByText('Check against the audit log').click();
  await page.getByRole('button', { name: 'Show report' }).click();
  await page.locator('.tally').waitFor();
  await shoot(page, vp, 'telemetry');

  await page.goto(`${baseUrl}/#/admin/status`);
  await page.locator('.gauges').waitFor();
  await shoot(page, vp, 'status');

  await page.goto(`${baseUrl}/#/admin/roles`);
  await page.locator('.staffroll').waitFor();
  await shoot(page, vp, 'roles');
  await ctx.close();
}

const browser = await playwright.chromium.launch();
try {
  const shared = await setup(browser);
  for (const vp of VIEWPORTS) await run(browser, vp, shared);
} finally {
  await browser.close();
}
