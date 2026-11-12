/**
 * Ticket 8.2 (docs/COMMUNITY.md "The lanterns of the deep"): the Hollow Reach's community gate
 * through the real API. It opens after the Forgeward Outpost; ten accounts finish a stage on its
 * first day (B.5b's tenth each); its flag opens the Hollow Deep and the Hollow Throne (new content
 * only) and begins the Lantern Vigil; test accounts are refused; the window rule holds at a stage
 * completion; every contribution reconciles.
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
  auditLog,
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
import { contributeCall, insertPatron, type Patron } from '../test/community.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { setTestAccount } from '../admin/test-accounts.js';
import { completeProject } from './project-cli.js';

const LANTERNS = findCommunityProject('deepLanterns')!;
const [POSTS, CHAINS, KINDLE] = LANTERNS.stages;
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

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now: () => new Date(nowMs) },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
  contribute = contributeCall(app);
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
const world = async (who: TestAccount) =>
  (await get(who, '/api/world')).json<{
    flags: Record<string, boolean>;
    era: { id: string; index: number; title: string };
  }>();
const audits = (event: string) =>
  db().select().from(auditLog).where(eq(auditLog.event, event)).orderBy(auditLog.id);
const patrons = (n: number) =>
  Promise.all(Array.from({ length: n }, () => insertPatron(db(), RICH)));

/** The town through the Forgeward Outpost (by the owner's CLI, the real path). */
async function forgewardWorld() {
  for (const id of ['restoreWarehouse', 'clearAshenPass', 'forgewardOutpost'])
    await completeProject(db(), id, new Date(nowMs));
  app.worldState.invalidate();
}

/** Each patron gives its whole first-day cap of every need of `stage`. */
async function giveCaps(ps: Patron[], stage = POSTS!) {
  const offer = Object.fromEntries(
    stage.needs.map((n) => [n.resource, stageCap(stage, n.resource)]),
  );
  const out = [];
  for (const p of ps) {
    const res = await contribute(p, LANTERNS.id, stage.id, offer);
    expect(res.statusCode, res.body).toBe(200);
    out.push(res.json<{ stagesCompleted: string[]; projectCompleted: boolean }>());
  }
  return out;
}

const TYRANT_SLAYER: WorldProgress = {
  gravewardenDefeated: true,
  cryptTierCleared: 4,
  ashenWardenDefeated: true,
  forgeTyrantDefeated: true,
};

