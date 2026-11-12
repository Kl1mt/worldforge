/**
 * The Phase 8 Hollow Deep step of the journey (ticket 8.2, `journey.ts` `playHollowDeepStep`) on its
 * own. Reaching level 50 by play takes far too long for a test, so the setup is seeded like 8.1's
 * step: the hero is made through the API, then set to level 50 with the Forge Tyrant behind it and
 * the best Marches gear worn (tier-5 Legendaries +10, item level 47); the owner completes the
 * town's first three projects with the CLI. Everything after that is played through the API: the
 * Deep and the Throne refused, the hero's share to the lanterns, the owner's stage command, the
 * Deep farmed, the Throne until the Sovereign falls, the crown shard's recipe, the boards.
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
import { HOUR, playHollowDeepStep, startJourney } from './journey.js';

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

describe('journey: the Hollow Deep and the Hollow Sovereign (Phase 8)', () => {
  it('locked until the lanterns are lit; then farmed and the Sovereign fought in Marches gear', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'deepdelver@graumark.test',
      displayName: 'Deepdelver',
      name: 'Lantern',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 50,
        experience: 0,
        gold: 20_000,
        progress: {
          gravewardenDefeated: true,
          cryptTierCleared: 4,
          ashenWardenDefeated: true,
          forgeTyrantDefeated: true,
        },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 47, 'legendary', 'deep-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    hero.state.level = 50;
    for (const project of ['restoreWarehouse', 'clearAshenPass', 'forgewardOutpost'] as const) {
      expect(await completeProject(db, project, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();

    const out = await playHollowDeepStep(app, database, hero, now);
    expect(out.throneRuns).toBeGreaterThanOrEqual(1);
    expect(out.kills).toBeGreaterThan(0);
    expect(out.deaths).toBeLessThanOrEqual(3);
    expect(out.era).toBe('lanternVigil');
    console.info(JSON.stringify({ hollowDeep: out }));
  }, 240_000);
});
