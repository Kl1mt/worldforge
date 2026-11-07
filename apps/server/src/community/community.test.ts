import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { findCommunityProject, stageCap } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  accountAchievements,
  auditLog,
  characterMaterials,
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
import type { ProjectBoard } from './model.js';
import { completeProject } from './project-cli.js';
import { WorldStateCache } from './world-state.js';

const WAREHOUSE = findCommunityProject('restoreWarehouse')!;
const [RUBBLE, ROOF, DOORS] = WAREHOUSE.stages;
const RICH = {
  gold: 1_000_000,
  materials: { timber: 10_000, rawHide: 10_000, ironOre: 10_000, ashwort: 10_000 },
};

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2031-03-10T12:00:00Z');
let contribute: ReturnType<typeof contributeCall>;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
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
  // Every test starts from an untouched world.
  await database.db.delete(communityContributions);
  await database.db.delete(communityProjectProgress);
  await database.db.delete(communityProjects);
  await database.db.delete(worldFlags);
  await database.db.delete(auditLog);
  await database.db.delete(telemetryDaily);
  await database.db.delete(accountAchievements);
  app.worldState.invalidate();
});

const db = () => database.db;
const get = (p: Patron, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: p.who.token }, headers });
const board = async (p: Patron) => (await get(p, '/api/community/projects')).json<ProjectBoard>();
const gold = async (p: Patron) =>
  (
    await db().select({ g: characters.gold }).from(characters).where(eq(characters.id, p.heroId))
  )[0]!.g;
const material = async (p: Patron, id: string) =>
  (
    await db()
      .select({ q: characterMaterials.quantity })
      .from(characterMaterials)
      .where(sql`${characterMaterials.characterId} = ${p.heroId} and material_id = ${id}`)
  )[0]?.q ?? 0;
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

/** Gives every stage of the warehouse its full need from five patrons at their caps. */
async function finishWarehouse(patrons: Patron[]) {
  for (const stage of WAREHOUSE.stages) {
    for (const p of patrons) {
      const offer = Object.fromEntries(
        stage.needs.map((n) => [n.resource, stageCap(stage, n.resource)]),
      );
      const r = await contribute(p, WAREHOUSE.id, stage.id, offer);
      expect(r.statusCode, r.body).toBe(200);
    }
  }
}

