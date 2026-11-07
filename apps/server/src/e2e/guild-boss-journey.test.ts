/**
 * The Phase 4 guild boss step of the journey (ticket 4.9, `journey.ts` `playGuildBossStep`) on its
 * own, after the guild step: the week's attempts, a replayed retry, the refused fourth, the board,
 * a hero too green to fight, a former recruit without a guild, and the Monday reset. 4.11 runs it
 * inside the Phase 4 exit run.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playGuildBossStep, playGuildStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-04T12:00:00Z');
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

describe('journey: the weekly guild boss (Phase 4)', () => {
  it('the hero spends the week on the guild boss and the week turns', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'bossfighter@graumark.test',
      displayName: 'Boss Fighter',
      name: 'Ragna',
    });
    const guild = await playGuildStep(app, database, hero);
    await playGuildBossStep(database, hero, clock, guild);
  }, 180_000);
});
