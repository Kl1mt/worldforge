/**
 * Real-PostgreSQL races for community projects (ticket 4.6, docs/COMMUNITY.md "Races"). Runs when
 * `DATABASE_URL` is set, skipped otherwise (CI sets `REQUIRE_PG_TESTS=1`). Every contribution
 * locks the hero, then the project row; totals, caps and completion are decided under that lock.
 * Each race runs a few rounds in varied orders and asserts only what holds in every order: no
 * over-fill, no lost contribution (what each hero paid = what it was told was accepted = what the
 * audit log says = what the totals grew by), exactly one completion, caps exact, telemetry
 * reconciled, and no transaction retried.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, inArray, sql } from 'drizzle-orm';
import { findCommunityProject, stageCap } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accountAchievements,
  auditLog,
  characters,
  communityContributions,
  communityProjectProgress,
  communityProjects,
  worldFlags,
} from '../db/schema.js';
import { transactionStats } from '../db/transaction.js';
import type { DatabaseHandle } from '../db/types.js';
import { reconcileWithAudit } from '../telemetry/report.js';
import { createPostgresTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { contributeCall, fund, insertPatron, type Patron } from '../test/community.js';

const url = process.env.DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === '1') {
  throw new Error('REQUIRE_PG_TESTS=1 but DATABASE_URL is not set');
}

const N = 8;
const ROUNDS = 3;
const WAREHOUSE = findCommunityProject('restoreWarehouse')!;
const RUBBLE = WAREHOUSE.stages[0]!;
const DOORS = WAREHOUSE.stages[2]!;
const START_GOLD = 100_000;
const START = { gold: START_GOLD, materials: { timber: 1_000, ironOre: 1_000 } };

function shuffled<T>(xs: T[], round: number): T[] {
  const out = [...xs];
  let seed = 11 + round * 37;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface ContributeBody {
  accepted: { resource: string; amount: number }[];
  stagesCompleted: string[];
  projectCompleted: boolean;
}

describe.skipIf(!url)('real PostgreSQL: community projects race safely', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let contribute: ReturnType<typeof contributeCall>;

  beforeAll(async () => {
    database = await createPostgresTestDatabase(url!, { poolMax: N * 3 + 2 });
    app = buildApp({ database, activity: { ...DEFAULT_ACTIVITY_OPTIONS } });
    await app.ready();
    contribute = contributeCall(app);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const db = () => database.db;

  async function resetWorld() {
    await db().delete(communityContributions);
    await db().delete(communityProjectProgress);
    await db().delete(communityProjects);
    await db().delete(worldFlags);
    app.worldState.invalidate();
  }

  /** Puts the warehouse at `stageIndex` with `delivered` on that stage. */
  async function seedStage(stageIndex: number, stageId: string, delivered: Record<string, number>) {
    await db()
      .insert(communityProjects)
      .values({ projectId: WAREHOUSE.id, stageIndex, updatedAt: new Date() });
    for (const [resource, amount] of Object.entries(delivered)) {
      await db()
        .insert(communityProjectProgress)
        .values({ projectId: WAREHOUSE.id, stageId, resource, amount });
    }
  }

  const goldOf = async (heroIds: string[]) =>
    new Map(
      (
        await db()
          .select({ id: characters.id, gold: characters.gold })
          .from(characters)
          .where(inArray(characters.id, heroIds))
      ).map((r) => [r.id, r.gold]),
    );

  const delivered = async (stageId: string) =>
    Object.fromEntries(
      (
        await db()
          .select()
          .from(communityProjectProgress)
          .where(sql`project_id = ${WAREHOUSE.id} and stage_id = ${stageId}`)
      ).map((r) => [r.resource, r.amount]),
    );

  const auditedGold = async (heroIds: string[], stageId: string) =>
    (
      await db()
        .select({ characterId: auditLog.characterId, data: auditLog.data })
        .from(auditLog)
        .where(
          sql`event = 'community.contribute' and data->>'stageId' = ${stageId} and character_id in ${heroIds}`,
        )
    ).reduce(
      (m, r) => m.set(r.characterId!, (m.get(r.characterId!) ?? 0) + Number(r.data.gold)),
      new Map<string, number>(),
    );

  it('contributions racing at the stage boundary: no over-fill, nothing lost, one completion', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      await resetWorld();
      // 1,000 gold and 100 timber left; eight patrons each offer their full cap (800 / 80).
      await seedStage(0, RUBBLE.id, { gold: 3_000, timber: 300 });
      const patrons = await Promise.all(Array.from({ length: N }, () => insertPatron(db(), START)));
      const results = await Promise.all(
        shuffled(patrons, round).map((p) =>
          contribute(p, WAREHOUSE.id, RUBBLE.id, { gold: 800, timber: 80 }).then((r) => ({ p, r })),
        ),
      );
      const statuses = results.map(({ r }) =>
        r.statusCode === 200
          ? 200
          : `${r.statusCode} ${r.json<{ error: { code: string } }>().error.code}`,
      );
      for (const s of statuses) expect([200, '409 stage_changed']).toContain(s);
      const ok = results.filter(({ r }) => r.statusCode === 200);
      const bodies = ok.map(({ r }) => r.json<ContributeBody>());
      expect(bodies.filter((b) => b.stagesCompleted.includes('clearRubble'))).toHaveLength(1);
      // No over-fill.
      expect(await delivered(RUBBLE.id)).toEqual({ gold: 4_000, timber: 400 });
      // No lost contribution: paid = accepted = audited, and the accepted amounts sum to the gap.
      const heroIds = patrons.map((p) => p.heroId);
      const gold = await goldOf(heroIds);
      const audited = await auditedGold(heroIds, RUBBLE.id);
      let acceptedGold = 0;
      let acceptedTimber = 0;
      for (const { p, r } of results) {
        const body = r.statusCode === 200 ? r.json<ContributeBody>() : null;
        const g = body?.accepted.find((a) => a.resource === 'gold')?.amount ?? 0;
        acceptedGold += g;
        acceptedTimber += body?.accepted.find((a) => a.resource === 'timber')?.amount ?? 0;
        expect(START_GOLD - gold.get(p.heroId)!).toBe(g);
        expect(audited.get(p.heroId) ?? 0).toBe(g);
      }
      expect([acceptedGold, acceptedTimber]).toEqual([1_000, 100]);
      const [row] = await db()
        .select()
        .from(communityProjects)
        .where(eq(communityProjects.projectId, WAREHOUSE.id));
      expect(row!.stageIndex).toBe(1);
      const stageAudits = await db()
        .select()
        .from(auditLog)
        .where(sql`event = 'community.stage_complete' and data->>'stageId' = ${RUBBLE.id}`);
      expect(stageAudits).toHaveLength(round + 1);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('one account racing from several heroes gives exactly its cap', async () => {
    const retries = transactionStats.retries;
    const cap = stageCap(RUBBLE, 'gold');
    for (let round = 0; round < ROUNDS; round++) {
      await resetWorld();
      const first = await insertPatron(db(), START);
      const heroes: Patron[] = [first];
      for (let i = 1; i < 4; i++) {
        const h = await insertCharacter(db(), first.who.id, { level: 15 });
        await fund(db(), h.id, START);
        heroes.push({ who: first.who, heroId: h.id });
      }
      const jobs = shuffled(
        [...heroes, ...heroes].map(
          (p) => () => contribute(p, WAREHOUSE.id, RUBBLE.id, { gold: 300 }),
        ),
        round,
      );
      const results = await Promise.all(jobs.map((j) => j()));
      for (const r of results) {
        expect([200, 409]).toContain(r.statusCode);
        if (r.statusCode === 409)
          expect(r.json<{ error: { code: string } }>().error.code).toBe('contribution_capped');
      }
      const [given] = await db()
        .select({ n: sql<number>`sum(amount)::int` })
        .from(communityContributions)
        .where(sql`account_id = ${first.who.id} and resource = 'gold'`);
      expect(given!.n).toBe(cap);
      const gold = await goldOf(heroes.map((h) => h.heroId));
      expect([...gold.values()].reduce((s, g) => s + (START_GOLD - g), 0)).toBe(cap);
      expect((await delivered(RUBBLE.id)).gold).toBe(cap);
    }
    expect(transactionStats.retries).toBe(retries);
  });

  it('the last stage racing: exactly one completion, one flag, one award per contributor', async () => {
    const retries = transactionStats.retries;
    for (let round = 0; round < ROUNDS; round++) {
      await resetWorld();
      // 2,400 gold and 50 iron ore left (one patron's cap each); eight patrons race for it.
      await seedStage(2, DOORS.id, { gold: 9_600, ironOre: 200 });
      const patrons = await Promise.all(Array.from({ length: N }, () => insertPatron(db(), START)));
      const results = await Promise.all(
        shuffled(patrons, round).map((p) =>
          contribute(p, WAREHOUSE.id, DOORS.id, { gold: 700, ironOre: 15 }).then((r) => ({ p, r })),
        ),
      );
      const ok = results.filter(({ r }) => r.statusCode === 200);
      for (const { r } of results) {
        if (r.statusCode !== 200) {
          expect(r.statusCode).toBe(409);
          expect(['project_complete', 'stage_changed']).toContain(
            r.json<{ error: { code: string } }>().error.code,
          );
        }
      }
      expect(ok.filter(({ r }) => r.json<ContributeBody>().projectCompleted)).toHaveLength(1);
      expect(await delivered(DOORS.id)).toEqual({ gold: 12_000, ironOre: 250 });
      expect(await db().select().from(worldFlags)).toHaveLength(1);
      expect((await app.worldState.flags()).warehouseRestored).toBe(true);
      const [row] = await db()
        .select()
        .from(communityProjects)
        .where(eq(communityProjects.projectId, WAREHOUSE.id));
      expect(row!.completedAt).not.toBeNull();
      // Every account that gave something has the achievement exactly once (primary key), and
      // only the contributors have it.
      const contributors = new Set(ok.map(({ p }) => p.who.id));
      const awards = await db()
        .select({ accountId: accountAchievements.accountId })
        .from(accountAchievements)
        .where(
          sql`achievement_id = 'warehouseRestorer' and account_id in ${patrons.map((p) => p.who.id)}`,
        );
      expect(awards.map((a) => a.accountId).sort()).toEqual([...contributors].sort());
      const gold = await goldOf(patrons.map((p) => p.heroId));
      const paid = [...gold.values()].reduce((s, g) => s + (START_GOLD - g), 0);
      expect(paid).toBe(2_400);
    }
    const completions = await db()
      .select()
      .from(auditLog)
      .where(sql`event = 'community.project_complete'`);
    expect(completions).toHaveLength(ROUNDS);
    expect((await reconcileWithAudit(db())).filter((c) => !c.ok)).toEqual([]);
    expect(transactionStats.retries).toBe(retries);
  });
});
