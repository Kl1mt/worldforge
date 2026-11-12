/**
 * Ticket 6.7 (docs/COMMUNITY.md "The Forgeward Outpost", docs/WORLD.md "Eras of Graumark",
 * docs/ECONOMY.md "Town upgrades"): the Forgeward chain through the real API, its caps and the
 * window rule at a stage completion, test accounts refused, the era derived from the flags (and
 * moved, audited and counted, by completions and admin toggles), the Forgeward bellows on the
 * Forge, the admin world view, the test-setup stage command, and no access removed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  findCommunityProject,
  stageCap,
  type MaterialId,
  type WorldProgress,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accountAchievements,
  accounts,
  auditLog,
  characters,
  communityContributions,
  communityProjectProgress,
  communityProjects,
  telemetryDaily,
  worldFlags,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { contributeCall, fund, insertPatron, type Patron } from '../test/community.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { advanceStage, completeProject } from './project-cli.js';

const FORGEWARD = findCommunityProject('forgewardOutpost')!;
const [ROAD, WALLS, BEACON] = FORGEWARD.stages;
const RICH: { gold: number; materials: Partial<Record<MaterialId, number>> } = {
  gold: 5_000_000,
  materials: { ironOre: 10_000, soulShard: 10_000, abbeySilver: 1_000, tyrantsEmber: 100 },
};
const DAY = 86_400_000;
// Derived from the wall clock (CLAUDE.md "Dates"): noon UTC of a day a week ahead.
const NOON = Math.floor((Date.now() + 7 * DAY) / DAY) * DAY + DAY / 2;
let nowMs = NOON;

let database: DatabaseHandle;
let app: FastifyInstance;
let contribute: ReturnType<typeof contributeCall>;
let admin: TestAccount;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now: () => new Date(nowMs) },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
  contribute = contributeCall(app);
  admin = await insertAccount(database.db, { role: 'admin', now: new Date(nowMs) });
});

afterAll(async () => {
  await app.close();
  await database.close();
});

beforeEach(async () => {
  nowMs = NOON;
  await db().delete(communityContributions);
  await db().delete(communityProjectProgress);
  await db().delete(communityProjects);
  await db().delete(worldFlags);
  await db().delete(auditLog);
  await db().delete(telemetryDaily);
  await db().delete(accountAchievements);
  app.worldState.invalidate();
});

const db = () => database.db;
const get = (who: TestAccount, url: string) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: who.token } });
const post = (who: TestAccount, url: string, payload: object) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'idempotency-key': randomUUID() },
    cookies: { [SESSION_COOKIE]: who.token },
  });
const world = async (who: TestAccount) =>
  (await get(who, '/api/world')).json<{
    flags: Record<string, boolean>;
    era: { id: string; index: number; name: string; title: string; crier: string };
  }>();
const gold = async (heroId: string) =>
  (await db().select({ g: characters.gold }).from(characters).where(eq(characters.id, heroId)))[0]!
    .g;
const audits = (event: string) =>
  db().select().from(auditLog).where(eq(auditLog.event, event)).orderBy(auditLog.id);
const patrons = (n: number) =>
  Promise.all(Array.from({ length: n }, () => insertPatron(db(), RICH)));

/** Live today: the Warehouse and the Ashen Pass done (by the owner's CLI, the real path). */
async function liveWorld() {
  await completeProject(db(), 'restoreWarehouse', new Date(nowMs));
  await completeProject(db(), 'clearAshenPass', new Date(nowMs));
  app.worldState.invalidate();
}

/** Each patron gives its whole first-day cap of every need of `stage`. */
async function giveCaps(ps: Patron[], stage = ROAD!) {
  const offer = Object.fromEntries(
    stage.needs.map((n) => [n.resource, stageCap(stage, n.resource)]),
  );
  const out = [];
  for (const p of ps) {
    const res = await contribute(p, FORGEWARD.id, stage.id, offer);
    expect(res.statusCode, res.body).toBe(200);
    out.push(res.json<{ stagesCompleted: string[]; projectCompleted: boolean }>());
  }
  return out;
}

