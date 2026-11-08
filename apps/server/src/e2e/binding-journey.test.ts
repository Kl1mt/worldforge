/**
 * Ticket T.1 on its own: a hero plays the Phase 2 loop (farming, the Forge's town visits, the
 * crypt), then every item it holds is checked for its binding and provenance
 * (`journey.ts` `playBindingStep`).
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playBindingStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-08T12:00:00Z');
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

describe('journey: item binding (ticket T.1)', () => {
  it('after real play every item carries its binding and its provenance', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'binder@graumark.test',
      displayName: 'Binder',
      name: 'Ortwin',
    });
    await hero.playPhase2(40);
    await playBindingStep(database, hero);
  }, 240_000);
});
