/**
 * The Phase 4 community step of the journey (ticket 4.6, `journey.ts` `playCommunityStep`) on its
 * own: a fresh hero farms gold and materials and gives its daily share to the Warehouse project.
 * 4.11 runs it inside the Phase 4 exit run, with several players finishing the project.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playCommunityStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-06T12:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
  app = buildApp({
    database,
    auth: { now },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: contributing to a community project (Phase 4)', () => {
  it('the hero gives its daily share to the Warehouse and is capped', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'patron@graumark.test',
      displayName: 'Patron',
      name: 'Ysolde',
    });
    await playCommunityStep(database, hero);
  }, 120_000);
});
