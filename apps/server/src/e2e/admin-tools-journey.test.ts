/**
 * The admin tools step of the journey (ticket D.4, `journey.ts` `playAdminToolsStep`): two real
 * players farm; the admin marks one as a test account, grants it an item, gold and an hour of
 * farming, removes the item, deletes and restores the hero; the other refuses cheat tools.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertAccount } from '../test/social.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { playAdminToolsStep, startJourney, type Player } from './journey.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-10T09:00:00Z');
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

describe('journey: admin tools (D.4)', () => {
  it('test-account cheats, support removal, soft delete and restore, all reconciled', async () => {
    const email = 'tester-journey@example.test';
    const hero = await startJourney({
      app,
      clock,
      classId: 'warrior',
      email,
      displayName: 'Probe Ansel',
      name: 'Probehold',
    });
    const bystander = await startJourney({
      app,
      clock,
      classId: 'hunter',
      email: 'bystander@example.test',
      displayName: 'Plain Orla',
      name: 'Orlavane',
    });
    // No farming before the grant: a seed can fill the pack (the grant then rightly refuses).
    const a = await insertAccount(database.db, { role: 'admin', now: new Date(nowMs) });
    const admin: Player = {
      account: { id: a.id, handle: a.handle, displayName: a.displayName },
      api: (method, url, payload, headers = {}) =>
        app.inject({
          method,
          url,
          headers,
          ...(payload ? { payload } : {}),
          cookies: { [SESSION_COOKIE]: a.token },
        }),
    };
    await playAdminToolsStep(app, database, { admin, hero, email, bystander });
  }, 60_000);
});
