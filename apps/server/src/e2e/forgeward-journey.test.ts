/**
 * The Phase 6 world progression step of the journey (ticket 6.7, `journey.ts`
 * `playForgewardStep`) on its own: in the Rekindling a fresh hero gives its share to the Forgeward
 * Outpost, the owner's test-setup command finishes the chain, the era moves to the Forgeward Age
 * and the hero's account earns the mark.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playForgewardStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
// Derived from the wall clock (CLAUDE.md "Dates"): a minute boundary a week ahead.
let nowMs = Math.floor((Date.now() + 7 * 86_400_000) / 60_000) * 60_000;
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
  app = buildApp({ database, auth: { now }, activity: { ...DEFAULT_ACTIVITY_OPTIONS, now } });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: the Forgeward Outpost and the eras (Phase 6)', () => {
  it('gives to the slag road in the Rekindling; the chain finishes and the Forgeward Age begins', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'outrider@graumark.test',
      displayName: 'Outrider',
      name: 'Brannoc',
    });
    const out = await playForgewardStep(app, database, hero, () => new Date(nowMs));
    expect(out.era).toBe('forgewardAge');
    expect(out.gave).toBeGreaterThanOrEqual(100);
  }, 120_000);
});
