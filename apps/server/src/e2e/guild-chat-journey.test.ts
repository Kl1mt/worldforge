/**
 * The Phase 4 guild chat step of the journey (ticket 4.5, `journey.ts` `playGuildChatStep`) on
 * its own, after the guild step: a notice, posts, a poll and a `304`, a line struck from the
 * record, a report, and a former member without access. 4.11 runs it inside the Phase 4 exit run.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playGuildChatStep, playGuildStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-07T12:00:00Z');
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

describe('journey: guild chat (Phase 4)', () => {
  it('the guild talks, pins a notice, strikes a line and reports one', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'mage',
      email: 'chatter@graumark.test',
      displayName: 'Chatter',
      name: 'Ilse',
    });
    const guild = await playGuildStep(app, database, hero);
    await playGuildChatStep(database, hero, guild);
  }, 120_000);
});