describe('the lanterns of the deep (ticket 8.2)', () => {
  it('waits for the Forgeward, then ten givers a stage light it: flag, the Deep, era, achievements, reconciled', async () => {
    const [p] = await patrons(1);
    // Locked until the Forgeward Outpost stands.
    await completeProject(db(), 'restoreWarehouse', new Date(nowMs));
    await completeProject(db(), 'clearAshenPass', new Date(nowMs));
    app.worldState.invalidate();
    const early = await contribute(p!, LANTERNS.id, POSTS!.id, { gold: 1000 });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('project_locked');
    await completeProject(db(), 'forgewardOutpost', new Date(nowMs));
    app.worldState.invalidate();
    expect((await world(p!.who)).era).toMatchObject({ id: 'forgewardAge' });

    // A Tyrant slayer at 50 sees the Deep and the Throne behind the lanterns.
    const delver = await insertAccount(db(), { now: new Date(nowMs) });
    const h = await insertCharacter(db(), delver.id, { level: 50, progress: TYRANT_SLAYER });
    const deep = async () =>
      (await get(delver, `/api/characters/${h.id}/world`))
        .json<{ areas: { id: string; unlocked: boolean }[] }>()
        .areas.find((a) => a.id === 'hollowDeep')!;
    const throne = async () =>
      (await get(delver, `/api/characters/${h.id}/dungeon`))
        .json<{ dungeons: { id: string; unlocked: boolean }[] }>()
        .dungeons.find((d) => d.id === 'hollowThrone')!;
    expect((await deep()).unlocked).toBe(false);
    expect((await throne()).unlocked).toBe(false);

    // Ten players a day finish a stage; nine never do.
    const town = [p!, ...(await patrons(9))];
    for (const [i, stage] of [POSTS!, CHAINS!, KINDLE!].entries()) {
      const out = await giveCaps(town, stage);
      expect(out.slice(0, 9).every((o) => o.stagesCompleted.length === 0)).toBe(true);
      expect(out[9]!.stagesCompleted).toEqual([stage.id]);
      expect(out[9]!.projectCompleted).toBe(i === 2);
    }
    const embers = await db()
      .select({ n: sql<number>`sum(${communityContributions.amount})::int` })
      .from(communityContributions)
      .where(eq(communityContributions.resource, 'tyrantsEmber'));
    expect(embers[0]!.n).toBe(10);

    const after = await world(p!.who);
    expect(after.flags.deepLanternsLit).toBe(true);
    expect(after.era).toMatchObject({ id: 'lanternVigil', title: 'Era of the Lantern Vigil' });
    expect((await audits('world.era_change')).at(-1)!.data).toEqual({
      from: 'forgewardAge',
      to: 'lanternVigil',
      projectId: LANTERNS.id,
    });
    expect((await deep()).unlocked).toBe(true);
    expect((await throne()).unlocked).toBe(true);
    const awarded = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.achievementId, 'deepLanternBearer'));
    expect(awarded.map((a) => a.accountId).sort()).toEqual(town.map((t) => t.who.id).sort());

    const checks = await reconcileWithAudit(db());
    for (const c of checks) expect(c, c.check).toMatchObject({ ok: true });
    expect(checks.map((c) => c.check)).toContain('community: deepLanterns contributions');
  });

  it('caps each account at a tenth on the first day, whatever its heroes', async () => {
    await forgewardWorld();
    const [p] = await patrons(1);
    const cap = stageCap(POSTS!, 'gold');
    expect(cap).toBe(9_000);
    const first = await contribute(p!, LANTERNS.id, POSTS!.id, { gold: 50_000 });
    expect(first.json()).toMatchObject({
      accepted: [{ resource: 'gold', amount: cap }],
      limited: { gold: 'cap' },
    });
    const again = await contribute(p!, LANTERNS.id, POSTS!.id, { gold: 1 });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('contribution_capped');
  });

  it('refuses test accounts (D.4): nothing taken, nothing counted', async () => {
    await forgewardWorld();
    const [p] = await patrons(1);
    await setTestAccount(db(), p!.who.handle, true);
    const res = await contribute(p!, LANTERNS.id, POSTS!.id, { gold: 1000 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('test_account');
    expect(await db().select().from(communityContributions)).toEqual([]);
    expect(await audits('community.contribute')).toEqual([]);
    await setTestAccount(db(), p!.who.handle, false);
    expect((await contribute(p!, LANTERNS.id, POSTS!.id, { gold: 1000 })).statusCode).toBe(200);
  });

  it('the window rule at a stage completion: 23:59:59 counts on that day, the next stage grows from its own first day', async () => {
    await forgewardWorld();
    const town = await patrons(10);
    const day = new Date(nowMs).toISOString().slice(0, 10);
    nowMs = Date.parse(`${day}T23:59:59.000Z`);
    const out = await giveCaps(town, POSTS!);
    expect(out[9]!.stagesCompleted).toEqual(['lanternPosts']);
    const g = stageCap(CHAINS!, 'gold');
    const late = await contribute(town[0]!, LANTERNS.id, CHAINS!.id, { gold: g });
    expect(late.json().accepted).toEqual([{ resource: 'gold', amount: g }]);
    // Past midnight: a new window, and the chains stood one day, so 30 %.
    nowMs = Date.parse(`${day}T23:59:59.000Z`) + 1001;
    expect(stageCap(CHAINS!, 'gold', 1)).toBe(39_000);
    const next = await contribute(town[0]!, LANTERNS.id, CHAINS!.id, { gold: 10 * g });
    expect(next.json().accepted).toEqual([{ resource: 'gold', amount: 39_000 }]);
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
      [`lanternChains ${day}`, `lanternChains ${next1}`, `lanternPosts ${day}`].sort(),
    );
    const stale = await contribute(town[1]!, LANTERNS.id, POSTS!.id, { gold: 1 });
    expect(stale.json().error).toMatchObject({
      code: 'stage_changed',
      details: { currentStageId: 'lanternChains' },
    });
  });

  it('takes no live access away: every other place opens the same before and after', async () => {
    await forgewardWorld();
    const who = await insertAccount(db(), { now: new Date(nowMs) });
    const heroes = await Promise.all(
      [28, 36, 40, 46, 52].map((level) =>
        insertCharacter(db(), who.id, { level, progress: TYRANT_SLAYER }),
      ),
    );
    const view = async () => {
      const out: unknown[] = [];
      for (const h of heroes) {
        const areas = (await get(who, `/api/characters/${h.id}/world`)).json<{
          areas: { id: string }[];
        }>().areas;
        const dungeons = (await get(who, `/api/characters/${h.id}/dungeon`)).json<{
          dungeons: { id: string }[];
        }>().dungeons;
        out.push(areas.filter((a) => a.id !== 'hollowDeep'));
        out.push(dungeons.filter((d) => d.id !== 'hollowThrone'));
      }
      return out;
    };
    const before = await view();
    await completeProject(db(), LANTERNS.id, new Date(nowMs));
    app.worldState.invalidate();
    expect(await view()).toEqual(before);
  });
});
