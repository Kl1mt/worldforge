/**
 * The account shelf step of the journey (ticket T.3, `journey.ts` `playShelfStep`) on its own: the
 * Warehouse opens (4.7's step), the shelf starts off, the owner opens it in the admin panel, and
 * one hero gives an item, gold and materials to a second hero of the same account.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playShelfStep, playWarehouseStep, startJourney } from './journey.js';

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

describe('journey: the account shelf (T.3)', () => {
  it('off by default, then opened: one hero gives to the other, holdings match the audit', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'shelver@graumark.test',
      displayName: 'Shelver',
      name: 'Odrin',
    });
    await playWarehouseStep(app, database, hero, () => new Date(nowMs));
    await playShelfStep(app, database, hero);
  }, 180_000);
});
