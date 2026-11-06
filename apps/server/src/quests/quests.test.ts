import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  findContractTemplate,
  generateItem,
  generateTargetedItem,
  getItemBase,
  offersRewardSlot,
  targetedRewardSeed,
  type StoryQuestId,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import {
  auditLog,
  characterMaterials,
  characterQuests,
  characters,
  itemInstances,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import { recordQuestEventsTx, type QuestBoardResponse, type QuestView } from './store.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let database: DatabaseHandle;
let app: FastifyInstance;
let nowMs = Date.parse('2026-11-04T08:00:00Z');
const advance = (ms: number) => {
  nowMs += ms;
};
const options: ActivityOptions = { ...DEFAULT_ACTIVITY_OPTIONS, now: () => new Date(nowMs) };

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
  id: string;
}

let seq = 0;
function letters(n: number): string {
  let s = '';
  do {
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  } while (n > 0);
  return s;
}

async function newPlayer(): Promise<Player> {
  seq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `questor${seq}@graumark.test`,
      displayName: `Questor ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Wend${letters(seq)}`, classId: 'warrior', appearance: { banner: 'ash' } },
    cookies: { [SESSION_COOKIE]: token },
  });
  if (created.statusCode !== 201) throw new Error(`create failed: ${created.body}`);
  return { token, id: created.json<{ character: { id: string } }>().character.id };
}

const call = (
  p: Player | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers,
    ...(payload ? { payload } : {}),
    cookies: p ? { [SESSION_COOKIE]: p.token } : {},
  });

const board = async (p: Player) => {
  const res = await call(p, 'GET', `/api/characters/${p.id}/quests`);
  expect(res.statusCode).toBe(200);
  return res.json<QuestBoardResponse>();
};
const acceptStory = (p: Player, questId: string) =>
  call(p, 'POST', `/api/characters/${p.id}/quests`, { kind: 'story', questId });
const acceptContract = (p: Player, slot: number) =>
  call(p, 'POST', `/api/characters/${p.id}/quests`, { kind: 'contract', slot });
const turnIn = (p: Player, questRowId: string, key?: string) =>
  call(
    p,
    'POST',
    `/api/characters/${p.id}/quests/${questRowId}/turn-in`,
    undefined,
    key ? { 'idempotency-key': key } : {},
  );
const startFarming = (p: Player, areaId = 'abandonedFields') =>
  call(p, 'POST', `/api/characters/${p.id}/activity`, { areaId });

async function characterRow(id: string) {
  const [c] = await database.db.select().from(characters).where(eq(characters.id, id));
  return c!;
}

async function turnInAudits(id: string) {
  return database.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.characterId, id), eq(auditLog.event, 'quest.turn_in')));
}

function questOf(b: QuestBoardResponse, questId: string): QuestView {
  const q = b.quests.find((x) => x.questId === questId);
  if (!q) throw new Error(`quest ${questId} not on the board`);
  return q;
}

/** Marks the story chain before `questId` as turned in and sets the level (test setup only). */
async function skipStoryTo(p: Player, questIds: StoryQuestId[], level: number) {
  await database.db.update(characters).set({ level }).where(eq(characters.id, p.id));
  for (const questId of questIds) {
    await database.db.insert(characterQuests).values({
      id: uuidv7(),
      characterId: p.id,
      kind: 'story',
      questId,
      objectives: [],
      progress: [],
      reward: { xp: 0, gold: 0, materials: {}, item: null },
      status: 'turnedIn',
      acceptedAt: new Date(nowMs),
      turnedInAt: new Date(nowMs),
    });
  }
}

describe('quest board', () => {
  it('requires a session and the own character', async () => {
    const p = await newPlayer();
    const other = await newPlayer();
    expect((await call(null, 'GET', `/api/characters/${p.id}/quests`)).statusCode).toBe(401);
    expect((await call(other, 'GET', `/api/characters/${p.id}/quests`)).statusCode).toBe(404);
    expect(
      (await call(other, 'POST', `/api/characters/${p.id}/quests`, { kind: 'contract', slot: 0 }))
        .statusCode,
    ).toBe(404);
  });

  it('starts with the first story quest and three contracts for the day', async () => {
    const p = await newPlayer();
    const b = await board(p);
    expect(b.day).toBe('2026-11-04');
    expect(b.quests).toEqual([]);
    expect(b.story).toEqual({ next: { questId: 'furrowsOfTheDead', blockers: [] }, completed: [] });
    expect(b.contracts.offers).toHaveLength(3);
    expect(b.contracts.offers.every((o) => !o.accepted)).toBe(true);
    expect(b.contracts).toMatchObject({ perDay: 3, active: 0, maxActive: 3 });
  });
});