describe('the Forgeward Outpost (ticket 6.7)', () => {
  it('waits for the Ashen Pass, then the town builds it stage by stage: flag, era, achievements, reconciled', async () => {
    const [p] = await patrons(1);
    // Locked until the Pass is clear.
    const early = await contribute(p!, FORGEWARD.id, ROAD!.id, { gold: 1000 });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('project_locked');
    await liveWorld();
    expect((await world(p!.who)).era).toMatchObject({
      id: 'rekindling',
      index: 2,
      title: 'Era of the Rekindling',
    });
    // The two earlier completions moved the era twice (Long Dusk → Ashen Siege → Rekindling).
    expect((await audits('world.era_change')).map((a) => a.data)).toEqual([
      { from: 'longDusk', to: 'ashenSiege', projectId: 'restoreWarehouse', by: 'admin' },
      { from: 'ashenSiege', to: 'rekindling', projectId: 'clearAshenPass', by: 'admin' },
    ]);

    // Ten players a day finish a stage (ticket B.5b: a tenth each on the first day).
    const town = [p!, ...(await patrons(9))];
    for (const [i, stage] of [ROAD!, WALLS!, BEACON!].entries()) {
      const out = await giveCaps(town, stage);
      expect(out.slice(0, 9).every((o) => o.stagesCompleted.length === 0)).toBe(true);
      expect(out[9]!.stagesCompleted).toEqual([stage.id]);
      expect(out[9]!.projectCompleted).toBe(i === 2);
    }
    // Each gave exactly its caps: the embers too (one each, ten in all).
    const embers = await db()
      .select({ n: sql<number>`sum(${communityContributions.amount})::int` })
      .from(communityContributions)
      .where(eq(communityContributions.resource, 'tyrantsEmber'));
    expect(embers[0]!.n).toBe(10);

    const after = await world(p!.who);
    expect(after.flags.forgewardRaised).toBe(true);
    expect(after.era).toMatchObject({ id: 'forgewardAge', title: 'Era of the Forgeward Age' });
    expect(after.era.crier).toMatch(/^Hear ye/);
    const change = (await audits('world.era_change')).at(-1)!;
    expect(change.data).toEqual({
      from: 'rekindling',
      to: 'forgewardAge',
      projectId: FORGEWARD.id,
    });
    const awarded = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.achievementId, 'forgewardBuilder'));
    expect(awarded.map((a) => a.accountId).sort()).toEqual(town.map((t) => t.who.id).sort());

    const checks = await reconcileWithAudit(db());
    for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
    const names = checks.map((c) => c.check);
    expect(names).toContain('community: forgewardOutpost contributions');
    expect(names).toContain('world: era changes');
    expect(checks.find((c) => c.check === 'world: era changes')).toMatchObject({ ok: true });
  });

  it('caps each account at a tenth on the first day (B.5b), whatever its heroes, and nothing more is taken', async () => {
    await liveWorld();
    const [p] = await patrons(1);
    const twin = await insertCharacter(db(), p!.who.id, { level: 30 });
    await fund(db(), twin.id, RICH);
    const cap = stageCap(ROAD!, 'gold');
    expect(cap).toBe(6_000);
    const first = await contribute(p!, FORGEWARD.id, ROAD!.id, { gold: cap - 1000 });
    expect(first.json().accepted).toEqual([{ resource: 'gold', amount: cap - 1000 }]);
    // The second hero of the same account shares the cap.
    const second = await contribute({ who: p!.who, heroId: twin.id }, FORGEWARD.id, ROAD!.id, {
      gold: 50_000,
    });
    expect(second.json()).toMatchObject({
      accepted: [{ resource: 'gold', amount: 1000 }],
      limited: { gold: 'cap' },
    });
    expect(await gold(twin.id)).toBe(RICH.gold - 1000);
    const third = await contribute(p!, FORGEWARD.id, ROAD!.id, { gold: 1 });
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('contribution_capped');
  });

  it('refuses test accounts (D.4): nothing taken, nothing counted', async () => {
    await liveWorld();
    const [p] = await patrons(1);
    await setTestAccount(db(), p!.who.handle, true);
    for (const projectId of ['forgewardOutpost', 'restoreWarehouse']) {
      const res = await contribute(p!, projectId, ROAD!.id, { gold: 1000 });
      expect(res.statusCode, projectId).toBe(403);
      expect(res.json().error.code).toBe('test_account');
    }
    expect(await gold(p!.heroId)).toBe(RICH.gold);
    expect(await db().select().from(communityContributions)).toEqual([]);
    expect(await audits('community.contribute')).toEqual([]);
    // Back to a normal account, the same gift goes through.
    await setTestAccount(db(), p!.who.handle, false);
    expect((await contribute(p!, FORGEWARD.id, ROAD!.id, { gold: 1000 })).statusCode).toBe(200);
  });

  it('the window rule at a stage completion: 23:59:59 counts on that day, the next stage’s cap grows from its own first day', async () => {
    await liveWorld();
    const town = await patrons(10);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    nowMs = Date.parse(`${day}T23:59:59.000Z`);
    const out = await giveCaps(town, ROAD!);
    expect(out[9]!.stagesCompleted).toEqual(['slagRoad']);
    // The first giver to the walls, the same second: the walls' first day is today.
    const g = stageCap(WALLS!, 'gold');
    const late = await contribute(town[0]!, FORGEWARD.id, WALLS!.id, { gold: g });
    expect(late.json().accepted).toEqual([{ resource: 'gold', amount: g }]);
    // One millisecond past midnight: a new window, and the walls stood one day, so 30 %.
    nowMs = Date.parse(`${day}T23:59:59.000Z`) + 1001;
    expect(stageCap(WALLS!, 'gold', 1)).toBe(30_000);
    const next = await contribute(town[0]!, FORGEWARD.id, WALLS!.id, { gold: 10 * g });
    expect(next.json().accepted).toEqual([{ resource: 'gold', amount: 30_000 }]);
    const rows = await db()
      .select({ stage: communityContributions.stageId, day: communityContributions.day })
      .from(communityContributions)
      .where(
        and(
          eq(communityContributions.accountId, town[0]!.who.id),
          eq(communityContributions.resource, 'gold'),
        ),
      );
    const next1 = new Date(nowMs).toISOString().slice(0, 10);
    expect(rows.map((r) => `${r.stage} ${r.day}`).sort()).toEqual(
      [`forgewardWalls ${day}`, `forgewardWalls ${next1}`, `slagRoad ${day}`].sort(),
    );
    // A road gift after it finished is refused and takes nothing.
    const stale = await contribute(town[1]!, FORGEWARD.id, ROAD!.id, { gold: 1 });
    expect(stale.json().error).toMatchObject({
      code: 'stage_changed',
      details: { currentStageId: 'forgewardWalls' },
    });
  });

  it('the Forgeward bellows: Tyrantforged Work costs 2,400 gold once the outpost stands, charged and audited', async () => {
    await liveWorld();
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const smith = await insertCharacter(db(), who.id, { level: 36 });
    await fund(db(), smith.id, {
      gold: 10_000,
      materials: { tyrantsEmber: 2, ironOre: 200, soulShard: 50 },
    });
    const recipe = async () =>
      (await get(who, `/api/characters/${smith.id}/forge`))
        .json<{ recipes: { recipeId: string; gold: number; townUpgrade?: object }[] }>()
        .recipes.find((r) => r.recipeId === 'tyrantforgedWork')!;
    expect(await recipe()).not.toHaveProperty('townUpgrade');
    expect((await recipe()).gold).toBe(3_000);
    const craft = () =>
      post(who, `/api/characters/${smith.id}/forge/craft`, {
        recipeId: 'tyrantforgedWork',
        slot: 'chest',
      });
    expect((await craft()).statusCode).toBe(200);
    expect(await gold(smith.id)).toBe(7_000);
    await completeProject(db(), FORGEWARD.id, new Date(nowMs));
    app.worldState.invalidate();
    expect(await recipe()).toMatchObject({
      gold: 2_400,
      townUpgrade: { id: 'forgewardBellows', baseGold: 3_000 },
    });
    expect((await craft()).statusCode).toBe(200);
    expect(await gold(smith.id)).toBe(4_600);
    expect((await audits('forge.craft')).map((a) => (a.data as { gold: number }).gold)).toEqual([
      3_000, 2_400,
    ]);
    // Other recipes keep their prices.
    const others = (await get(who, `/api/characters/${smith.id}/forge`))
      .json<{ recipes: { recipeId: string; townUpgrade?: object }[] }>()
      .recipes.filter((r) => r.recipeId !== 'tyrantforgedWork');
    for (const r of others) expect(r, r.recipeId).not.toHaveProperty('townUpgrade');
    const checks = await reconcileWithAudit(db());
    for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
  });

  it('takes no access away: the Verge, the Depths and the Tyrant’s Forge open the same with or without the flag', async () => {
    await liveWorld();
    const top: WorldProgress = {
      gravewardenDefeated: true,
      cryptTierCleared: 3,
      ashenWardenDefeated: true,
      forgeTyrantDefeated: true,
    };
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const heroes = await Promise.all(
      [27, 28, 34, 36, 40].map((level) => insertCharacter(db(), who.id, { level, progress: top })),
    );
    const view = async () => {
      const out: unknown[] = [];
      for (const h of heroes) {
        out.push((await get(who, `/api/characters/${h.id}/world`)).json().areas);
        out.push((await get(who, `/api/characters/${h.id}/dungeon`)).json().dungeons);
      }
      return out;
    };
    const before = await view();
    const lvl36 = before[7] as { id: string; tiers?: unknown; unlocked?: boolean }[];
    expect(JSON.stringify(lvl36)).toContain('tyrantsForge');
    await completeProject(db(), FORGEWARD.id, new Date(nowMs));
    app.worldState.invalidate();
    expect(await view()).toEqual(before);
  });
});

