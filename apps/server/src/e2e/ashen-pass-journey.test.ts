/**
 * The Phase 4 Ashen Pass step of the journey (ticket 4.8, `journey.ts` `playAshenPassStep`) on its
 * own: the Phase 2 hero plays on in the Sunken Abbey to level 24, finds the pass sealed, the owner
 * finishes the town's projects with the CLI, and the hero farms the pass. 4.11 runs it inside the
 * Phase 4 exit run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { HOUR, playAshenPassStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-07T08:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
/** Safety net: level 17 at ~33–38 h (B.1), 24 about 40 Abbey hours later. */
const MAX_HOURS = 160;

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
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

describe('journey: the Ashen Pass opens with the town (Phase 4)', () => {
  it('sealed for a level-24 Gravewarden-slayer, opened by the projects, then farmed', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'ashwalker@graumark.test',
      displayName: 'Ashwalker',
      name: 'Brannoc',
    });
    expect(await hero.playPhase2(MAX_HOURS)).toBe(true);
    // Play on in the Abbey (the highest open area) until the pass's level.
    while (hero.state.level < 24 && hero.state.farmedHours < MAX_HOURS) {
      await hero.settle();
      await hero.equipBetterDrops();
      await hero.sellJunk(await hero.inventory());
      await hero.farmBestArea();
    }
    expect(hero.state.level).toBeGreaterThanOrEqual(24);
    const out = await playAshenPassStep(app, database, hero, new Date(nowMs));
    expect(out.passContract).toMatch(/^slay\./);
    console.info(JSON.stringify({ ashenPass: { ...out, hours: hero.state.farmedHours } }));
  }, 180_000);
});
