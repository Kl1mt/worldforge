/**
 * The Phase 5 leaderboard step of the journey (ticket 5.2, `journey.ts` `playLeaderboardStep`) on
 * its own: a fresh hero farms to level 10, shows a public profile, and is ranked, seen and
 * reported on the boards; hidden, the name stays listed without a profile link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { newPlayer, playLeaderboardStep, playProfileStep, startJourney } from './journey.js';

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

describe('journey: leaderboards (Phase 5)', () => {
  it('the hero is ranked by its own scores, listed by name, and reportable from the board', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'ranked@graumark.test',
      displayName: 'Ranked Wayfarer',
      name: 'Hildrun',
    });
    // The profile step farms to level 10 and ends with the profile hidden.
    await playProfileStep(app, database, hero);
    const companion = await newPlayer(app, 'onlooker@graumark.test', 'Onlooker');
    const hidden = await playLeaderboardStep(app, database, hero, { companion });
    expect(hidden.visibility).toBe('hidden');
    expect(hidden.entry.player.profile).toBe(false);
  }, 120_000);
});
