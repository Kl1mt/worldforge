/**
 * The Phase 8 Hollow Reach step of the journey (ticket 8.1, `journey.ts` `playHollowReachStep`) on
 * its own. Reaching level 40 by play takes far too long for a test, so the setup is seeded like
 * 6.2's step: the hero is made through the API, then set to level 40 with the Ashen Warden behind
 * it (the Forge Tyrant still standing) and today's best gear worn (the Depths' Legendaries +10, item
 * level 39); the owner completes the town's projects with the CLI. Everything after that is played
 * through the API: the Pale Marches refused, the Tyrant's Forge until he falls, the Marches farmed,
 * the merchant, the boards.
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
import { HOUR, playHollowReachStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// The injected clock starts at the wall clock (CLAUDE.md "Dates"), on a whole hour.
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

describe('journey: the Hollow Reach, the Pale Marches (Phase 8)', () => {
  it('locked until the Forge Tyrant falls; then farmed in Depths gear for tier-5 drops', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'hollowwalker@graumark.test',
      displayName: 'Hollowwalker',
      name: 'Pale',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 40,
        experience: 0,
        gold: 5_000,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 39, 'legendary', 'marches-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    hero.state.level = 40;
    for (const project of ['restoreWarehouse', 'clearAshenPass'] as const) {
      expect(await completeProject(db, project, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();

    const out = await playHollowReachStep(app, database, hero, now);
    expect(out.tyrantRuns).toBeGreaterThanOrEqual(1);
    expect(out.kills).toBeGreaterThan(0);
    expect(out.deaths).toBeLessThanOrEqual(3);
    expect(out.pveProgress).toBeGreaterThanOrEqual(18);
    console.info(JSON.stringify({ hollowReach: out }));
  }, 180_000);
});
