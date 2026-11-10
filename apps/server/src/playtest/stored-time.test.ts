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
  guildBossAttempts,
  guildBossRewards,
  telemetryDaily,
  worldFlags,
} from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { insertGuild } from '../test/guilds.js';
import { insertAccount } from '../test/social.js';
import { latestStoredTimeMs } from './stored-time.js';

let database: DatabaseHandle;
let app: FastifyInstance;
const DAY = 86_400_000;
// The playtest clock runs ahead of the wall clock, and rows the database stamps with `now()` (an
// item's `created_at`) must stay below the stamps under test. So every date here is an offset
// from a midnight a few years past today, not a fixed date that the wall clock will overtake
// (ticket F.6).
const BASE = Math.floor(Date.now() / DAY) * DAY + 4 * 365 * DAY;
const at = (days: number, ms = 0) => BASE + days * DAY + ms;
const dayKey = (days: number) => new Date(at(days)).toISOString().slice(0, 10);
let nowMs = at(0, 12 * 3_600_000);

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
      .values({ day: dayKey(489), metric: 'gold.in', dim1: 'merchant_sell', amount: 5 });
    expect(await latestStoredTimeMs(database.db)).toBe(at(489));
  });

  it('counts community projects, contribution days and world flags (ticket 4.6)', async () => {
    await database.db
      .insert(communityProjects)
      .values({ projectId: 'restoreWarehouse', updatedAt: new Date(at(730, 10 * 3_600_000)) });
    expect(await latestStoredTimeMs(database.db)).toBe(at(730, 10 * 3_600_000));
    const who = await insertAccount(database.db);
    await database.db.insert(communityContributions).values({
      projectId: 'restoreWarehouse',
      stageId: 'clearRubble',
      accountId: who.id,
      day: dayKey(762),
      resource: 'gold',
      amount: 1,
    });
    expect(await latestStoredTimeMs(database.db)).toBe(at(762));
    const flagAt = at(792, 3 * 3_600_000);
    await database.db
      .insert(worldFlags)
      .values({ flagId: 'warehouseRestored', setAt: new Date(flagAt) });
    expect(await latestStoredTimeMs(database.db)).toBe(flagAt);
  });

  it('counts guild boss attempts and rewards (ticket 4.9)', async () => {
    const leader = await insertAccount(database.db);
    const guild = await insertGuild(database.db, leader.id);
    const attemptAt = at(1494, 14_706_000);
    // The game week of the attempt (its Monday, UTC); stored as given, not checked here.
    const week = dayKey(1494 - ((new Date(attemptAt).getUTCDay() + 6) % 7));
    await database.db.insert(guildBossAttempts).values({
      id: uuidv7(),
      accountId: leader.id,
      week,
      attemptNo: 1,
      guildId: guild.id,
      bossId: 'risenGravewarden',
      snapshot: { classId: 'warrior', level: 20, xp: 0, equipment: [] },
      damage: 10,
      counted: 10,
      end: 'fell',
      durationMs: 1000,
      createdAt: new Date(attemptAt),
    });
    expect(await latestStoredTimeMs(database.db)).toBe(attemptAt);
    const claimed = at(1520);
    await database.db.insert(guildBossRewards).values({
      accountId: leader.id,
      week,
      stage: 1,
      guildId: guild.id,
      bossId: 'risenGravewarden',
      status: 'earned',
      gold: 1,
      materials: {},
      earnedAt: new Date(attemptAt),
      claimedAt: new Date(claimed),
      createdAt: new Date(attemptAt),
    });
    expect(await latestStoredTimeMs(database.db)).toBe(claimed);
  });
});
