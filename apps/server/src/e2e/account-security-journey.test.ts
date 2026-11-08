/**
 * The account security step of the journey (ticket 5.7, `journey.ts` `playAccountSecurityStep`):
 * a fresh hero farms a little, verifies the email through the captured mail, logs out another
 * device, and resets the password through the mailed link, keeping every bit of progress.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createMemoryMailer } from '../mail/mailer.js';
import { createTestDatabase } from '../test/db.js';
import { playAccountSecurityStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-08T12:00:00Z');
const clock = { now: () => nowMs, set: (ms: number) => void (nowMs = ms) };
const mailer = createMemoryMailer();

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now: () => new Date(nowMs), mailer, publicBaseUrl: 'https://play.example.test' },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('journey: account security (Phase 5)', () => {
  it('register, verify through the mail, log out another device, reset the password', async () => {
    const email = 'keyholder@example.test';
    const hero = await startJourney({
      app,
      clock,
      classId: 'mage',
      email,
      displayName: 'Keyholder Ilse',
      name: 'Ilsemar',
    });
    await hero.farmBestArea();
    await hero.settle();
    await playAccountSecurityStep(app, mailer, hero, email);
  }, 60_000);
});
