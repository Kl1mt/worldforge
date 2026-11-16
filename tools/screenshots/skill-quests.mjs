// Captures ticket 9.3 at desktop (1440) and mobile (390), checked in a real browser: the Tavern's
// "masters' lessons" for a level-38 hero (the Tyrant's Lesson open, the Sovereign's locked), the
// lesson in hand once its kill is in (the Seals still missing, then held), the payout after
// "Turn in" (the Seals paid, the ring in the pack), and the Skills page with the taught skill open.
// The hero is raised and the kill filled in through the admin tools on the seeded test account
// (the same paths a crypt claim and a settlement take); the turn-in is the player's own click.
// Needs the e2e server with a seeded admin and test account, and the web dev server:
//   E2E_SEED_ADMIN=castellan@graumark.test E2E_SEED_TEST_ACCOUNT=probe@graumark.test \
//     pnpm --filter @worldforge/server e2e:serve
//   pnpm --filter @worldforge/web dev
//   node tools/screenshots/skill-quests.mjs [baseUrl] [outDir]
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
}

const baseUrl = process.argv[2] ?? 'http://localhost:5173';
const outDir = resolve(process.argv[3] ?? 'docs/screenshots/phase-9');
const PASSWORD = 'ashes-and-iron-42';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, hero: 'Ansgarwyn', classId: 'warrior' },
  { name: 'mobile', width: 390, height: 844, hero: 'Ansgarel', classId: 'mage' },
];

async function api(ctx, method, path, data, key) {
  const res = await ctx.request.fetch(`${baseUrl}/api${path}`, {
    method,
    ...(data ? { data } : {}),
    headers: key ? { 'Idempotency-Key': key } : {},
  });
  if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
  return res.status() === 204 ? null : res.json();
}

async function shoot(page, name, vp) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error(`horizontal overflow on ${name} @ ${vp.name}`);
  const file = `${outDir}/skill-quests-${name}-${vp.name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`saved ${file}`);
}

async function context(browser, vp) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  return { ctx, page: await ctx.newPage() };
}

mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch();
try {
  const admin = await context(browser, VIEWPORTS[0]);
  await api(admin.ctx, 'POST', '/auth/login', {
    email: 'castellan@graumark.test',
    password: PASSWORD,
  });
  for (const vp of VIEWPORTS) {
    const { ctx, page } = await context(browser, vp);
    await api(ctx, 'POST', '/auth/login', { email: 'probe@graumark.test', password: PASSWORD });
    await api(ctx, 'POST', '/account/guide', { dismissed: true }).catch(() => undefined);
    const { account } = await api(ctx, 'GET', '/account');
    const { character } = await api(ctx, 'POST', '/characters', {
      name: vp.hero,
      classId: vp.classId,
      appearance: { banner: 'ember' },
    });
    await api(ctx, 'POST', `/characters/${character.id}/select`);
    const heroUrl = `/admin/accounts/${account.handle}/heroes/${character.id}`;
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/level`,
      { level: 38, reason: 'lessons' },
      randomUUID(),
    );
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/progress`,
      {
        gravewardenDefeated: true,
        cryptTierCleared: 3,
        ashenWardenDefeated: true,
        reason: 'lessons',
      },
      randomUUID(),
    );

    // The board: the Tyrant's Lesson open, the Sovereign's locked below level 46.
    await page.goto(`${baseUrl}/#/tavern`);
    await page.getByText('The masters’ lessons').waitFor();
    await page.getByRole('heading', { name: 'The Tyrant’s Lesson' }).waitFor();
    await page.getByText('Reach level 46').waitFor();
    await page.locator('.board__skills').scrollIntoViewIfNeeded();
    await shoot(page, 'board', vp);

    // Taken, its kill filled in by the admin tool; the Seals still missing.
    await page.getByRole('button', { name: 'Take the quest' }).last().click();
    await page.getByText('In hand · see Your quests').waitFor();
    const board = await api(ctx, 'GET', `/characters/${character.id}/quests`);
    const rowId = board.skills.find((s) => s.questId === 'theTyrantsLesson').questRowId;
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/quests/${rowId}/complete`,
      { reason: 'the kill' },
      randomUUID(),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Bring the materials first' }).waitFor();
    await page.locator('.quests').scrollIntoViewIfNeeded();
    await shoot(page, 'missing', vp);

    // The Seals in hand: the player turns the lesson in.
    await api(
      admin.ctx,
      'POST',
      `${heroUrl}/materials`,
      { mode: 'grant', materials: { gravewardenSeal: 3 }, reason: 'seals' },
      randomUUID(),
    );
    await page.reload();
    await page.getByRole('button', { name: 'Turn in' }).click();
    await page.getByText('a new skill learned').waitFor();
    await page.getByText(/Learned · /).waitFor();
    await shoot(page, 'paid', vp);
    const after = await api(ctx, 'GET', `/characters/${character.id}/materials`);
    const seals = after.materials.find((m) => m.materialId === 'gravewardenSeal')?.quantity ?? 0;
    if (seals !== 1) throw new Error(`expected 1 Seal left, got ${seals}`);

    // The Skills page: the taught skill is open.
    const skills = await api(ctx, 'GET', `/characters/${character.id}/skills`);
    const taught = vp.classId === 'warrior' ? 'forgebreaker' : 'emberstorm';
    if (!skills.unlocked.includes(taught)) throw new Error(`${taught} not unlocked`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
