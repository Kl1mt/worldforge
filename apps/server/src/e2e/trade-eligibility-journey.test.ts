/**
 * The trade eligibility step of the journey (ticket T.4, `journey.ts` `playTradeEligibilityStep`)
 * on its own: a fresh hero farms a little, sees where they stand for trading while it is closed,
 * verifies the email, makes a friend and asks whether they could trade, and a moderator restricts
 * and lifts the hero's trading. The clock starts at the real time (accounts' creation times come
 * from the database) and is moved forward, never waited on.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { createTestDatabase } from '../test/db.js';
import { playTradeEligibilityStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.now();
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const mailer = createMemoryMailer();

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
  app = buildApp({
    database,
    auth: { now, mailer, publicBaseUrl: 'https://play.example.test' },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: trade eligibility (T.4)', () => {
  it('closed trading, your standing, a friend, a trade restriction and its lifting', async () => {
    const email = 'would-be-trader@example.test';
    const hero = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email,
      displayName: 'Tamsin Coldbrook',
      name: 'Tamsin',
    });
    await hero.farmBestArea();
    await hero.settle();
    await playTradeEligibilityStep(app, database, mailer, clock, hero, email);
  }, 60_000);
});
