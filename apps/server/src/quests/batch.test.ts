import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS, type ActivityOptions } from '../activity/settle.js';
import { auditLog, characterQuests, characters } from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { createTestDatabase } from '../test/db.js';
import type { QuestBoardResponse } from './store.js';
import type { BatchTurnInResult } from './routes.js';
import { NAME_SAFE_LETTERS } from '../test/names.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let database: DatabaseHandle;
let app: FastifyInstance;
// The game clock, derived from the wall clock (CLAUDE.md "Dates").
let nowMs = Date.now();
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
    s = NAME_SAFE_LETTERS[n % NAME_SAFE_LETTERS.length]! + s;
    n = Math.floor(n / NAME_SAFE_LETTERS.length);
  } while (n > 0);
  return s;
}

async function newPlayer(): Promise<Player> {
  seq += 1;
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `batcher${seq}@graumark.test`,
      displayName: `Batcher ${seq}`,
      password: 'ashes-and-iron-42',
    },
  });
  const token = reg.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
  if (!token) throw new Error(`register failed: ${reg.statusCode}`);
  const created = await app.inject({
    method: 'POST',
    url: '/api/characters',
    payload: { name: `Batch${letters(seq)}`, classId: 'warrior', appearance: { banner: 'ash' } },
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

const batch = (p: Player, questIds: string[], key?: string, heroId = p.id) =>
  call(
    p,
    'POST',
    `/api/characters/${heroId}/quests/turn-in-batch`,
    { questIds },
    key ? { 'idempotency-key': key } : {},
  );

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

/** Marks a held quest complete (test setup: its objectives' targets as progress). */
async function complete(questRowId: string) {
  const [q] = await database.db
    .select()
    .from(characterQuests)
    .where(eq(characterQuests.id, questRowId));
  await database.db
    .update(characterQuests)
    .set({ progress: q!.objectives.map((o) => ('count' in o ? o.count : 1)) })
    .where(eq(characterQuests.id, questRowId));
}

/** A hero holding the first story quest and three contracts, all accepted (none complete). */
async function heldQuests() {
  const p = await newPlayer();
  expect((await acceptStory(p, 'furrowsOfTheDead')).statusCode).toBe(201);
  for (const slot of [0, 1, 2]) expect((await acceptContract(p, slot)).statusCode).toBe(201);
  const quests = (await board(p)).quests;
  expect(quests).toHaveLength(4);
  return { p, quests };
}

type BatchBody = {
  results: BatchTurnInResult[];
  quests: QuestBoardResponse;
  character: { gold: number; experience: number };
};

describe('claiming several Tavern rewards at once (ticket 8.5)', () => {
  it('turns in every ready quest once, each with its reward and audit', async () => {
    const { p, quests } = await heldQuests();
    for (const q of quests) await complete(q.id);
    const before = await characterRow(p.id);
    const res = await batch(
      p,
      quests.map((q) => q.id),
      'batch-key-0001',
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<BatchBody>();
    expect(body.results.map((r) => [r.questId, r.ok])).toEqual(quests.map((q) => [q.id, true]));
    const gold = quests.reduce((sum, q) => sum + q.reward.gold, 0);
    const after = await characterRow(p.id);
    expect(after.gold).toBe(before.gold + gold);
    expect(body.character.gold).toBe(after.gold);
    expect(body.quests.quests).toEqual([]);
    expect(body.quests.story.completed).toEqual(['furrowsOfTheDead']);
    expect(await turnInAudits(p.id)).toHaveLength(4);
  });

  it('reports each failure for its quest and pays the rest', async () => {
    const { p, quests } = await heldQuests();
    const [story, c1, c2, c3] = quests as [
      (typeof quests)[0],
      (typeof quests)[0],
      (typeof quests)[0],
      (typeof quests)[0],
    ];
    await complete(story.id);
    await complete(c2.id);
    // c3 was already turned in alone.
    await complete(c3.id);
    expect((await turnIn(p, c3.id, 'single-key-0001')).statusCode).toBe(200);
    const unknown = uuidv7();
    const before = await characterRow(p.id);
    const res = await batch(p, [story.id, c1.id, c2.id, c3.id, unknown], 'batch-key-0002');
    expect(res.statusCode).toBe(200);
    const { results } = res.json<BatchBody>();
    expect(results.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'ok',
      'quest_incomplete',
      'ok',
      'quest_already_turned_in',
      'not_found',
    ]);
    expect(results[1]).toMatchObject({ ok: false, status: 422 });
    expect((await characterRow(p.id)).gold).toBe(before.gold + story.reward.gold + c2.reward.gold);
    expect(await turnInAudits(p.id)).toHaveLength(3);
    // c1 stays on the board, held.
    expect((await board(p)).quests.map((q) => q.id)).toEqual([c1.id]);
  });

  it('replays a retried batch and never pays twice', async () => {
    const { p, quests } = await heldQuests();
    const [a, b] = quests as [(typeof quests)[0], (typeof quests)[0]];
    await complete(a.id);
    const first = await batch(p, [a.id, b.id], 'batch-key-0003');
    expect(first.json<BatchBody>().results.map((r) => r.ok)).toEqual([true, false]);
    const gold = (await characterRow(p.id)).gold;

    // The same key and body: the stored answer, even after b became ready.
    await complete(b.id);
    const replay = await batch(p, [a.id, b.id], 'batch-key-0003');
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect((await characterRow(p.id)).gold).toBe(gold);
    // The same key for another body is a conflict.
    expect((await batch(p, [b.id], 'batch-key-0003')).json()).toMatchObject({
      error: { code: 'idempotency_conflict' },
    });
    // A fresh key claims what is still ready; the one already paid is reported, not paid.
    const fresh = await batch(p, [a.id, b.id], 'batch-key-0004');
    expect(fresh.json<BatchBody>().results.map((r) => (r.ok ? 'ok' : r.code))).toEqual([
      'quest_already_turned_in',
      'ok',
    ]);
    expect((await characterRow(p.id)).gold).toBe(gold + b.reward.gold);
    expect(await turnInAudits(p.id)).toHaveLength(2);
  });

  it('resumes a batch cut off part-way without paying the finished part again', async () => {
    const { p, quests } = await heldQuests();
    for (const q of quests) await complete(q.id);
    const ids = quests.map((q) => q.id);
    // A first attempt reached only its first two quests (as if the connection dropped): the
    // same per-quest keys a batch with this key uses.
    const { batchItemKey, requestHash, runIdempotent } = await import('../idempotency/index.js');
    const { turnInQuestTx } = await import('./store.js');
    const hash = requestHash('POST', `/api/characters/${p.id}/quests/turn-in-batch`, {
      questIds: ids,
    });
    const accountId = (await characterRow(p.id)).accountId;
    for (const id of ids.slice(0, 2)) {
      await runIdempotent(
        database.db,
        { accountId, key: batchItemKey('batch-key-0005', id), hash, now: options.now },
        async (tx) => {
          const [hero] = await tx
            .select()
            .from(characters)
            .where(eq(characters.id, p.id))
            .for('update');
          const out = await turnInQuestTx(tx, hero!, id, {
            inventoryCapacity: options.rules.inventory.capacity,
            now: options.now(),
            world: await app.worldState.flags(),
            switches: await app.gameSettings.tradingSwitches(),
          });
          return { reward: out.reward as unknown };
        },
      );
    }
    const gold = (await characterRow(p.id)).gold;
    const res = await batch(p, ids, 'batch-key-0005');
    const { results } = res.json<BatchBody>();
    // All four report success: two replayed from their stored answers, two run now.
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await characterRow(p.id)).gold).toBe(
      gold + quests.slice(2).reduce((s, q) => s + q.reward.gold, 0),
    );
    expect(await turnInAudits(p.id)).toHaveLength(4);
  });

  it("refuses without a key, for another account's hero, and for malformed lists", async () => {
    const { p, quests } = await heldQuests();
    await complete(quests[0]!.id);
    expect((await batch(p, [quests[0]!.id])).json()).toMatchObject({
      error: { code: 'idempotency_key_required' },
    });
    const other = await newPlayer();
    const foreign = await batch(other, [quests[0]!.id], 'batch-key-0006', p.id);
    expect(foreign.statusCode).toBe(404);
    // Another hero's quest from one's own hero is "no such quest" and pays nothing.
    const mine = await batch(other, [quests[0]!.id], 'batch-key-0007');
    expect(mine.json<BatchBody>().results).toEqual([
      expect.objectContaining({ ok: false, code: 'not_found' }),
    ]);
    for (const questIds of [
      [],
      [quests[0]!.id, quests[0]!.id],
      ['nope'],
      Array(9).fill(uuidv7()),
    ]) {
      expect((await batch(p, questIds, `batch-bad-${questIds.length}-x`)).statusCode).toBe(400);
    }
    expect(await turnInAudits(p.id)).toHaveLength(0);
    expect(await turnInAudits(other.id)).toHaveLength(0);
  });
});