describe('community projects: the board', () => {
  it('starts with the warehouse open, the Ashen Pass locked, and caps per need', async () => {
    const p = await insertPatron(db(), {});
    const b = await board(p);
    expect(b.window).toEqual({ day: '2031-03-10', resetsAt: '2031-03-11T00:00:00.000Z' });
    const [warehouse, pass] = b.projects;
    expect(warehouse).toMatchObject({ id: 'restoreWarehouse', status: 'open', stageIndex: 0 });
    expect(pass).toMatchObject({
      id: 'clearAshenPass',
      status: 'locked',
      requires: 'restoreWarehouse',
    });
    expect(warehouse!.stages.map((s) => s.status)).toEqual(['current', 'upcoming', 'upcoming']);
    expect(warehouse!.stages[0]!.needs).toEqual([
      { resource: 'gold', required: 4000, delivered: 0, cap: 800, givenToday: 0 },
      { resource: 'timber', required: 400, delivered: 0, cap: 80, givenToday: 0 },
    ]);
    // Reads never create rows.
    expect(await db().select().from(communityProjects)).toHaveLength(0);
  });

  it('answers 304 to an unchanged poll and 401 without a session', async () => {
    const p = await insertPatron(db(), {});
    const first = await get(p, '/api/community/projects');
    const again = await get(p, '/api/community/projects', {
      'if-none-match': first.headers.etag as string,
    });
    expect(again.statusCode).toBe(304);
    expect((await app.inject({ method: 'GET', url: '/api/community/projects' })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/api/world' })).statusCode).toBe(401);
  });
});

describe('community projects: contributing', () => {
  it('spends from the hero, adds to the stage, audits and records telemetry', async () => {
    const p = await insertPatron(db(), RICH);
    const r = await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 500, timber: 30 });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      accepted: [
        { resource: 'gold', amount: 500 },
        { resource: 'timber', amount: 30 },
      ],
      limited: {},
      stagesCompleted: [],
      projectCompleted: false,
      character: { gold: RICH.gold - 500 },
    });
    expect(await gold(p)).toBe(RICH.gold - 500);
    expect(await material(p, 'timber')).toBe(10_000 - 30);
    const b = await board(p);
    expect(b.projects[0]!.stages[0]!.needs).toMatchObject([
      { resource: 'gold', delivered: 500, givenToday: 500 },
      { resource: 'timber', delivered: 30, givenToday: 30 },
    ]);
    expect(b.projects[0]!.yours).toEqual([
      { resource: 'gold', amount: 500 },
      { resource: 'timber', amount: 30 },
    ]);
    expect(b.projects[0]!.contributors).toBe(1);
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(sql`event = 'community.contribute' and account_id = ${p.who.id}`);
    expect(audit!.data).toMatchObject({
      projectId: 'restoreWarehouse',
      stageId: 'clearRubble',
      day: '2031-03-10',
      gold: 500,
      materials: { timber: 30 },
      goldAfter: RICH.gold - 500,
    });
    const rollups = await db()
      .select()
      .from(telemetryDaily)
      .where(sql`dim1 = 'community_project' or metric like 'community.%'`);
    expect(rollups.map((r) => [r.metric, r.dim1, r.dim2, r.amount]).sort()).toEqual(
      [
        ['community.contribute', 'restoreWarehouse', 'clearRubble', 0],
        ['gold.out', 'community_project', 'restoreWarehouse', 500],
        ['material.out', 'community_project', 'timber', 30],
      ].sort(),
    );
  });

  it('replays an Idempotency-Key without charging twice', async () => {
    const p = await insertPatron(db(), RICH);
    const first = await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 100 }, 'same-key-123');
    const again = await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 100 }, 'same-key-123');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(await gold(p)).toBe(RICH.gold - 100);
    const missing = await app.inject({
      method: 'POST',
      url: `/api/community/projects/${WAREHOUSE.id}/contribute`,
      cookies: { [SESSION_COOKIE]: p.who.token },
      payload: {
        characterId: p.heroId,
        stageId: RUBBLE!.id,
        offer: [{ resource: 'gold', amount: 1 }],
      },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('refuses what is not held, not needed, a stale stage, locked or unknown projects — spending nothing', async () => {
    const p = await insertPatron(db(), { gold: 50, materials: { timber: 5 } });
    const cases: [Promise<{ statusCode: number; json: () => unknown }>, number, string][] = [
      [contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 51 }), 422, 'insufficient_gold'],
      [contribute(p, WAREHOUSE.id, RUBBLE!.id, { timber: 6 }), 422, 'insufficient_materials'],
      [contribute(p, WAREHOUSE.id, RUBBLE!.id, { ironOre: 1 }), 422, 'not_needed'],
      [contribute(p, WAREHOUSE.id, ROOF!.id, { gold: 1 }), 409, 'stage_changed'],
      [contribute(p, 'clearAshenPass', 'scoutPass', { gold: 1 }), 409, 'project_locked'],
      [contribute(p, 'noSuchProject', 'x', { gold: 1 }), 404, 'not_found'],
      [contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 0 }), 400, 'validation_failed'],
      [contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 1.5 }), 400, 'validation_failed'],
    ];
    for (const [call, status, c] of cases) {
      const r = await call;
      expect([r.statusCode, code(r)]).toEqual([status, c]);
    }
    const dup = await app.inject({
      method: 'POST',
      url: `/api/community/projects/${WAREHOUSE.id}/contribute`,
      cookies: { [SESSION_COOKIE]: p.who.token },
      headers: { 'idempotency-key': 'dup-resource-1' },
      payload: {
        characterId: p.heroId,
        stageId: RUBBLE!.id,
        offer: [
          { resource: 'gold', amount: 1 },
          { resource: 'gold', amount: 2 },
        ],
      },
    });
    expect(dup.statusCode).toBe(400);
    // Another account's hero: 404, like an unknown one.
    const other = await insertPatron(db(), RICH);
    const foreign = await contribute(
      { who: p.who, heroId: other.heroId },
      WAREHOUSE.id,
      RUBBLE!.id,
      { gold: 1 },
    );
    expect(foreign.statusCode).toBe(404);
    expect(await gold(p)).toBe(50);
    expect(await material(p, 'timber')).toBe(5);
    expect(await db().select().from(communityContributions)).toHaveLength(0);
  });
});