describe('admin: the era and the chain (ticket 6.7)', () => {
  const adminCall = (method: 'GET' | 'POST', url: string, payload?: object) =>
    method === 'GET' ? get(admin, url) : post(admin, url, payload!);

  it('shows the era and every project’s stage; a flag toggle moves the era, audited and counted', async () => {
    await liveWorld();
    const view = (await adminCall('GET', '/api/admin/world')).json();
    expect(view.era).toEqual({
      id: 'rekindling',
      name: 'The Rekindling',
      title: 'Era of the Rekindling',
      index: 2,
    });
    expect(
      view.projects.map((p: { id: string; status: string; stage: number }) => [
        p.id,
        p.status,
        p.stage,
      ]),
    ).toEqual([
      ['restoreWarehouse', 'complete', 3],
      ['clearAshenPass', 'complete', 3],
      ['forgewardOutpost', 'open', 1],
      ['deepLanterns', 'locked', 1],
    ]);
    const on = await adminCall('POST', '/api/admin/world/flags/forgewardRaised', {
      set: true,
      confirm: 'forgewardRaised',
      reason: 'test the Forgeward Age',
    });
    expect(on.json()).toMatchObject({
      after: true,
      era: { from: 'rekindling', to: 'forgewardAge' },
    });
    expect((await adminCall('GET', '/api/admin/world')).json().era.id).toBe('forgewardAge');
    const off = await adminCall('POST', '/api/admin/world/flags/forgewardRaised', {
      set: false,
      confirm: 'forgewardRaised',
      reason: 'back to live',
    });
    expect(off.json().era).toEqual({ from: 'forgewardAge', to: 'rekindling' });
    // A toggle that leaves the era alone records no change.
    const pass = await adminCall('POST', '/api/admin/world/flags/warehouseRestored', {
      set: false,
      confirm: 'warehouseRestored',
      reason: 'no era change',
    });
    expect(pass.json().era).toBeNull();
    const changes = (await audits('world.era_change')).slice(2).map((a) => a.data);
    expect(changes).toEqual([
      { from: 'rekindling', to: 'forgewardAge', flagId: 'forgewardRaised', by: 'admin' },
      { from: 'forgewardAge', to: 'rekindling', flagId: 'forgewardRaised', by: 'admin' },
    ]);
    const checks = await reconcileWithAudit(db());
    for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
  });

  it('the stage command finishes one stage on a test setup and is refused in production', async () => {
    await liveWorld();
    const refused = await advanceStage(db(), FORGEWARD.id, new Date(nowMs), { production: true });
    expect(refused).toMatch(/^Refused/);
    expect(await audits('community.admin_stage')).toEqual([]);
    await advanceStage(db(), FORGEWARD.id, new Date(nowMs), { production: false });
    const [row] = await db()
      .select()
      .from(communityProjects)
      .where(eq(communityProjects.projectId, FORGEWARD.id));
    expect(row).toMatchObject({ stageIndex: 1, completedAt: null });
    await advanceStage(db(), FORGEWARD.id, new Date(nowMs), { production: false });
    expect(await advanceStage(db(), FORGEWARD.id, new Date(nowMs), { production: false })).toMatch(
      /flag forgewardRaised set/,
    );
    const [flag] = await db()
      .select()
      .from(worldFlags)
      .where(eq(worldFlags.flagId, 'forgewardRaised'));
    expect(flag).toBeDefined();
    expect((await audits('community.admin_stage')).length).toBe(3);
    // Nobody gave, so nobody earned the mark.
    expect(
      await db()
        .select()
        .from(accountAchievements)
        .where(eq(accountAchievements.achievementId, 'forgewardBuilder')),
    ).toEqual([]);
    expect(
      await db().select({ id: accounts.id }).from(accounts).where(eq(accounts.isTest, true)),
    ).toEqual([]);
  });
});
