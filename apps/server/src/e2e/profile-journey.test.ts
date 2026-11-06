/**
 * The Phase 4 profile step of the journey (ticket 4.2, `journey.ts` `playProfileStep`) on its
 * own: a fresh hero farms to level 10 (a live achievement), shows it on the profile, another
 * player views and reports from it, and a hidden profile becomes a 404.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playProfileStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-06T12:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now: () => new Date(nowMs) },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: achievements on a public profile (Phase 4)', () => {
  it('a level-up awards an achievement the player shows; others see only what was chosen', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'wayfarer@graumark.test',
      displayName: 'Wayfarer',
      name: 'Odila',
    });
    await playProfileStep(app, database, hero);
  }, 120_000);
});