describe('accepting quests', () => {
  it('accepts the next story quest once, in chain order', async () => {
    const p = await newPlayer();
    const res = await acceptStory(p, 'furrowsOfTheDead');
    expect(res.statusCode).toBe(201);
    const b = res.json<QuestBoardResponse>();
    expect(questOf(b, 'furrowsOfTheDead')).toMatchObject({
      kind: 'story',
      progress: [0],
      status: 'active',
    });
    expect(b.story.next).toEqual({
      questId: 'wolvesAtTheFence',
      blockers: [
        { kind: 'quest', questId: 'furrowsOfTheDead' },
        { kind: 'level', required: 2 },
      ],
    });
    expect((await acceptStory(p, 'furrowsOfTheDead')).json()).toMatchObject({
      error: { code: 'quest_already_accepted' },
    });
    expect((await acceptStory(p, 'wolvesAtTheFence')).json()).toMatchObject({
      error: { code: 'quest_locked' },
    });
    expect((await acceptStory(p, 'theNamelessCrypt')).json()).toMatchObject({
      error: { code: 'quest_not_offered' },
    });
    expect((await acceptStory(p, 'noSuchQuest')).statusCode).toBe(404);
    const bad = await call(p, 'POST', `/api/characters/${p.id}/quests`, {
      kind: 'contract',
      questId: 'furrowsOfTheDead',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('accepts each contract slot once a day and at most three at a time', async () => {
    const p = await newPlayer();
    expect((await acceptContract(p, 0)).statusCode).toBe(201);
    expect((await acceptContract(p, 0)).json()).toMatchObject({
      error: { code: 'quest_already_accepted' },
    });
    expect((await acceptContract(p, 1)).statusCode).toBe(201);
    const third = await acceptContract(p, 2);
    expect(third.statusCode).toBe(201);
    const b = third.json<QuestBoardResponse>();
    expect(b.contracts.active).toBe(3);
    expect(b.contracts.offers.every((o) => o.accepted)).toBe(true);
    expect((await acceptContract(p, 3)).statusCode).toBe(404);

    advance(24 * HOUR);
    const next = await board(p);
    expect(next.day).not.toBe(b.day);
    expect(next.contracts.offers.every((o) => !o.accepted)).toBe(true);
    expect((await acceptContract(p, 0)).json()).toMatchObject({
      error: { code: 'contract_limit' },
    });
  });
});

describe('progress and turn-in', () => {
  it('counts only kills after acceptance, from server settlements', async () => {
    const p = await newPlayer();
    expect((await startFarming(p)).statusCode).toBe(201);
    advance(HOUR);
    // Accepting settles first, so the hour before does not count.
    const accepted = await acceptStory(p, 'furrowsOfTheDead');
    expect(questOf(accepted.json(), 'furrowsOfTheDead').progress).toEqual([0]);
    advance(HOUR);
    await call(p, 'POST', `/api/characters/${p.id}/activity/settle`);
    const q = questOf(await board(p), 'furrowsOfTheDead');
    expect(q.progress).toEqual([12]);
    expect(q.status).toBe('ready');
  });

  it('turns in once with an Idempotency-Key and replays the stored response', async () => {
    const p = await newPlayer();
    await acceptStory(p, 'furrowsOfTheDead');
    const quest = questOf(await board(p), 'furrowsOfTheDead');
    expect((await turnIn(p, quest.id, 'early-key-0001')).json()).toMatchObject({
      error: { code: 'quest_incomplete' },
    });

    await startFarming(p);
    advance(HOUR);
    expect((await turnIn(p, quest.id)).json()).toMatchObject({
      error: { code: 'idempotency_key_required' },
    });
    expect((await turnIn(p, quest.id, 'bad key!')).json()).toMatchObject({
      error: { code: 'validation_failed' },
    });

    const before = await characterRow(p.id);
    const first = await turnIn(p, quest.id, 'turn-in-key-0001');
    expect(first.statusCode).toBe(200);
    const body = first.json<{
      reward: { xp: number; gold: number };
      character: { gold: number };
      quests: QuestBoardResponse;
    }>();
    expect(body.reward).toMatchObject({ xp: 600, gold: 40, item: null });
    expect(body.quests.story.completed).toEqual(['furrowsOfTheDead']);
    expect(body.quests.quests).toEqual([]);
    const after = await characterRow(p.id);
    // The turn-in settled the hour of farming first; the quest added its 40 gold on top.
    expect(after.gold).toBe(body.character.gold);
    expect(after.gold).toBeGreaterThanOrEqual(before.gold + 40);

    const replay = await turnIn(p, quest.id, 'turn-in-key-0001');
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(body);
    const again = await turnIn(p, quest.id, 'turn-in-key-0002');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'quest_already_turned_in' } });
    // The same key for another request is a conflict.
    const other = await turnIn(p, uuidv7(), 'turn-in-key-0001');
    expect(other.json()).toMatchObject({ error: { code: 'idempotency_conflict' } });

    expect((await characterRow(p.id)).gold).toBe(after.gold);
    expect(await turnInAudits(p.id)).toHaveLength(1);

    // After the retention window the key starts over; the state guard still holds.
    advance(25 * HOUR);
    expect((await turnIn(p, quest.id, 'turn-in-key-0001')).json()).toMatchObject({
      error: { code: 'quest_already_turned_in' },
    });
  });

  it('grants once when two turn-ins race (different keys)', async () => {
    const p = await newPlayer();
    await acceptStory(p, 'furrowsOfTheDead');
    await startFarming(p);
    advance(HOUR);
    const quest = questOf(await board(p), 'furrowsOfTheDead');
    const results = await Promise.all([
      turnIn(p, quest.id, 'race-key-aaaa'),
      turnIn(p, quest.id, 'race-key-bbbb'),
      turnIn(p, quest.id, 'race-key-aaaa'),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 409]);
    expect(await turnInAudits(p.id)).toHaveLength(1);
  });

  it('completes the Gravewarden step from a dungeon event and grants item and materials', async () => {
    const p = await newPlayer();
    await skipStoryTo(
      p,
      ['furrowsOfTheDead', 'wolvesAtTheFence', 'theCrowwoodRoad', 'whatTheCrowsGuard'],
      12,
    );
    expect((await acceptStory(p, 'theNamelessCrypt')).statusCode).toBe(201);
    const quest = questOf(await board(p), 'theNamelessCrypt');
    expect(quest.status).toBe('active');

    // What ticket 2.5's run claim will do, inside its transaction under the character lock.
    const changed = await withTransaction(database.db, (tx) =>
      recordQuestEventsTx(tx, p.id, [{ type: 'bossDefeated', bossId: 'gravewarden' }]),
    );
    expect(changed).toHaveLength(1);
    expect(questOf(await board(p), 'theNamelessCrypt').status).toBe('ready');

    const res = await turnIn(p, quest.id, 'crypt-key-0001');
    expect(res.statusCode).toBe(200);
    const reward = res.json<{
      reward: { levelsGained: number; item: { baseId: string; rarityId: string; source: string } };
    }>().reward;
    expect(reward.item).toMatchObject({
      baseId: 'raven-talisman',
      rarityId: 'epic',
      source: 'quest',
    });
    const items = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.characterId, p.id));
    expect(items).toHaveLength(1);
    const [shards] = await database.db
      .select()
      .from(characterMaterials)
      .where(
        and(
          eq(characterMaterials.characterId, p.id),
          eq(characterMaterials.materialId, 'soulShard'),
        ),
      );
    expect(shards?.quantity).toBe(10);
    expect((await board(p)).story).toEqual({
      next: null,
      completed: [
        'furrowsOfTheDead',
        'wolvesAtTheFence',
        'theCrowwoodRoad',
        'whatTheCrowsGuard',
        'theNamelessCrypt',
      ],
    });
  });

  it('refuses an item reward into a full pack without granting anything', async () => {
    const p = await newPlayer();
    await skipStoryTo(p, ['furrowsOfTheDead', 'wolvesAtTheFence', 'theCrowwoodRoad'], 9);
    await acceptStory(p, 'whatTheCrowsGuard');
    const quest = questOf(await board(p), 'whatTheCrowsGuard');
    await withTransaction(database.db, (tx) =>
      recordQuestEventsTx(tx, p.id, [
        { type: 'areaReached', areaId: 'oldBurialGrounds' },
        { type: 'enemyKilled', enemyId: 'risenSkeleton', count: 40 },
        { type: 'materialGathered', materialId: 'soulShard', count: 8 },
      ]),
    );
    const item = generateItem({ seed: 1, itemLevel: 5, baseId: 'brass-ring', rarityId: 'common' })!;
    await database.db.insert(itemInstances).values(
      Array.from({ length: options.rules.inventory.capacity }, () => ({
        id: uuidv7(),
        characterId: p.id,
        ...item,
        equippedSlot: null,
        source: 'test',
      })),
    );
    const before = await characterRow(p.id);
    const res = await turnIn(p, quest.id, 'full-pack-0001');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'inventory_full' } });
    expect((await characterRow(p.id)).gold).toBe(before.gold);
    expect(questOf(await board(p), 'whatTheCrowsGuard').status).toBe('ready');
  });
});

