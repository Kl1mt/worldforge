import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { makeCryptReady } from '../test/dungeon.js';
import {
  communityContributions,
  communityProjects,
  telemetryDaily,
  worldFlags,
} from '../db/schema.js';
import { insertAccount } from '../test/social.js';
import { latestStoredTimeMs } from './stored-time.js';

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2030-01-01T12:00:00Z');

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('latestStoredTimeMs (playtest clock floor)', () => {
  it('is null for an empty database', async () => {
    expect(await latestStoredTimeMs(database.db)).toBeNull();
  });

  it('counts a dungeon run, which has no farming activity (ticket 2.8)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: {
        email: 'clock@graumark.test',
        password: 'ashes-and-iron-42',
        displayName: 'Clock',
      },
    });
    const cookies = { [SESSION_COOKIE]: reg.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
    const created = await app.inject({
      method: 'POST',
      url: '/api/characters',
      cookies,
      payload: { name: 'Clockwarden', classId: 'warrior', appearance: { banner: 'ash' } },
    });
    const id = created.json<{ character: { id: string } }>().character.id;
    await makeCryptReady(database.db, id, 'warrior', 16);
    const enter = async () =>
      app.inject({
        method: 'POST',
        url: `/api/characters/${id}/dungeon`,
        cookies,
        payload: { dungeonId: 'namelessCrypt' },
      });
    // Fields first, then the crypt: entering stops farming and deletes the activity row.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/characters/${id}/activity`,
          cookies,
          payload: { areaId: 'abandonedFields' },
        })
      ).statusCode,
    ).toBe(201);
    nowMs += 60 * 60 * 1000;
    expect((await enter()).statusCode).toBe(201);
    expect(await latestStoredTimeMs(database.db)).toBe(nowMs);
  });

  it('counts a telemetry day (ticket 3.8) at its start, UTC', async () => {
    await database.db
      .insert(telemetryDaily)
      .values({ day: '2031-05-05', metric: 'gold.in', dim1: 'merchant_sell', amount: 5 });
    expect(await latestStoredTimeMs(database.db)).toBe(Date.parse('2031-05-05T00:00:00Z'));
  });

  it('counts community projects, contribution days and world flags (ticket 4.6)', async () => {
    await database.db
      .insert(communityProjects)
      .values({ projectId: 'restoreWarehouse', updatedAt: new Date('2032-01-01T10:00:00Z') });
    expect(await latestStoredTimeMs(database.db)).toBe(Date.parse('2032-01-01T10:00:00Z'));
    const who = await insertAccount(database.db);
    await database.db.insert(communityContributions).values({
      projectId: 'restoreWarehouse',
      stageId: 'clearRubble',
      accountId: who.id,
      day: '2032-02-02',
      resource: 'gold',
      amount: 1,
    });
    expect(await latestStoredTimeMs(database.db)).toBe(Date.parse('2032-02-02T00:00:00Z'));
    await database.db
      .insert(worldFlags)
      .values({ flagId: 'warehouseRestored', setAt: new Date('2032-03-03T03:00:00Z') });
    expect(await latestStoredTimeMs(database.db)).toBe(Date.parse('2032-03-03T03:00:00Z'));
  });
});