describe('community projects: no monopoly (caps per window)', () => {
  it('takes at most the cap per account and day, across all its heroes, and resets at UTC midnight', async () => {
    const p = await insertPatron(db(), RICH);
    const second = await insertCharacter(db(), p.who.id, { level: 12 });
    await fund(db(), second.id, RICH);
    const alt: Patron = { who: p.who, heroId: second.id };

    nowMs = Date.parse('2031-03-10T23:59:00Z');
    const big = await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 5000, timber: 50 });
    expect(big.json()).toMatchObject({
      accepted: [
        { resource: 'gold', amount: 800 },
        { resource: 'timber', amount: 50 },
      ],
      limited: { gold: 'cap' },
    });
    expect(await gold(p)).toBe(RICH.gold - 800);
    // The account's other hero shares the cap.
    const more = await contribute(alt, WAREHOUSE.id, RUBBLE!.id, { gold: 10, timber: 100 });
    expect(more.json()).toMatchObject({
      accepted: [{ resource: 'timber', amount: 30 }],
      limited: { gold: 'cap', timber: 'cap' },
    });
    const capped = await contribute(alt, WAREHOUSE.id, RUBBLE!.id, { gold: 10 });
    expect([capped.statusCode, code(capped)]).toEqual([409, 'contribution_capped']);
    // Window rule: two minutes later is the next game day, with a fresh cap.
    nowMs = Date.parse('2031-03-11T00:01:00Z');
    const next = await contribute(alt, WAREHOUSE.id, RUBBLE!.id, { gold: 10 });
    expect(next.json()).toMatchObject({ accepted: [{ resource: 'gold', amount: 10 }] });
    const days = await db()
      .select({
        day: communityContributions.day,
        resource: communityContributions.resource,
        amount: communityContributions.amount,
      })
      .from(communityContributions)
      .where(eq(communityContributions.accountId, p.who.id));
    expect(days.sort((a, b) => (a.day + a.resource < b.day + b.resource ? -1 : 1))).toEqual([
      { day: '2031-03-10', resource: 'gold', amount: 800 },
      { day: '2031-03-10', resource: 'timber', amount: 80 },
      { day: '2031-03-11', resource: 'gold', amount: 10 },
    ]);
    nowMs = Date.parse('2031-03-10T12:00:00Z');
  });

  it('a single account can never finish a stage in one day', async () => {
    const p = await insertPatron(db(), RICH);
    await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 4000, timber: 400 });
    const b = await board(p);
    expect(b.projects[0]!.stageIndex).toBe(0);
    expect(b.projects[0]!.stages[0]!.needs.map((n) => n.delivered)).toEqual([800, 80]);
  });
});

