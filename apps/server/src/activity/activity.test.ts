import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { DEFAULT_ACTIVITY_CONFIG } from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import {
  activities,
  auditLog,
  characterMaterials,
  characterProfessions,
  characters,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { DEFAULT_ACTIVITY_OPTIONS, settleDueActivities, type ActivityOptions } from './settle.js';
import type { ActivityStateResponse, SettleResponse } from './routes.js';
import type { WorldStateResponse } from '../world/routes.js';
import type { MaterialsResponse } from '../materials/store.js';

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

async function materialRows(id: string) {
  const materials = await database.db
    .select({ materialId: characterMaterials.materialId, quantity: characterMaterials.quantity })
    .from(characterMaterials)
    .where(eq(characterMaterials.characterId, id))
    .orderBy(characterMaterials.materialId);
  const professions = await database.db
    .select({
      professionId: characterProfessions.professionId,
      level: characterProfessions.level,
      experience: characterProfessions.experience,
    })
    .from(characterProfessions)
    .where(eq(characterProfessions.characterId, id))
    .orderBy(characterProfessions.professionId);
  return { materials, professions };
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
    expect(state.json().activity).toMatchObject({
      characterId: id,
      areaId: 'abandonedFields',
      health: null, // full until the first settlement
    });
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
    const { summary, character, activity } = res.json<SettleResponse>();
    expect(activity?.health === null || Number.isInteger(activity?.health)).toBe(true);
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

/** Ticket 1.9 exploit review: fixes that keep the timing of client requests from changing rewards. */
describe('hardening (ticket 1.9)', () => {
  it('advances cycle_index by the completed cycles and seeds by it, not by settlement count', async () => {
    const { p, id } = await farmer();
    advance(20 * MIN);
    const { summary } = (await settle(p, id)).json<SettleResponse>();
    const [row] = await database.db.select().from(activities).where(eq(activities.characterId, id));
    expect(summary.kills).toBeGreaterThan(0);
    expect(row!.cycleIndex).toBeGreaterThanOrEqual(summary.kills + summary.deaths);
    // Half a second finishes at most one cycle, and the index moves by exactly what completed.
    advance(500);
    const next = (await settle(p, id)).json<SettleResponse>().summary;
    const [again] = await database.db
      .select()
      .from(activities)
      .where(eq(activities.characterId, id));
    const delta = again!.cycleIndex - row!.cycleIndex;
    expect(delta).toBeLessThanOrEqual(1);
    expect(delta).toBeGreaterThanOrEqual(next.kills + next.deaths);
  });

  it('stop → start restores health, seed secret and cycle index (no free heal or re-roll)', async () => {
    // A mage at level 1 takes damage; stop/start used to reset health to full and re-roll the
    // next encounter (simulated: 0 deaths and +25 % kills when cycled after every kill).
    const { p, id } = await farmer('mage');
    advance(10 * MIN);
    await settle(p, id);
    const [before] = await database.db
      .select()
      .from(activities)
      .where(eq(activities.characterId, id));
    expect((await stop(p, id)).statusCode).toBe(200);
    const saved = (await characterRow(id)).farmState;
    expect(saved).toEqual({
      seedSecret: before!.seedSecret,
      cycleIndex: before!.cycleIndex,
      health: before!.health,
      // Stopped mid-cycle: that cycle stays bound to its area (ticket 2.2).
      ...(before!.carryMs > 0 ? { areaId: 'abandonedFields' } : {}),
    });
    expect((await start(p, id)).statusCode).toBe(201);
    const [after] = await database.db
      .select()
      .from(activities)
      .where(eq(activities.characterId, id));
    expect(after).toMatchObject({
      seedSecret: before!.seedSecret,
      cycleIndex: before!.cycleIndex,
      health: before!.health,
    });
    // The farm state is never part of a response.
    const list = await call(p, 'GET', '/api/characters');
    expect(list.body).not.toContain(before!.seedSecret);
    expect(list.body).not.toContain('farmState');
  });

  it('switching characters saves the stopped character’s farm state', async () => {
    const { p, id } = await farmer();
    advance(5 * MIN);
    const second = await newCharacter(p);
    expect((await start(p, second)).statusCode).toBe(201);
    expect((await characterRow(id)).farmState?.cycleIndex).toBeGreaterThan(0);
  });

  async function grantItem(characterId: string, baseId = 'longsword-notched') {
    const id = uuidv7();
    await database.db.insert(itemInstances).values({
      id,
      characterId,
      baseId,
      rarityId: 'common',
      itemLevel: 1,
      seed: 1,
      source: 'test',
    });
    return id;
  }

  it('equip, unequip and discard settle the running activity first (no retroactive gear)', async () => {
    const { p, id } = await farmer();
    const sword = await grantItem(id);
    const junk = await grantItem(id, 'iron-ring');
    for (const [method, url] of [
      ['POST', `/api/characters/${id}/items/${sword}/equip`],
      ['POST', `/api/characters/${id}/items/${sword}/unequip`],
      ['DELETE', `/api/characters/${id}/items/${junk}`],
    ] as const) {
      advance(30 * MIN);
      const audits = (await rewardAudits(id)).length;
      const res = await app.inject({ method, url, cookies: { [SESSION_COOKIE]: p.token } });
      expect(res.statusCode).toBe(200);
      // The 30 minutes before the change were credited with the gear worn during them.
      expect(await rewardAudits(id)).toHaveLength(audits + 1);
      const [row] = await database.db
        .select()
        .from(activities)
        .where(eq(activities.characterId, id));
      expect(row!.settledAt.getTime()).toBe(nowMs);
      expect(row!.lastSeenAt.getTime()).toBe(nowMs);
    }
  });
});

describe('areas & unlocks (ticket 2.2)', () => {
  async function setLevel(id: string, level: number) {
    await database.db.update(characters).set({ level, experience: 0 }).where(eq(characters.id, id));
  }
  async function activityRow(id: string) {
    const [a] = await database.db.select().from(activities).where(eq(activities.characterId, id));
    return a;
  }
  const world = async (p: Player, id: string) =>
    (await call(p, 'GET', `/api/characters/${id}/world`)).json<WorldStateResponse>();

  it('refuses a level-gated area with the blockers, and opens it at the level', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const res = await start(p, id, 'crowwood');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'area_locked',
      details: { areaId: 'crowwood', blockers: [{ kind: 'level', required: 5 }] },
    });
    expect(await activityRow(id)).toBeUndefined();
    await setLevel(id, 5);
    expect((await start(p, id, 'crowwood')).statusCode).toBe(201);
  });

  it('refuses a locked area as a switch target too, keeping the current activity', async () => {
    const { p, id } = await farmer();
    advance(MIN);
    const res = await start(p, id, 'blackwater');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('area_locked');
    expect(await activityRow(id)).toMatchObject({ areaId: 'abandonedFields', pendingAreaId: null });
  });

  it('gates the Sunken Abbey on the Gravewarden, not only the level', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await setLevel(id, 20);
    const res = await start(p, id, 'sunkenAbbey');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.blockers).toEqual([{ kind: 'gravewardenDefeated' }]);
    await database.db
      .update(characters)
      .set({ progress: { gravewardenDefeated: true } })
      .where(eq(characters.id, id));
    expect((await start(p, id, 'sunkenAbbey')).statusCode).toBe(201);
  });

  it('reports world state: locked places with reasons, and the current area', async () => {
    const { p, id } = await farmer();
    const w = await world(p, id);
    expect(w).toMatchObject({
      characterId: id,
      level: 1,
      progress: { gravewardenDefeated: false },
      current: { areaId: 'abandonedFields', pendingAreaId: null },
    });
    expect(w.areas.map((a) => [a.id, a.unlocked])).toEqual([
      ['abandonedFields', true],
      ['crowwood', false],
      ['oldBurialGrounds', false],
      ['blackwater', false],
      ['sunkenAbbey', false],
    ]);
    expect(w.areas[4]!.blockers).toEqual([
      { kind: 'level', required: 17 },
      { kind: 'gravewardenDefeated' },
    ]);
    expect(w.dungeons).toEqual([
      {
        id: 'namelessCrypt',
        unlocked: false,
        available: true,
        blockers: [{ kind: 'level', required: 12 }],
      },
    ]);
    expect((await call(await newPlayer(), 'GET', `/api/characters/${id}/world`)).statusCode).toBe(
      404,
    );
    expect((await call(null, 'GET', `/api/characters/${id}/world`)).statusCode).toBe(401);
  });

  it('finishes the cycle in progress in the old area before switching', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await setLevel(id, 9);
    expect((await start(p, id)).statusCode).toBe(201);
    advance(5 * MIN + 1_234);
    await settle(p, id);
    const before = (await activityRow(id))!;
    expect(before.carryMs).toBeGreaterThan(0); // mid-cycle
    const res = await start(p, id, 'crowwood');
    expect(res.statusCode).toBe(200);
    expect(res.json<ActivityStateResponse>().activity).toMatchObject({
      areaId: 'abandonedFields',
      pendingAreaId: 'crowwood',
    });
    // Choosing the current area again cancels; choosing another replaces the target.
    await start(p, id, 'abandonedFields');
    expect((await activityRow(id))!.pendingAreaId).toBeNull();
    await start(p, id, 'oldBurialGrounds');
    expect((await activityRow(id))!.pendingAreaId).toBe('oldBurialGrounds');
    expect((await activityRow(id))!.carryMs).toBe(before.carryMs);
    advance(2 * MIN);
    await settle(p, id);
    const after = (await activityRow(id))!;
    expect(after).toMatchObject({ areaId: 'oldBurialGrounds', pendingAreaId: null });
    expect(after.cycleIndex).toBeGreaterThan(before.cycleIndex);
    expect((await world(p, id)).current).toEqual({
      areaId: 'oldBurialGrounds',
      pendingAreaId: null,
    });
  });

  it('a stop mid-cycle binds that cycle to its area for the next start', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    await setLevel(id, 9);
    await start(p, id);
    advance(5 * MIN + 777);
    await settle(p, id);
    expect((await activityRow(id))!.carryMs).toBeGreaterThan(0);
    await stop(p, id);
    expect((await characterRow(id)).farmState?.areaId).toBe('abandonedFields');
    const res = await start(p, id, 'crowwood');
    expect(res.statusCode).toBe(201);
    expect(res.json<ActivityStateResponse>().activity).toMatchObject({
      areaId: 'abandonedFields',
      pendingAreaId: 'crowwood',
    });
    // Re-targeting right away (no time in the cycle yet) cannot unbind it either.
    await start(p, id, 'oldBurialGrounds');
    expect(await activityRow(id)).toMatchObject({
      areaId: 'abandonedFields',
      pendingAreaId: 'oldBurialGrounds',
    });
  });

  it('a switch gives the same result however often the client settles (invariance)', async () => {
    // Same seed secret, class and level; one client settles every 5 s, the other only when it
    // switches and at the end. Their characters and activities must end up identical.
    const spam = await newPlayer();
    const lazy = await newPlayer();
    const ids = [await newCharacter(spam, 'mage'), await newCharacter(lazy, 'mage')];
    for (const id of ids) await setLevel(id, 10);
    expect((await start(spam, ids[0]!, 'crowwood')).statusCode).toBe(201);
    expect((await start(lazy, ids[1]!, 'crowwood')).statusCode).toBe(201);
    await database.db
      .update(activities)
      .set({ seedSecret: 'switch-invariance' })
      .where(inArray(activities.characterId, ids));
    const switches = new Map([
      [84, 'oldBurialGrounds'], // 7 min
      [85, 'abandonedFields'], // re-target while pending
      [157, 'crowwood'], // 13 min 5 s
    ]);
    for (let step = 1; step <= 240; step++) {
      advance(5_000);
      const to = switches.get(step);
      await settle(spam, ids[0]!);
      if (to) {
        await start(spam, ids[0]!, to);
        await start(lazy, ids[1]!, to);
      }
    }
    await settle(lazy, ids[1]!);
    await settle(spam, ids[0]!);
    const pick = async (id: string) => {
      const c = await characterRow(id);
      const a = (await activityRow(id))!;
      const items = await database.db
        .select({ baseId: itemInstances.baseId, seed: itemInstances.seed })
        .from(itemInstances)
        .where(eq(itemInstances.characterId, id))
        .orderBy(itemInstances.seed);
      return {
        level: c.level,
        experience: c.experience,
        gold: c.gold,
        items,
        gathered: await materialRows(id),
        activity: {
          areaId: a.areaId,
          pendingAreaId: a.pendingAreaId,
          cycleIndex: a.cycleIndex,
          carryMs: a.carryMs,
          health: a.health,
        },
      };
    };
    const [a, b] = [await pick(ids[0]!), await pick(ids[1]!)];
    expect(a.experience + a.gold).toBeGreaterThan(0);
    // Gathering is part of it (ticket 2.3): Crowwood timber/hide, and Fields after the switch.
    expect(a.gathered.materials.map((m) => m.materialId)).toEqual(
      expect.arrayContaining(['rawHide', 'timber']),
    );
    expect(a.gathered.professions.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
});

describe('materials & professions (ticket 2.3)', () => {
  const materials = async (p: Player | null, id: string) =>
    call(p, 'GET', `/api/characters/${id}/materials`);

  it('starts empty, with every profession at level 1', async () => {
    const p = await newPlayer();
    const id = await newCharacter(p);
    const res = await materials(p, id);
    expect(res.statusCode).toBe(200);
    const body = res.json<MaterialsResponse>();
    expect(body.materials).toEqual([]);
    expect(body.professions.map((x) => x.professionId)).toEqual([
      'mining',
      'woodcutting',
      'herbalism',
      'skinning',
    ]);
    for (const x of body.professions) {
      expect(x).toMatchObject({ level: 1, xp: 0, maxLevel: 50 });
      expect(x.xpToNext).toBeGreaterThan(0);
    }
  });

  it('is private: no session is 401, another account’s character is 404', async () => {
    const { id } = await farmer();
    expect((await materials(null, id)).statusCode).toBe(401);
    expect((await materials(await newPlayer(), id)).statusCode).toBe(404);
    expect((await materials(await newPlayer(), 'not-a-uuid')).statusCode).toBe(400);
  });

  it('settlement grants materials and profession XP with the rest of the rewards', async () => {
    const { p, id } = await farmer();
    advance(HOUR);
    const settled = (await settle(p, id)).json<SettleResponse>();
    const { materials: summaryMaterials, professions } = settled.summary;
    expect(summaryMaterials?.timber).toBeGreaterThan(0);
    expect(summaryMaterials?.ashwort).toBeGreaterThan(0);
    expect(professions?.woodcutting?.xpGained).toBeGreaterThan(0);
    expect(professions?.mining).toBeUndefined();

    const rows = await materialRows(id);
    expect(Object.fromEntries(rows.materials.map((m) => [m.materialId, m.quantity]))).toEqual(
      summaryMaterials,
    );
    const view = (await materials(p, id)).json<MaterialsResponse>();
    expect(view.materials).toEqual([
      { materialId: 'timber', quantity: summaryMaterials!.timber },
      { materialId: 'ashwort', quantity: summaryMaterials!.ashwort },
    ]);
    const wood = view.professions.find((x) => x.professionId === 'woodcutting')!;
    expect(wood.level).toBe(1 + professions!.woodcutting!.levelsGained);
    expect(wood.level).toBeGreaterThan(1);

    const [audit] = (await rewardAudits(id)).slice(-1);
    expect((audit!.data as { materials: unknown }).materials).toEqual(summaryMaterials);

    // Stacks grow across settlements; the next summary starts empty.
    advance(HOUR);
    const next = (await settle(p, id)).json<SettleResponse>();
    const after = (await materials(p, id)).json<MaterialsResponse>();
    expect(after.materials.find((m) => m.materialId === 'timber')!.quantity).toBe(
      summaryMaterials!.timber! + (next.summary.materials?.timber ?? 0),
    );
    const settledAgain = (await settle(p, id)).json<SettleResponse>();
    expect(settledAgain.summary.materials).toEqual({});
  });

  it('gives the same materials and professions however often the client settles', async () => {
    const spam = await newPlayer();
    const lazy = await newPlayer();
    const ids = [await newCharacter(spam), await newCharacter(lazy)];
    expect((await start(spam, ids[0]!)).statusCode).toBe(201);
    expect((await start(lazy, ids[1]!)).statusCode).toBe(201);
    await database.db
      .update(activities)
      .set({ seedSecret: 'gather-invariance' })
      .where(inArray(activities.characterId, ids));
    for (let step = 0; step < 120; step++) {
      advance(10_000);
      await settle(spam, ids[0]!);
    }
    await settle(lazy, ids[1]!);
    const [a, b] = [await materialRows(ids[0]!), await materialRows(ids[1]!)];
    expect(a.materials.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });

  it('a stored profession level raises the yield', async () => {
    const low = await farmer();
    const high = await farmer();
    await database.db
      .update(activities)
      .set({ seedSecret: 'gather-level' })
      .where(inArray(activities.characterId, [low.id, high.id]));
    await database.db
      .insert(characterProfessions)
      .values([{ characterId: high.id, professionId: 'woodcutting', level: 45, experience: 0 }]);
    advance(HOUR);
    const a = (await settle(low.p, low.id)).json<SettleResponse>();
    const b = (await settle(high.p, high.id)).json<SettleResponse>();
    expect(b.summary.kills).toBe(a.summary.kills);
    expect(b.summary.materials!.ashwort).toBe(a.summary.materials!.ashwort);
    expect(b.summary.materials!.timber!).toBeGreaterThan(a.summary.materials!.timber! * 1.5);
  });
});
