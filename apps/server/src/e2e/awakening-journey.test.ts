/**
 * The Phase 6 Item Awakening step of the journey (ticket 6.5b) on its own. The setup is seeded
 * like 6.4's Prismatic step: the hero is made through the API, then set to level 38 with the Ashen
 * Warden behind it, wearing the Depths' top Legendaries +10.
 *
 * The Tyrant's Ember comes from a real Tyrant's Forge run: the boss can lose, so the run's server
 * seed is pinned (CLAUDE.md "Writing tests that don't flake") to one game-core's own replay shows
 * winning with the hoard. The other two Embers and the Seals are stocked directly (three boss
 * days are not what this step is about). Everything else is played through the API: the Forge
 * quotes and awakens a worn weapon, the pack shows the mark, the hero's Power and boards stay
 * consistent, the arena defence carries the awakening into duels and into matchmaking's bracket
 * Power, and the item reads as never tradeable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import {
  BRACKET_POWER_VERSION,
  MATERIAL_IDS,
  bracketPower,
  duelFighter,
  findPvpBracket,
  type Scores,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  characterMaterials,
  characters,
  duelDefences,
  dungeonRuns,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { replayRun } from '../dungeon/routes.js';
import { checkLeaderboards } from '../leaderboards/check.js';
import { cliDeps } from '../leaderboards/leaderboard-cli.js';
import { HOUR, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// The clock is injected, derived from the wall clock (CLAUDE.md "Dates").
let nowMs = Math.floor(Date.now() / HOUR) * HOUR;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, offlineCapMs: 3 * HOUR, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface ViewItem {
  id: string;
  baseId: string;
  effectId: string | null;
  equippedSlot: string | null;
  binding: string;
  bindingReason: string;
  tradeable: boolean;
  awakening?: { option: string; effectStrength: number };
}

describe('journey: awakening an item (Phase 6, ticket 6.5b)', () => {
  it('earns an Ember at the Tyrant, awakens a worn weapon, and duels and boards see it', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'ember@graumark.test',
      displayName: 'Ember',
      name: 'Hralda',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 38,
        experience: 0,
        gold: 200_000,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 39, 'legendary', 'awakening-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    await db.delete(characterMaterials).where(eq(characterMaterials.characterId, hero.characterId));
    await db.insert(characterMaterials).values(
      MATERIAL_IDS.map((materialId) => ({
        characterId: hero.characterId,
        materialId,
        // Two Embers short of an awakening: the third comes from the Tyrant below.
        quantity: materialId === 'tyrantsEmber' ? 2 : materialId === 'gravewardenSeal' ? 2 : 1_000,
      })),
    );
    hero.state.level = 38;
    const { api, keyed, base } = hero;

    // The Tyrant's Forge, pinned to a seed that wins with the hoard (and its Ember).
    const start = await api('POST', `${base}/dungeon`, { dungeonId: 'tyrantsForge', tier: 1 });
    expect(start.statusCode, start.body).toBe(201);
    const [run] = await db
      .select()
      .from(dungeonRuns)
      .where(eq(dungeonRuns.characterId, hero.characterId))
      .orderBy(desc(dungeonRuns.startedAt))
      .limit(1);
    const pack = (await hero.inventory()).inventory.length;
    let secret: string | null = null;
    let endsAt = run!.endsAt.getTime();
    for (let i = 0; i < 200 && !secret; i++) {
      const candidate = `awakening-journey:${i}`;
      const r = replayRun({ ...run!, seedSecret: candidate }, pack, null);
      if (r.bossDefeated && (r.materials.tyrantsEmber ?? 0) >= 1) {
        secret = candidate;
        endsAt = run!.startedAt.getTime() + r.durationMs;
      }
    }
    expect(secret, 'a seed that beats the Tyrant').not.toBeNull();
    await db.update(dungeonRuns).set({ seedSecret: secret! }).where(eq(dungeonRuns.id, run!.id));
    clock.set(Math.max(endsAt, run!.endsAt.getTime()));
    expect((await api('POST', `${base}/dungeon/settle`)).statusCode).toBe(200);
    const claim = await keyed(`${base}/dungeon/claim`);
    expect(claim.statusCode, claim.body).toBe(200);
    const [ember] = await db
      .select()
      .from(characterMaterials)
      .where(
        and(
          eq(characterMaterials.characterId, hero.characterId),
          eq(characterMaterials.materialId, 'tyrantsEmber'),
        ),
      );
    expect(ember!.quantity).toBeGreaterThanOrEqual(3);

    // The Forge quotes the worn weapon, then awakens it.
    const inv = (await hero.inventory()) as unknown as { equipped: ViewItem[] };
    const weapon = inv.equipped.find((i) => i.equippedSlot === 'weapon' && i.effectId)!;
    expect(weapon).toBeDefined();
    const scores = async () =>
      (await api('GET', `${base}/scores`)).json<{ scores: Scores }>().scores;
    const before = await scores();
    const q = await api('GET', `${base}/forge/items/${weapon.id}`);
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json().forge.awaken).toMatchObject({ refusal: null, blockers: [] });
    const awake = await keyed(`${base}/forge/awaken`, { itemId: weapon.id });
    expect(awake.statusCode, awake.body).toBe(200);

    // The pack and the item view carry the mark; it is account-bound and never tradeable.
    const after = (await hero.inventory()) as unknown as { equipped: ViewItem[] };
    const shown = after.equipped.find((i) => i.id === weapon.id)!;
    expect(shown.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    expect(shown).toMatchObject({
      binding: 'account',
      bindingReason: 'awakened',
      tradeable: false,
    });

    // Power fights with the items (no new version): it can only stay or rise, and the boards
    // check finds every stored value recomputing to itself.
    const afterScores = await scores();
    expect(afterScores.power.value).toBeGreaterThanOrEqual(before.power.value);
    // Gear Score doesn't read awakening (docs/LEADERBOARDS.md).
    expect(afterScores.gearScore.value).toBe(before.gearScore.value);
    const report = await checkLeaderboards(cliDeps(db), 200, now());
    expect(report.problems.filter((p) => p.kind === 'wrong')).toEqual([]);

    // The arena defence carries the awakening, and matchmaking's bracket Power 2 sees it.
    const def = await keyed('/api/arena/defence', { characterId: hero.characterId });
    expect(def.statusCode, def.body).toBe(200);
    const [defence] = await db
      .select()
      .from(duelDefences)
      .where(eq(duelDefences.characterId, hero.characterId));
    const stored = defence!.snapshot.equipment.find((e) => e.awakening);
    expect(stored?.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    expect(defence!.powerVersion).toBe(BRACKET_POWER_VERSION);
    const bracket = findPvpBracket(defence!.bracketId)!;
    const fighter = duelFighter(defence!.snapshot);
    expect(defence!.power).toBe(bracketPower(fighter, bracket, 2));
    expect(defence!.power).toBeGreaterThanOrEqual(bracketPower(fighter, bracket, 1));
  }, 180_000);
});
