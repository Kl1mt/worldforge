/**
 * Ticket 8.5: the quality-of-life step of the journey on its own (`journey.ts`
 * `playQualityOfLifeStep`): several Tavern rewards claimed at once (replayed, paid once), a
 * loot-filter preset kept, shared as a code and used, and the inbox read; nothing reaches a score;
 * reconciled with the audit log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playQualityOfLifeStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// Derived from the wall clock (CLAUDE.md "Dates"): a minute boundary a day ahead.
let nowMs = Math.floor((Date.now() + 86_400_000) / 60_000) * 60_000;
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

describe('journey: quality of life (Phase 8)', () => {
  it('claims Tavern rewards at once, shares a filter preset, reads the inbox', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'comfort@graumark.test',
      displayName: 'Comfort Seeker',
      name: 'Wenna',
    });
    const out = await playQualityOfLifeStep(database, hero);
    expect(out.claimed).toBeGreaterThan(0);
  }, 300_000);
});
