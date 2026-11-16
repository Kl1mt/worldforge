/**
 * The Phase 9 skill quests step of the journey (ticket 9.3, `journey.ts` `playSkillQuestStep`) on
 * its own. Reaching level 38 by play takes far too long for a test, so the hero is seeded like the
 * Phase 6 heroes (6.10): made through the API, then set to level 38 with the Ashen Warden and crypt
 * tier III behind it, in Legendaries 33 +10 (the Tyrant job's kit, docs/SKILLS.md), measured as a
 * holdings baseline. Everything after that is played through the API.
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
import { HOUR, holdingsBaseline, playSkillQuestStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// The injected clock starts at the wall clock (CLAUDE.md "Dates"), on a whole hour.
let nowMs = Math.floor(Date.now() / HOUR) * HOUR;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const now = () => new Date(nowMs);

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { now }, activity: { ...DEFAULT_ACTIVITY_OPTIONS, now } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: skill quests (Phase 9)', () => {
  it('the Tyrant’s Lesson: a fresh Tyrant kill and two Seals teach the Tyrant’s skill', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'lessons@graumark.test',
      displayName: 'Lessoned',
      name: 'Ansgarin',
    });
    const db = database.db;
    await db
      .update(characters)
      .set({
        level: 38,
        experience: 0,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      })
      .where(eq(characters.id, hero.characterId));
    await equipKit(db, hero.characterId, 'warrior', 33, 'legendary', 'lessons-journey');
    await db
      .update(itemInstances)
      .set({ upgradeLevel: 10 })
      .where(
        and(eq(itemInstances.characterId, hero.characterId), isNotNull(itemInstances.equippedSlot)),
      );
    hero.state.level = 38;
    const baseline = await holdingsBaseline(database, hero.characterId);
    const out = await playSkillQuestStep(database, hero, baseline, clock);
    expect(out.skill).toBe('forgebreaker');
    expect(out.forgeRuns).toBeGreaterThanOrEqual(1);
    console.info(JSON.stringify({ skillQuests: out }));
  }, 240_000);
});
