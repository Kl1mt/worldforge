/**
 * The Phase 5 duel step of the journey (ticket 5.5, `journey.ts` `playDuelStep`) on its own: two
 * players become friends, duel as friends at once, farm to level 10, set their defences, and fight
 * a rated duel from the server's list, replayed by its key, without changing anything they own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playDuelStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-09T12:00:00Z');
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

describe('journey: duels (Phase 5)', () => {
  it('two players duel as friends, then rated from the server list, owning the same', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'duellist@graumark.test',
      displayName: 'Duellist Of Graumark',
      name: 'Brannoc',
    });
    const rival = await startJourney({
      app,
      clock,
      classId: 'mage',
      email: 'rival@graumark.test',
      displayName: 'Rival Of Graumark',
      name: 'Ysolde',
    });
    const out = await playDuelStep(database, hero, rival, clock);
    expect(out.friendlyDuel.kind).toBe('friendly');
    expect(out.rated.kind).toBe('rated');
  }, 240_000);
});
