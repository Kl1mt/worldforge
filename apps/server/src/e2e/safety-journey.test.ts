/**
 * The Phase 4 safety step of the journey (ticket 4.1, `journey.ts` `playSafetyStep`) on its own:
 * a fresh hero reports a player, a moderator acts, the offender renames. Fast (no farming); 4.11
 * runs it inside the Phase 4 exit run with several players.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playSafetyStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-06T12:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({ database, auth: { now: () => new Date(nowMs) } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: report → moderator action (Phase 4 safety)', () => {
  it('a report is handled by a moderator and the offender renames', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'pilgrim@graumark.test',
      displayName: 'Pilgrim',
      name: 'Hedda',
    });
    await playSafetyStep(app, database, hero);
  });
});
