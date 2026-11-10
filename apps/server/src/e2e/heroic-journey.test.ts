/**
 * The Phase 6 Heroic step of the journey (ticket 6.3, `journey.ts` `playHeroicStep`) on its own.
 * Reaching level 34 with tier III cleared by play takes far too long for a test, so the setup is
 * seeded like 6.2's step: the hero is made through the API, then set to level 34 with the crypt's
 * tier III and the Ashen Warden behind it, wearing the Depths' top Legendaries +10 (item level 39).
 * Everything after that is played through the API: the Tavern's notice, the Heroic crypt until
 * the Gravewarden falls, a run across Monday 00:00, the boards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { equipKit } from '../test/arena.js';
import { HOUR, playHeroicStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-12T08:00:00Z');
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

describe('journey: the Heroic crypt and the weekly boss modifier (Phase 6)', () => {
  it('announced, entered at level 34, cleared, and a run across Monday keeps its week', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'gravebell@graumark.test',
      displayName: 'Gravebell',
      name: 'Tolla',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 34,
        experience: 0,
        gold: 5_000,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'hunter', 39, 'legendary', 'heroic-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    hero.state.level = 34;

    const out = await playHeroicStep(app, database, hero, clock, now);
    expect(out.runs).toBeGreaterThanOrEqual(2);
    expect(out.modifiers).toHaveLength(out.runs);
    console.info(JSON.stringify({ heroic: out }));
  }, 180_000);
});
