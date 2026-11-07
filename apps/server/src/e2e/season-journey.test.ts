/**
 * The Phase 5 season step of the journey (ticket 5.3, `journey.ts` `playSeasonStep`) on its own:
 * the owner schedules a season in the admin panel, a fresh hero farms inside it and is ranked on
 * the season board, the season ends, the archive and awards are taken once, and the hero shows its
 * earned title and frame to another player.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { newPlayer, playSeasonStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-07T12:00:00Z');
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

describe('journey: seasons and prestige (Phase 5)', () => {
  it('a hero is ranked in a season, awarded at its end, and shows its title and frame', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'mage',
      email: 'seasoned@graumark.test',
      displayName: 'Seasoned Wayfarer',
      name: 'Ysolde',
    });
    const companion = await newPlayer(app, 'season-onlooker@graumark.test', 'Season Onlooker');
    const out = await playSeasonStep(app, database, hero, clock, { companion });
    // The only hero on the board: first place, the Champion tier.
    expect(out.rank).toBe(1);
    expect(out.tier).toBe('champion');
  }, 120_000);
});
