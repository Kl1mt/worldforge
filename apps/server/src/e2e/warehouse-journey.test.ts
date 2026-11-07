/**
 * The Phase 4 warehouse step of the journey (ticket 4.7, `journey.ts` `playWarehouseStep`) on its
 * own: closed until the town restores it (the owner CLI here; 4.11 uses contributions), then a
 * fresh hero stores, upgrades and takes back.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playWarehouseStep, startJourney } from './journey.js';

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

describe('journey: the Graumark Warehouse (Phase 4)', () => {
  it('closed, then restored: the hero stores, upgrades and takes back', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'keeper@graumark.test',
      displayName: 'Keeper',
      name: 'Hesper',
    });
    await playWarehouseStep(app, database, hero, () => new Date(nowMs));
  }, 120_000);
});