describe('community projects: stages and completion', () => {
  it('fills a stage exactly at the boundary, moves on, and takes no more than the remaining need', async () => {
    const patrons = await Promise.all([1, 2, 3, 4, 5, 6].map(() => insertPatron(db(), RICH)));
    for (const p of patrons.slice(0, 4)) {
      await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 800, timber: 80 });
    }
    // Remaining: 800 gold, 80 timber. The fifth gives all the gold and part of the timber.
    const fifth = await contribute(patrons[4]!, WAREHOUSE.id, RUBBLE!.id, {
      gold: 800,
      timber: 50,
    });
    expect(fifth.json()).toMatchObject({ stagesCompleted: [] });
    const sixth = await contribute(patrons[5]!, WAREHOUSE.id, RUBBLE!.id, {
      gold: 300,
      timber: 80,
    });
    expect(sixth.json()).toMatchObject({
      accepted: [{ resource: 'timber', amount: 30 }],
      limited: { gold: 'stage', timber: 'stage' },
      stagesCompleted: ['clearRubble'],
    });
    expect(await gold(patrons[5]!)).toBe(RICH.gold);
    expect(await material(patrons[5]!, 'timber')).toBe(10_000 - 30);
    const b = await board(patrons[0]!);
    expect(b.projects[0]!.stageIndex).toBe(1);
    expect(b.projects[0]!.stages.map((s) => s.status)).toEqual(['done', 'current', 'upcoming']);
    const stale = await contribute(patrons[0]!, WAREHOUSE.id, RUBBLE!.id, { gold: 1 });
    expect([stale.statusCode, code(stale)]).toEqual([409, 'stage_changed']);
    expect((stale.json() as { error: { details: unknown } }).error.details).toEqual({
      currentStageId: 'raiseRoof',
    });
    const audits = await db()
      .select()
      .from(auditLog)
      .where(sql`event = 'community.stage_complete'`);
    expect(audits.map((a) => a.data)).toEqual([
      { projectId: 'restoreWarehouse', stageId: 'clearRubble', stageIndex: 0 },
    ]);
  });

  it('completing the project sets the flag, opens the Ashen Pass, rewards every contributor and reconciles', async () => {
    const patrons = await Promise.all([1, 2, 3, 4, 5].map(() => insertPatron(db(), RICH)));
    const bystander = await insertPatron(db(), RICH);
    // Prime the cache with "not restored".
    expect((await app.worldState.flags()).warehouseRestored).toBe(false);
    const loads = app.worldState.loads;
    expect((await get(bystander, '/api/world')).json()).toMatchObject({
      flags: { warehouseRestored: false },
    });
    expect(app.worldState.loads).toBe(loads);

    await finishWarehouse(patrons);
    // Invalidated on completion: the next read sees the flag at once.
    const world = (await get(bystander, '/api/world')).json<{
      flags: Record<string, boolean>;
      completed: unknown[];
    }>();
    expect(world.flags).toEqual({ warehouseRestored: true, ashenPassCleared: false });
    expect(world.completed).toEqual([{ projectId: 'restoreWarehouse', completedOn: '2031-03-10' }]);
    const [flag] = await db().select().from(worldFlags);
    expect(flag).toMatchObject({ flagId: 'warehouseRestored', projectId: 'restoreWarehouse' });

    const b = await board(bystander);
    expect(b.projects.map((p) => p.status)).toEqual(['complete', 'open']);
    expect(b.projects[0]).toMatchObject({
      completedOn: '2031-03-10',
      contributors: 5,
      stageIndex: 3,
    });
    expect(
      b.projects[0]!.stages.every((s) => s.needs.every((n) => n.delivered === n.required)),
    ).toBe(true);
    expect(b.projects[0]!.reward).toEqual({ achievementId: 'warehouseRestorer', earned: false });
    expect((await board(patrons[0]!)).projects[0]!.reward.earned).toBe(true);

    const awards = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.achievementId, 'warehouseRestorer'));
    expect(awards.map((a) => a.accountId).sort()).toEqual(patrons.map((p) => p.who.id).sort());
    // Exactly the totals: nothing over-filled.
    const totals = await db().select().from(communityProjectProgress);
    for (const stage of WAREHOUSE.stages) {
      for (const n of stage.needs) {
        expect(
          totals.find((t) => t.stageId === stage.id && t.resource === n.resource)?.amount,
        ).toBe(n.amount);
      }
    }
    const done = await contribute(patrons[0]!, WAREHOUSE.id, DOORS!.id, { gold: 1 });
    expect([done.statusCode, code(done)]).toEqual([409, 'project_complete']);
    // The second project takes contributions now.
    const pass = await contribute(patrons[0]!, 'clearAshenPass', 'scoutPass', { gold: 100 });
    expect(pass.statusCode, pass.body).toBe(200);

    const completions = await db()
      .select()
      .from(auditLog)
      .where(sql`event = 'community.project_complete'`);
    expect(completions.map((c) => c.data)).toEqual([
      { projectId: 'restoreWarehouse', flag: 'warehouseRestored', contributors: 5 },
    ]);
    const checks = await reconcileWithAudit(db());
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.check === 'community: stages completed')).toMatchObject({
      audit: 3,
      rollup: 3,
    });
  });
});

