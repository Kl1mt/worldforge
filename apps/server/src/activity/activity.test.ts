import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, isNull } from 'drizzle-orm';
import { DEFAULT_ACTIVITY_CONFIG } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { activities, auditLog, characters, itemInstances } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACTIVITY_OPTIONS, settleDueActivities, type ActivityOptions } from './settle.js';
import type { SettleResponse } from './routes.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const CAP = 3 * HOUR;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-01T12:00:00Z');
const advance = (ms: number) => {
  nowMs += ms;
};
const options: ActivityOptions = {
  ...DEFAULT_ACTIVITY_OPTIONS,
  offlineCapMs: CAP,
  now: () => new Date(nowMs),
};

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: options,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

interface Player {
  token: string;
  accountId: string;
}

let seq = 0;
async function newPlayer(): Promise<Player> {
  seq += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `farmer${seq}@graumark.test`,
      displayName: `Farmer ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${res.statusCode}`);
  return { token, accountId: res.json<{ account: { id: string } }>().account.id };
}

function freshName(): string {
  seq += 1;
  let n = seq;
  let suffix = '';
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `Tilda${suffix}`;
}

async function newCharacter(p: Player, classId = 'warrior'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: freshName(), classId, appearance: { banner: 'ash' } },
    cookies: { [SESSION_COOKIE]: p.token },
  });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json<{ character: { id: string } }>().character.id;
}

const call = (p: Player | null, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    cookies: p ? { [SESSION_COOKIE]: p.token } : {},
  });
const start = (p: Player | null, id: string, areaId = 'abandonedFields') =>
  call(p, 'POST', `/api/characters/${id}/activity`, { areaId });
const settle = (p: Player | null, id: string) =>
  call(p, 'POST', `/api/characters/${id}/activity/settle`);
const stop = (p: Player | null, id: string) =>
  call(p, 'POST', `/api/characters/${id}/activity/stop`);

async function farmer(classId = 'warrior') {
  const p = await newPlayer();
  const id = await newCharacter(p, classId);
  expect((await start(p, id)).statusCode).toBe(201);
  return { p, id };
}

async function characterRow(id: string) {
  const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
  return c!;
}

async function inventoryCount(id: string) {
  const [r] = await database.db
    .select({ n: count() })
    .from(itemInstances)
    .where(and(eq(itemInstances.characterId, id), isNull(itemInstances.equippedSlot)));
  return r!.n;
}

async function rewardAudits(id: string) {
  return database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'activity.reward')));
}

describe('start / stop', () => {
  it('requires a session, an own active character and a known area', async () => {
    const { p, id } = await farmer();
    const other = await newPlayer();
    expect((await start(null, id)).statusCode).toBe(401);
    expect((await start(other, id)).statusCode).toBe(404);
    expect((await settle(other, id)).statusCode).toBe(404);
    expect((await call(other, 'GET', `/api/characters/${id}/activity`)).statusCode).toBe(404);
    const bad = await start(p, id, 'mountDoom');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.fields.areaId).toBeDefined();
    // Another character of the same account that is not selected.
    const second = await newCharacter(p);
    await call(p, 'POST', `/api/characters/${id}/select`);
    expect((await start(p, second)).json().error.code).toBe('character_not_active');
  });

  it('is idempotent for the same area and never exposes the seed secret', async () => {
    const { p, id } = await farmer();
    const again = await start(p, id);
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain('seed');
    const state = await call(p, 'GET', `/api/characters/${id}/activity`);
    expect(state.json().activity).toMatchObject({ characterId: id, areaId: 'abandonedFields' });
    expect(state.body).not.toContain('seed');
  });

  it('stop settles, returns the summary and removes the activity', async () => {
    const { p, id } = await farmer();
    advance(30 * MIN);
    const res = await stop(p, id);
    expect(res.statusCode).toBe(200);
    const body = res.json<SettleResponse>();
    expect(body.activity).toBeNull();
    expect(body.summary.xpGained).toBeGreaterThan(0);
    expect((await call(p, 'GET', `/api/characters/${id}/activity`)).json().activity).toBeNull();
    expect((await settle(p, id)).json().error.code).toBe('not_farming');
    expect((await stop(p, id)).statusCode).toBe(409);
  });

  it('keeps one activity per account: starting another character stops the first', async () => {
    const { p, id } = await farmer();
    const second = await newCharacter(p); // becomes the active character
    advance(10 * MIN);
    expect((await start(p, second)).statusCode).toBe(201);
    const rows = await database.db
      .select()
      .from(activities)
      .where(eq(activities.accountId, p.accountId));
    expect(rows.map((r) => r.characterId)).toEqual([second]);
    // The first character was settled before stopping.
    expect(await rewardAudits(id)).toHaveLength(1);
    expect((await characterRow(id)).experience).toBeGreaterThan(0);
  });
});

