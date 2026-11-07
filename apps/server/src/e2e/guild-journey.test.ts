/**
 * The Phase 4 guild step of the journey (ticket 4.4, `journey.ts` `playGuildStep`) on its own: a
 * fresh hero farms the founding gold, founds a guild, takes in a companion and a recruit, names an
 * officer, and a stranger reports the guild. 4.11 runs it inside the Phase 4 exit run.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playGuildStep, startJourney } from './journey.js';

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

describe('journey: founding and running a guild (Phase 4)', () => {
  it('the hero founds a guild, takes in companions and is reported', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'founder@graumark.test',
      displayName: 'Founder',
      name: 'Hedda',
    });
    await playGuildStep(app, database, hero);
  }, 120_000);
});
