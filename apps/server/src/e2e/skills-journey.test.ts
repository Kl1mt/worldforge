/**
 * The Phase 9 skills step of the journey (ticket 9.2, `journey.ts` `playSkillsStep`) on its own:
 * a fresh hero reaches its first spender, saves and fights with a loadout, keeps presets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playSkillsStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// Derived from the wall clock (CLAUDE.md "Dates"): noon UTC today.
let nowMs = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 43_200_000;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
  app = buildApp({ database, auth: { now }, activity: { ...DEFAULT_ACTIVITY_OPTIONS, now } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: skills and loadouts (Phase 9)', () => {
  for (const classId of ['warrior', 'warlock'] as const) {
    it(`${classId}: the first spender, a saved loadout, presets`, async () => {
      const hero = await startJourney({
        app,
        clock,
        classId,
        email: `skills-${classId}@graumark.test`,
        displayName: `Skiller ${classId === 'warrior' ? 'Ash' : 'Bry'}`,
        name: classId === 'warrior' ? 'Tamsin' : 'Orrel',
      });
      const r = await playSkillsStep(database, hero);
      expect(r.level).toBeGreaterThanOrEqual(5);
    }, 120_000);
  }
});