describe('targeted contract rewards (ticket 3.6)', () => {
  /** A level-20 hero past the Gravewarden, on a day whose board offers an Abbey contract. */
  async function abbeyHero() {
    const p = await newPlayer();
    await database.db
      .update(characters)
      .set({ level: 20, progress: { gravewardenDefeated: true } })
      .where(eq(characters.id, p.id));
    for (let day = 0; day < 20; day++) {
      const b = await board(p);
      const offer = b.contracts.offers.find((o) => o.rewardSlots.length > 0);
      if (offer) return { p, b, offer };
      advance(24 * HOUR);
    }
    throw new Error('no Abbey contract in 20 days');
  }

  it('Abbey contracts offer a slot choice; the chosen slot is fixed and the item granted once', async () => {
    const { p, b, offer } = await abbeyHero();
    expect(offer.templateId).toMatch(/^(slay|gather)\./);
    expect(offer.rewardSlots).toEqual(expect.arrayContaining(['head', 'neck', 'ring', 'weapon']));
    expect(offer.targetedReward).toEqual({ rarityId: 'epic', itemLevel: 20 });
    expect(offer.reward.item).toBeNull();
    for (const o of b.contracts.offers.filter((x) => x !== offer)) {
      expect(o.rewardSlots.length > 0).toBe(offersRewardSlot(findContractTemplate(o.templateId)!));
    }
    // Refused: a slot the contract does not offer, a slot on a story quest, a non-Abbey contract.
    const url = `/api/characters/${p.id}/quests`;
    expect(
      (
        await call(p, 'POST', url, { kind: 'contract', slot: offer.slot, rewardSlot: 'tail' })
      ).json(),
    ).toMatchObject({ error: { code: 'reward_slot_unavailable' } });
    expect(
      (
        await call(p, 'POST', url, {
          kind: 'story',
          questId: 'furrowsOfTheDead',
          rewardSlot: 'neck',
        })
      ).statusCode,
    ).toBe(400);
    const plain = b.contracts.offers.find((o) => o.rewardSlots.length === 0);
    if (plain) {
      expect(
        (
          await call(p, 'POST', url, { kind: 'contract', slot: plain.slot, rewardSlot: 'neck' })
        ).json(),
      ).toMatchObject({ error: { code: 'reward_slot_unavailable' } });
    }
    expect((await board(p)).contracts.active).toBe(0);

    const accepted = await call(p, 'POST', url, {
      kind: 'contract',
      slot: offer.slot,
      rewardSlot: 'neck',
    });
    expect(accepted.statusCode).toBe(201);
    const quest = accepted
      .json<QuestBoardResponse>()
      .quests.find((q) => q.questId === offer.templateId)!;
    expect(quest.reward.item).toEqual({
      slot: 'neck',
      rarityId: 'epic',
      itemLevel: 20,
      lootTableId: 'sunkenAbbey',
    });
    const [acceptAudit] = await database.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.characterId, p.id), eq(auditLog.event, 'quest.accept')));
    expect(acceptAudit!.data).toMatchObject({ rewardSlot: 'neck' });

    // Complete it (test setup), then turn in twice with different keys: one item, the fixed one.
    await database.db
      .update(characterQuests)
      .set({ progress: quest.objectives.map((o) => ('count' in o ? o.count : 1)) })
      .where(eq(characterQuests.id, quest.id));
    const [first, second] = await Promise.all([
      turnIn(p, quest.id, 'targeted-key-0001'),
      turnIn(p, quest.id, 'targeted-key-0002'),
    ]);
    const ok = [first, second].filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    const item = ok[0]!.json<{
      reward: { item: { baseId: string; rarityId: string; itemLevel: number } };
    }>().reward.item;
    expect(getItemBase(item.baseId).slot).toBe('neck');
    expect(item).toMatchObject({ rarityId: 'epic', itemLevel: 20 });
    const expected = generateTargetedItem(
      { slot: 'neck', rarityId: 'epic', itemLevel: 20, lootTableId: 'sunkenAbbey' },
      targetedRewardSeed(quest.id),
      'warrior',
    )!;
    const rows = await database.db
      .select()
      .from(itemInstances)
      .where(and(eq(itemInstances.characterId, p.id), eq(itemInstances.source, 'quest')));
    expect(rows).toHaveLength(1);
    expect([rows[0]!.baseId, rows[0]!.seed, rows[0]!.affixes]).toEqual([
      expected.baseId,
      expected.seed,
      expected.affixes,
    ]);
  });
});
