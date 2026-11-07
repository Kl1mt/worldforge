/**
 * Ticket F.1: the Tavern offers the Ashen Pass's contracts exactly when the hero can enter the
 * Pass (world flag `ashenPassCleared` and the area's own unlock, as on the map). Its own app and
 * database, so the flag it opens and closes never reaches another test file. Seed-independent: the
 * day under test is found from the hero's (random) id with game-core's own board, never assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  CONTRACT_TEMPLATES,
  contractDay,
  dailyContracts,
  worldFlagsFrom,
  type QuestObjective,
  type WorldProgress,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import { characterQuests, characters, worldFlags } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { recordQuestEventsTx, type QuestBoardResponse } from './store.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-11-07T08:00:00Z');
const PASS_IDS = new Set(
  CONTRACT_TEMPLATES.filter((t) => t.areaId === 'ashenPass').map((t) => t.id),
);
const OPEN = worldFlagsFrom(['warehouseRestored', 'ashenPassCleared']);
const SLAYER: WorldProgress = { gravewardenDefeated: true };

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = START;

beforeAll(async () => {
  database = await createTestDatabase();
  const now = () => new Date(nowMs);
  app = buildApp({
    database,
    auth: { now, registerRateLimit: { max: 1000, timeWindowMs: 60_000 } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

async function setPassFlag(open: boolean) {
  if (open) {
    await database.db
      .insert(worldFlags)
      .values({ flagId: 'ashenPassCleared', projectId: 'clearAshenPass', setAt: new Date(nowMs) })
      .onConflictDoNothing();
  } else {
    await database.db.delete(worldFlags).where(eq(worldFlags.flagId, 'ashenPassCleared'));
  }
  app.worldState.invalidate();
}

interface Player {
  token: string;
  id: string;
}

let seq = 0;
async function newHero(level: number, progress: WorldProgress = SLAYER): Promise<Player> {
  seq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `passwalker${seq}@graumark.test`,
      displayName: `Passwalker ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: {
      name: `Cinder${String.fromCharCode(96 + seq)}`,
      classId: 'warrior',
      appearance: { banner: 'ash' },
    },
    cookies: { [SESSION_COOKIE]: token },
  });
  if (created.statusCode !== 201) throw new Error(`create failed: ${created.body}`);
  const id = created.json<{ character: { id: string } }>().character.id;
  await database.db.update(characters).set({ level, progress }).where(eq(characters.id, id));
  return { token, id };
}

const call = (p: Player, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: method === 'POST' && url.endsWith('/turn-in') ? { 'idempotency-key': uuidv7() } : {},
    ...(payload ? { payload } : {}),
    cookies: { [SESSION_COOKIE]: p.token },
  });
const board = async (p: Player) => {
  const res = await call(p, 'GET', `/api/characters/${p.id}/quests`);
  expect(res.statusCode).toBe(200);
  return res.json<QuestBoardResponse>();
};
const passOffers = (b: QuestBoardResponse) =>
  b.contracts.offers.filter((o) => PASS_IDS.has(o.templateId));

/**
 * Moves the clock to the first day (from START) on which the hero's board, with the Pass open,
 * holds a Pass contract (by game-core's own deterministic board); the slot it is in.
 */
function goToPassDay(p: Player, level = 24): number {
  for (let i = 0; i < 60; i++) {
    const ms = START + i * DAY;
    const offer = dailyContracts(p.id, contractDay(new Date(ms)), level, SLAYER, OPEN).find((o) =>
      PASS_IDS.has(o.template.id),
    );
    if (offer) {
      nowMs = ms;
      return offer.slot;
    }
  }
  throw new Error('no Pass contract in 60 days');
}

