/**
 * The trade step of the journey (ticket T.5, `journey.ts` `playTradeStep`) on its own: two heroes
 * farm, become friends, wait out the account age and the friendship's 7 days (the clock moves, it
 * is never waited on), and trade with the switches turned on in the test: a gift accepted and
 * held, an offer declined, one cancelled, the hold released once. Holdings of both heroes equal
 * the audit log; the rollups reconcile.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playTradeStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.now();
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

describe('journey: trade offers (T.5)', () => {
  it('two players trade: a gift held and released, a decline, a cancel; holdings = audit', async () => {
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email: 'trader-one@example.test',
      displayName: 'Oswin Hale',
      name: 'Oswin',
    });
    const friend = await startJourney({
      app,
      clock,
      classId: 'mage',
      email: 'trader-two@example.test',
      displayName: 'Brisa Vell',
      name: 'Brisa',
    });
    await hero.farmBestArea();
    await hero.settle();
    await friend.farmBestArea();
    await friend.settle();
    await playTradeStep(app, database, clock, hero, friend);
  }, 120_000);
});
