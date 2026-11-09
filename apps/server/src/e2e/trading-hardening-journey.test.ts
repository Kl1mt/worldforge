/**
 * Ticket T.7 (trading hardening): the journey with three players trading (`journey.ts`
 * `playTradingHardeningStep`), the switches turned on and off through the admin route: swaps and
 * a gift, the 72-hour hold refusing spends and then letting them through, a moderator's reversal
 * from a reported trade, a switch turned off voiding an open offer, a trade restriction from the
 * queue voiding the restricted player's offer (their shelf still works), and the shelf moving a
 * received item and gold to a second hero. Every hero's holdings and every shelf equal the audit
 * log; the rollups reconcile. The clock is injected and only ever moved, never waited on.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { playTradingHardeningStep, startJourney } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-09T12:00:00Z');
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

describe('journey: trading hardening (T.7)', () => {
  it('three players trade under every switch; holdings, shelves and telemetry = audit', async () => {
    const start = (classId: 'warrior' | 'mage' | 'hunter', who: string, name: string) =>
      startJourney({
        app,
        clock,
        classId,
        email: `${who.toLowerCase()}@hardening.test`,
        displayName: `${name} ${who}`,
        name,
      });
    const a = await start('warrior', 'Ashdown', 'Aldric');
    const b = await start('mage', 'Brackwater', 'Berit');
    const c = await start('hunter', 'Coldmere', 'Cael');
    for (const j of [a, b, c]) await j.farmBestArea();
    await playTradingHardeningStep(app, database, clock, a, b, c);
  }, 180_000);
});