describe('world state cache', () => {
  it('serves from memory within the TTL, reloads after it, and never stores a load raced by an invalidation', async () => {
    let clock = 0;
    const cache = new WorldStateCache(db(), 1000, () => clock);
    expect((await cache.flags()).warehouseRestored).toBe(false);
    await db()
      .insert(worldFlags)
      .values({ flagId: 'warehouseRestored', setAt: new Date(nowMs) });
    // A change by another process (the CLI) is not seen until the TTL ends…
    expect((await cache.flags()).warehouseRestored).toBe(false);
    expect(cache.loads).toBe(1);
    clock = 1000;
    expect((await cache.flags()).warehouseRestored).toBe(true);
    expect(cache.loads).toBe(2);
    // …or an invalidation.
    await db().delete(worldFlags);
    cache.invalidate();
    expect((await cache.flags()).warehouseRestored).toBe(false);
    // A load in flight when an invalidation lands is returned but not cached.
    cache.invalidate();
    const racing = cache.get();
    cache.invalidate();
    await racing;
    await cache.flags();
    expect(cache.loads).toBe(5);
    // A fresh process (restart) reads the table.
    await db()
      .insert(worldFlags)
      .values({ flagId: 'ashenPassCleared', setAt: new Date(nowMs) });
    expect((await new WorldStateCache(db()).flags()).ashenPassCleared).toBe(true);
  });
});

describe('owner CLI: admin:project complete', () => {
  it('finishes an open project through the normal path, refuses a locked one, and is audited', async () => {
    const p = await insertPatron(db(), RICH);
    await contribute(p, WAREHOUSE.id, RUBBLE!.id, { gold: 10 });
    expect(await completeProject(db(), 'clearAshenPass', new Date(nowMs))).toMatch(
      /has not opened/,
    );
    expect(await completeProject(db(), 'nope', new Date(nowMs))).toMatch(/No project/);
    expect(await completeProject(db(), WAREHOUSE.id, new Date(nowMs))).toMatch(/completed/);
    expect(await completeProject(db(), WAREHOUSE.id, new Date(nowMs))).toMatch(/already complete/);
    expect(await db().select().from(worldFlags)).toHaveLength(1);
    const events = await db()
      .select({ event: auditLog.event, data: auditLog.data })
      .from(auditLog)
      .where(
        sql`event like 'community.%' and data->>'projectId' = 'restoreWarehouse' and (event <> 'community.contribute')`,
      );
    expect(events.filter((e) => e.event === 'community.admin_complete')).toHaveLength(1);
    expect(
      events.filter(
        (e) => e.event === 'community.stage_complete' && (e.data as { by?: string }).by === 'admin',
      ).length,
    ).toBeGreaterThanOrEqual(3);
    const award = await db()
      .select()
      .from(accountAchievements)
      .where(sql`account_id = ${p.who.id} and achievement_id = 'warehouseRestorer'`);
    expect(award).toHaveLength(1);
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
  });
});
