/**
 * The Phase 4 friends step of the journey (ticket 4.3, `journey.ts` `playFriendsStep`) on its own:
 * a fresh hero befriends a companion, sees their presence and blocks a pest. Fast (no farming); 4.11
 * runs it inside the Phase 4 exit run with several players.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playFriendsStep, startJourney } from './journey.js';

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

describe('journey: friends, presence and block (Phase 4)', () => {
  it('the hero befriends a companion and blocks a pest', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'pilgrim@graumark.test',
      displayName: 'Pilgrim',
      name: 'Hedda',
    });
    await playFriendsStep(app, database, hero);
  });
});
