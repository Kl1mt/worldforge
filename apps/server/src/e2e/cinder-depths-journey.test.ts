/**
 * The Phase 6 Cinder Depths step of the journey (ticket 6.2, `journey.ts` `playCinderDepthsStep`)
 * on its own. Reaching level 36 by play takes far too long for a test, so the setup is seeded like
 * 6.1's step: the hero is made through the API, then set to level 36 with the Ashen Warden behind
 * it and good Verge gear worn (Legendaries +10 at the Verge's item level 33); the owner completes
 * the town's projects with the CLI. Everything after that is played through the API: the Depths,
 * the Tyrant's Forge until the Forge Tyrant falls, his ember's recipe, the boards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { completeProject } from '../community/project-cli.js';
import { characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { giveMaterials } from '../test/trading.js';
import { HOUR, playCinderDepthsStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-10T08:00:00Z');
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

describe('journey: the Cinder Depths and the Forge Tyrant (Phase 6)', () => {
  it('farmed in good Verge gear; the Tyrant falls, his hoard is bound, his ember is spent', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'slagwalker@graumark.test',
      displayName: 'Slagwalker',
      name: 'Brand',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 36,
        experience: 0,
        gold: 5_000,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 33, 'legendary', 'depths-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    // The recipe's ore and shards (a Verge farmer has them); the ember must come from the Tyrant.
    await giveMaterials(db, hero.characterId, { ironOre: 60, soulShard: 12 });
    hero.state.level = 36;
    for (const project of ['restoreWarehouse', 'clearAshenPass'] as const) {
      expect(await completeProject(db, project, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();

    const out = await playCinderDepthsStep(app, database, hero, now);
    expect(out.runs).toBeGreaterThanOrEqual(1);
    expect(out.crafted).toBe(true);
    expect(out.pveProgress).toBeGreaterThanOrEqual(15);
    console.info(JSON.stringify({ cinderDepths: out }));
  }, 180_000);
});