describe('Ashen Pass contracts (ticket F.1)', () => {
  it('closed flag: never offered, never taken, and a Pass contract held cannot be turned in', async () => {
    await setPassFlag(false);
    const p = await newHero(26);
    const slot = goToPassDay(p, 26);
    const b = await board(p);
    expect(passOffers(b)).toEqual([]);
    expect(b.contracts.offers).toHaveLength(3);
    // Forcing the slot the open board would hold the Pass contract in takes what the closed board
    // shows there, never a Pass contract.
    const res = await call(p, 'POST', `/api/characters/${p.id}/quests`, { kind: 'contract', slot });
    expect(res.statusCode).toBe(201);
    const taken = res.json<QuestBoardResponse>().quests.find((q) => q.kind === 'contract')!;
    expect(PASS_IDS.has(taken.questId)).toBe(false);
    expect(taken.questId).toBe(b.contracts.offers[slot]!.templateId);

    // A Pass contract listed while the Pass was open (row as the accept path writes it), finished,
    // then the flag closed: the turn-in waits, and pays once the Pass is open again.
    const templateId = [...PASS_IDS][0]!;
    const template = CONTRACT_TEMPLATES.find((t) => t.id === templateId)!;
    const rowId = uuidv7();
    await database.db.insert(characterQuests).values({
      id: rowId,
      characterId: p.id,
      kind: 'contract',
      questId: templateId,
      contractDay: contractDay(new Date(nowMs - DAY)),
      contractSlot: 0,
      objectives: [template.objective],
      progress: ['count' in template.objective ? template.objective.count : 1],
      reward: { xp: 100, gold: 50, materials: {}, item: null },
      acceptedAt: new Date(nowMs - DAY),
    });
    const refused = await call(p, 'POST', `/api/characters/${p.id}/quests/${rowId}/turn-in`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
      code: 'contract_area_locked',
      details: { blockers: [{ kind: 'worldFlag', flag: 'ashenPassCleared' }] },
    });
    const [row] = await database.db
      .select()
      .from(characterQuests)
      .where(eq(characterQuests.id, rowId));
    expect(row!.status).toBe('active');

    await setPassFlag(true);
    const paid = await call(p, 'POST', `/api/characters/${p.id}/quests/${rowId}/turn-in`);
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json<{ reward: { gold: number } }>().reward.gold).toBe(50);
  });

  it('flag set but the hero under the level: not offered', async () => {
    await setPassFlag(true);
    const p = await newHero(23);
    goToPassDay(p, 24); // the day a level-24 hero would see one
    const b = await board(p);
    expect(passOffers(b)).toEqual([]);
    for (const o of b.contracts.offers) {
      const res = await call(p, 'POST', `/api/characters/${p.id}/quests`, {
        kind: 'contract',
        slot: o.slot,
      });
      expect(res.statusCode).toBe(201);
    }
    const held = (await board(p)).quests.filter((q) => q.kind === 'contract');
    expect(held).toHaveLength(3);
    expect(held.some((q) => PASS_IDS.has(q.questId))).toBe(false);
  });

  it('flag and level: offered, accepted, finished in the Pass and turned in once', async () => {
    await setPassFlag(true);
    const p = await newHero(24);
    const slot = goToPassDay(p);
    const b = await board(p);
    const offer = b.contracts.offers[slot]!;
    expect(PASS_IDS.has(offer.templateId)).toBe(true);
    expect(offer.accepted).toBe(false);
    expect(offer.objective.kind).toBe('kill');

    const res = await call(p, 'POST', `/api/characters/${p.id}/quests`, { kind: 'contract', slot });
    expect(res.statusCode, res.body).toBe(201);
    const quest = res
      .json<QuestBoardResponse>()
      .quests.find((q) => q.questId === offer.templateId)!;
    expect(quest.status).toBe('active');
    // The hero may go there (the server's own gate) ...
    const go = await call(p, 'POST', `/api/characters/${p.id}/activity`, { areaId: 'ashenPass' });
    expect(go.statusCode, go.body).toBe(201);
    // ... and the Pass's kills count (a settlement's quest events; the journey farms them for real).
    const objective = offer.objective as Extract<QuestObjective, { kind: 'kill' }>;
    await withTransaction(database.db, (tx) =>
      recordQuestEventsTx(tx, p.id, [
        { type: 'enemyKilled', enemyId: objective.enemyId, count: objective.count },
      ]),
    );
    const ready = (await board(p)).quests.find((q) => q.id === quest.id)!;
    expect(ready.status).toBe('ready');

    const before = (await database.db.select().from(characters).where(eq(characters.id, p.id)))[0]!;
    const turned = await call(p, 'POST', `/api/characters/${p.id}/quests/${quest.id}/turn-in`);
    expect(turned.statusCode, turned.body).toBe(200);
    const reward = turned.json<{ reward: { gold: number; xp: number } }>().reward;
    expect(reward).toMatchObject(offer.reward);
    const after = (await database.db.select().from(characters).where(eq(characters.id, p.id)))[0]!;
    expect(after.gold - before.gold).toBe(offer.reward.gold);
    const again = await call(p, 'POST', `/api/characters/${p.id}/quests/${quest.id}/turn-in`);
    expect(again.statusCode).toBe(409);
  });

  it('opening the Pass leaves the boards of heroes who cannot reach it unchanged', async () => {
    await setPassFlag(false);
    const heroes = [
      await newHero(10),
      await newHero(23),
      await newHero(30, { gravewardenDefeated: false }),
    ];
    const pass = await newHero(24);
    goToPassDay(pass);
    const closed = await Promise.all(heroes.map(board));
    await setPassFlag(true);
    const open = await Promise.all(heroes.map(board));
    expect(open.map((b) => b.contracts.offers)).toEqual(closed.map((b) => b.contracts.offers));
    // The hero who can reach it sees the Pass today.
    expect(passOffers(await board(pass)).length).toBeGreaterThan(0);
  });
});
