/**
 * The Phase 6 event step of the journey (ticket 6.6, `journey.ts` `playEventStep`) on its own: the
 * owner schedules the Harvest of Bones in the admin panel, a fresh hero joins in the Tavern, farms
 * the Fields until its first task is done and the first reward tier is granted once; the owner ends
 * the event early and nothing earned is lost. Ticket 6.8: the keepsake is then equipped from the
 * collection book (`playCollectionStep`). Ticket 6.11: Seals and Abbey silver spent at the Forge's
 * exchange and engraver (`playSealSinkStep`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playCollectionStep, playEventStep, playSealSinkStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// Derived from the wall clock (CLAUDE.md "Dates"): a minute boundary a week ahead.
let nowMs = Math.floor((Date.now() + 7 * 86_400_000) / 60_000) * 60_000;
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

describe('journey: a rotating event (Phase 6)', () => {
  it('scheduled, joined, a reward tier earned once, ended early with nothing lost', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'reaper@graumark.test',
      displayName: 'Stubble Reaper',
      name: 'Hadwin',
    });
    const out = await playEventStep(app, database, hero, clock);
    expect(out.event).toBe(1);
    expect(out.tallies).toBeGreaterThanOrEqual(10);
    // Ticket 6.8: the keepsake in the collection book, equipped.
    const book = await playCollectionStep(hero);
    expect(book.owned).toContain('banner.harvest-sheaf');
    // Ticket 6.11: the exchange and the engraver.
    const sinks = await playSealSinkStep(database, hero);
    expect(sinks.engraving).toBe('silver:oathworn');
  }, 120_000);
});
