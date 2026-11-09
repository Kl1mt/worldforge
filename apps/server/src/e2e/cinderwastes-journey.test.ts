/**
 * The Phase 6 Cinderwastes step of the journey (ticket 6.1, `journey.ts` `playCinderwastesStep`)
 * on its own. Reaching level 28 by play takes the 4.8 journey's ~200 hours, so the setup is
 * seeded like 5.8's browser seed: the hero is made through the API, then set to level 28 with the
 * Gravewarden and crypt tier III behind it and a Legendary +10 kit of the Pass's item level (27)
 * worn; the owner completes the town's projects with the CLI. Everything after that is played
 * through the API: the Watch until the Ashen Warden falls, then the Verge.
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
import { HOUR, playCinderwastesStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-09T08:00:00Z');
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

describe('journey: the Ashfall Verge opens past the Ashen Warden (Phase 6)', () => {
  it('closed until the Warden falls, then farmed in the Pass’s gear', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'cinderwalker@graumark.test',
      displayName: 'Cinderwalker',
      name: 'Hale',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 28,
        experience: 0,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3 },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 27, 'legendary', 'cinder-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    hero.state.level = 28;
    for (const project of ['restoreWarehouse', 'clearAshenPass'] as const) {
      expect(await completeProject(db, project, now())).toMatch(/completed|already complete/);
    }
    app.worldState.invalidate();

    const out = await playCinderwastesStep(app, database, hero, now);
    expect(out.watchRuns).toBeGreaterThanOrEqual(1);
    expect(out.pveProgress).toBeGreaterThanOrEqual(11);
    console.info(JSON.stringify({ cinderwastes: out }));
  }, 180_000);
});
