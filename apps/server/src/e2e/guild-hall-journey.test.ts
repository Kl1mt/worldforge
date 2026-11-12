/**
 * Ticket 8.4: the guild hall step of the journey on its own (`journey.ts` `playGuildHallStep`),
 * after founding a guild (`playGuildStep`): a gift to the treasury after the no-refund notice, an
 * upgrade bought and hung by the officer, shown to a stranger; no score moves; reconciled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playGuildHallStep, playGuildStep, startJourney } from './journey.js';

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

describe('journey: the guild hall (Phase 8)', () => {
  it('the guild funds the treasury and the officer buys and hangs a look', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'hallkeeper@graumark.test',
      displayName: 'Hall Keeper',
      name: 'Osric',
    });
    const guild = await playGuildStep(app, database, hero);
    const out = await playGuildHallStep(app, database, hero, guild);
    expect(out.colour).toBe('guild-colour.forge-gold');
  }, 300_000);
});