describe('settlement', () => {
  it('grants XP, gold and items from server time, with an audit entry', async () => {
    const { p, id } = await farmer();
    advance(HOUR);
    const res = await settle(p, id);
    expect(res.statusCode).toBe(200);
    const { summary, character } = res.json<SettleResponse>();
    expect(summary.xpGained).toBeGreaterThan(0);
    expect(summary.goldGained).toBeGreaterThan(0);
    expect(summary.itemsGained).toBeGreaterThan(0);
    expect(summary.cappedMs).toBe(0);
    expect(summary.simulatedMs).toBeGreaterThan(HOUR - MIN);
    expect(summary.simulatedMs).toBeLessThanOrEqual(HOUR);
    expect(character.gold).toBe(summary.goldGained);
    expect(character.level).toBe(1 + summary.levelsGained);

    const items = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, id));
    expect(items).toHaveLength(summary.itemsGained);
    expect(items.every((i) => i.equippedSlot === null && i.source === 'farming')).toBe(true);
    expect(summary.items.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());

    const audits = await rewardAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({ gold: summary.goldGained, items: summary.itemsGained });
  });

  it('ignores client input: the body cannot change rewards', async () => {
    const { p, id } = await farmer();
    advance(MIN);
    const res = await app.inject({
      method: 'POST',
      url: `/api/characters/${id}/activity/settle`,
      payload: { durationMs: 999 * HOUR, gold: 1e9 },
      cookies: { [SESSION_COOKIE]: p.token },
    });
    expect(res.json<SettleResponse>().summary.simulatedMs).toBeLessThanOrEqual(MIN);
    expect(res.json<SettleResponse>().character.gold).toBeLessThan(1000);
  });

  it('is idempotent: settling again at the same time credits nothing', async () => {
    const { p, id } = await farmer();
    advance(20 * MIN);
    const first = (await settle(p, id)).json<SettleResponse>();
    const second = (await settle(p, id)).json<SettleResponse>();
    expect(second.summary).toMatchObject({ settlements: 0, xpGained: 0, goldGained: 0 });
    expect(second.character).toEqual(first.character);
    expect(await rewardAudits(id)).toHaveLength(1);
  });

  it('serialises concurrent settles so a window is credited once', async () => {
    const { p, id } = await farmer();
    advance(HOUR);
    const results = await Promise.all(Array.from({ length: 5 }, () => settle(p, id)));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const summaries = results.map((r) => r.json<SettleResponse>().summary);
    expect(summaries.filter((s) => s.settlements > 0)).toHaveLength(1);
    const gold = summaries.reduce((s, x) => s + x.goldGained, 0);
    const xp = summaries.reduce((s, x) => s + x.simulatedMs, 0);
    expect((await characterRow(id)).gold).toBe(gold);
    expect(xp).toBeLessThanOrEqual(HOUR);
    expect(await rewardAudits(id)).toHaveLength(1);
  });

  it('caps offline progress at OFFLINE_CAP after the last client contact', async () => {
    const { p, id } = await farmer();
    advance(10 * HOUR);
    const { summary } = (await settle(p, id)).json<SettleResponse>();
    expect(summary.cappedMs).toBe(7 * HOUR);
    expect(summary.simulatedMs).toBeGreaterThan(CAP - MIN);
    expect(summary.simulatedMs).toBeLessThanOrEqual(CAP);
    // Contact resets the cap window.
    advance(HOUR);
    const next = (await settle(p, id)).json<SettleResponse>().summary;
    expect(next.cappedMs).toBe(0);
    expect(next.simulatedMs).toBeGreaterThan(HOUR - 2 * MIN);
  });

  it('scheduled settlements accumulate into the return summary and respect the cap', async () => {
    const { p, id } = await farmer();
    advance(2 * HOUR);
    expect(await settleDueActivities(database.db, options, { olderThanMs: HOUR })).toBeGreaterThan(
      0,
    );
    advance(2 * HOUR); // 4 h since last contact: only 1 h more is creditable
    await settleDueActivities(database.db, options, { olderThanMs: HOUR });
    advance(HOUR);
    const { summary, character } = (await settle(p, id)).json<SettleResponse>();
    expect(summary.settlements).toBe(2);
    expect(summary.cappedMs).toBe(2 * HOUR);
    expect(summary.simulatedMs).toBeGreaterThan(CAP - 2 * MIN);
    expect(summary.simulatedMs).toBeLessThanOrEqual(CAP);
    expect(character.gold).toBe(summary.goldGained);
    expect(await rewardAudits(id)).toHaveLength(2);
    // The summary was collected; the next one starts empty.
    expect((await settle(p, id)).json<SettleResponse>().summary.xpGained).toBe(0);
  });

  it('is deterministic for the same server-side seed and window', async () => {
    const a = await farmer('mage');
    const b = await farmer('mage');
    for (const c of [a, b]) {
      await database.db
        .update(activities)
        .set({ seedSecret: 'fixed-secret' })
        .where(eq(activities.characterId, c.id));
    }
    advance(2 * HOUR);
    const ra = (await settle(a.p, a.id)).json<SettleResponse>();
    const rb = (await settle(b.p, b.id)).json<SettleResponse>();
    const strip = (s: SettleResponse['summary']) => ({
      ...s,
      items: s.items.map(({ id: _id, ...rest }) => rest),
    });
    expect(strip(ra.summary)).toEqual(strip(rb.summary));
    expect(ra.character.experience).toBe(rb.character.experience);
  });

  it('salvages loot beyond inventory capacity into gold', async () => {
    const { p, id } = await farmer();
    const capacity = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    await database.db.insert(itemInstances).values(
      Array.from({ length: capacity }, (_, i) => ({
        id: uuidv7(),
        characterId: id,
        baseId: 'iron-ring',
        rarityId: 'common' as const,
        itemLevel: 1,
        seed: i,
        source: 'test',
      })),
    );
    advance(HOUR);
    const { summary } = (await settle(p, id)).json<SettleResponse>();
    expect(summary.itemsGained).toBe(0);
    expect(summary.itemsSalvaged).toBeGreaterThan(0);
    expect(summary.goldSalvaged).toBeGreaterThan(0);
    expect(await inventoryCount(id)).toBe(capacity);
  });
});
