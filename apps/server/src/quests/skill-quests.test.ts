import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  validateItem,
  type ClassId,
  type GeneratedItem,
  type MaterialId,
  type WorldProgress,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import { SESSION_COOKIE } from '../auth/index.js';
import { DEFAULT_ACTIVITY_OPTIONS } from '../activity/settle.js';
import {
  accounts,
  auditLog,
  characterMaterials,
  characters,
  itemInstances,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { withTransaction } from '../db/transaction.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter } from '../test/heroes.js';
import { insertAccount, type TestAccount } from '../test/social.js';
import { recordQuestEventsTx, type QuestBoardResponse } from './store.js';

/**
 * Ticket 9.3: the skill quests (docs/QUESTS.md "Skill quests"): accept, a boss kill, an older
 * boss's material paid at the turn-in, the deed flag, the reward, idempotency and the audit; and
 * migration 0049's backfill (9.2's kill-flag skills kept), run twice.
 */

const DAY = 86_400_000;
// Derived from the wall clock (CLAUDE.md "Dates").
let nowMs = Math.floor(Date.now() / DAY) * DAY + DAY / 2;
const now = () => new Date(nowMs);

let database: DatabaseHandle;
let app: FastifyInstance;
const db = () => database.db;

beforeAll(async () => {
  database = await createTestDatabase();
  app = buildApp({
    database,
    auth: { now, socialWriteLimit: { windows: [{ windowMs: 60_000, max: 100_000 }] } },
    activity: { ...DEFAULT_ACTIVITY_OPTIONS, now },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await database?.close();
});

type Hero = { who: TestAccount; hero: Character };

async function hero(classId: ClassId, level: number, progress: WorldProgress): Promise<Hero> {
  const who = await insertAccount(db(), { now: now() });
  const h = await insertCharacter(db(), who.id, { classId, level, progress });
  await db().update(accounts).set({ activeCharacterId: h.id }).where(eq(accounts.id, who.id));
  return { who, hero: h };
}

function call(
  who: TestAccount,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: object,
  key: string = randomUUID(),
) {
  return app.inject({
    method,
    url: `/api${url}`,
    ...(payload ? { payload } : {}),
    headers: { 'idempotency-key': key },
    cookies: { [SESSION_COOKIE]: who.token },
  });
}
const board = async (p: Hero) => {
  const res = await call(p.who, 'GET', `/characters/${p.hero.id}/quests`);
  expect(res.statusCode).toBe(200);
  return res.json<QuestBoardResponse>();
};
const accept = (p: Hero, questId: string) =>
  call(p.who, 'POST', `/characters/${p.hero.id}/quests`, { kind: 'skill', questId });
const turnIn = (p: Hero, rowId: string, key?: string) =>
  call(p.who, 'POST', `/characters/${p.hero.id}/quests/${rowId}/turn-in`, undefined, key);
const give = (p: Hero, materialId: MaterialId, quantity: number) =>
  db()
    .insert(characterMaterials)
    .values({ characterId: p.hero.id, materialId, quantity, updatedAt: now() })
    .onConflictDoUpdate({
      target: [characterMaterials.characterId, characterMaterials.materialId],
      set: { quantity },
    });
const held = async (p: Hero, materialId: MaterialId) =>
  (
    await db()
      .select()
      .from(characterMaterials)
      .where(
        and(
          eq(characterMaterials.characterId, p.hero.id),
          eq(characterMaterials.materialId, materialId),
        ),
      )
  )[0]?.quantity ?? 0;
/** A boss kill as the dungeon claim records it (under the character lock). */
const felled = (p: Hero, bossId: 'forgeTyrant' | 'hollowSovereign', acceptedBy?: Date) =>
  withTransaction(db(), async (tx) => {
    await tx.select().from(characters).where(eq(characters.id, p.hero.id)).for('update');
    await recordQuestEventsTx(tx, p.hero.id, [{ type: 'bossDefeated', bossId }], {
      ...(acceptedBy ? { acceptedBy } : {}),
    });
  });
const progressOf = async (p: Hero) =>
  (await db().select().from(characters).where(eq(characters.id, p.hero.id)))[0]!
    .progress as WorldProgress;
const saveForgebreaker = (p: Hero) =>
  call(p.who, 'PUT', `/characters/${p.hero.id}/skills/presets/1`, {
    actives: ['heavyStrike', 'forgebreaker', null],
    passive: null,
  });

const WARDEN: WorldProgress = { gravewardenDefeated: true, cryptTierCleared: 4 };

describe('skill quests at the Tavern', () => {
  it('are on the board with the class’s skill, the cost and what still blocks them', async () => {
    const p = await hero('warrior', 30, WARDEN);
    const b = await board(p);
    expect(b.skills.map((s) => [s.questId, s.state, s.skill.id])).toEqual([
      ['theTyrantsLesson', 'locked', 'forgebreaker'],
      ['theSovereignsLesson', 'locked', 'hollowWrath'],
    ]);
    expect(b.skills[0]!.blockers).toEqual([{ kind: 'level', required: 36 }]);
    expect(b.skills[0]!.cost).toEqual({ gravewardenSeal: 2 });
    expect(b.skills[0]!.missing).toEqual({ gravewardenSeal: 2 });
    expect((await accept(p, 'theTyrantsLesson')).statusCode).toBe(422);
    expect((await accept(p, 'nope')).statusCode).toBe(404);
    const mage = await hero('mage', 46, WARDEN);
    const mb = await board(mage);
    expect(mb.skills.map((s) => [s.state, s.skill.id])).toEqual([
      ['available', 'emberstorm'],
      ['available', 'kindling'],
    ]);
  });

  it('teach the skill once: a fresh boss kill and the older boss’s material, paid at the turn-in', async () => {
    const p = await hero('warrior', 40, { ...WARDEN, forgeTyrantDefeated: true });
    // 9.2's kill flag alone no longer teaches it.
    expect((await saveForgebreaker(p)).json().error.code).toBe('invalid_loadout');
    // A kill before the quest was taken does not count (a run that started before it).
    const before = now();
    nowMs += 60_000;
    const res = await accept(p, 'theTyrantsLesson');
    expect(res.statusCode).toBe(201);
    expect((await accept(p, 'theTyrantsLesson')).statusCode).toBe(409);
    const row = (await board(p)).skills[0]!;
    expect(row.state).toBe('active');
    await felled(p, 'forgeTyrant', before);
    expect((await turnIn(p, row.questRowId!)).json().error.code).toBe('quest_incomplete');
    // The wrong boss does not count either.
    await felled(p, 'hollowSovereign');
    expect((await turnIn(p, row.questRowId!)).json().error.code).toBe('quest_incomplete');
    await felled(p, 'forgeTyrant');
    // Without the seals nothing is paid or granted.
    await give(p, 'gravewardenSeal', 1);
    const short = await turnIn(p, row.questRowId!);
    expect(short.statusCode).toBe(422);
    expect(short.json().error).toMatchObject({
      code: 'quest_materials_missing',
      details: { missing: { gravewardenSeal: 1 } },
    });
    expect(await held(p, 'gravewardenSeal')).toBe(1);
    expect((await progressOf(p)).forgeTyrantSkillLearned).toBeUndefined();

    await give(p, 'gravewardenSeal', 3);
    const key = randomUUID();
    const done = await turnIn(p, row.questRowId!, key);
    expect(done.statusCode).toBe(200);
    const body = done.json<{
      quests: QuestBoardResponse;
      reward: { item: { id: string; baseId: string } };
    }>();
    expect(body.quests.skills[0]).toMatchObject({ state: 'turnedIn', learned: true });
    expect(await held(p, 'gravewardenSeal')).toBe(1);
    expect((await progressOf(p)).forgeTyrantSkillLearned).toBe(true);
    // The reward: a valid Legendary piece of the Masters' Lessons with a skill-aware effect.
    const [item] = await db()
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.id, body.reward.item.id));
    expect(item).toMatchObject({
      baseId: 'masters-ember-band',
      rarityId: 'legendary',
      setId: 'masters-lessons',
      source: 'quest',
      binding: 'account',
    });
    expect(['practiced-hand', 'festering-craft', 'deep-wellspring']).toContain(item!.effectId);
    const generated: GeneratedItem = {
      seed: item!.seed,
      baseId: item!.baseId,
      rarityId: item!.rarityId,
      itemLevel: item!.itemLevel,
      affixes: item!.affixes,
      setId: item!.setId!,
      effectId: item!.effectId!,
      effectRoll: item!.effectRoll!,
    };
    expect(validateItem(generated)).toEqual([]);

    // Idempotent: the same key replays, another key is refused; paid and granted once.
    const replay = await turnIn(p, row.questRowId!, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect((await turnIn(p, row.questRowId!)).json().error.code).toBe('quest_already_turned_in');
    expect(await held(p, 'gravewardenSeal')).toBe(1);
    const items = await db()
      .select()
      .from(itemInstances)
      .where(
        and(
          eq(itemInstances.characterId, p.hero.id),
          eq(itemInstances.baseId, 'masters-ember-band'),
        ),
      );
    expect(items).toHaveLength(1);
    // Audited, with what it taught and took.
    const audits = (
      await db().select().from(auditLog).where(eq(auditLog.event, 'quest.turn_in'))
    ).filter((a) => a.characterId === p.hero.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.data).toMatchObject({
      kind: 'skill',
      questId: 'theTyrantsLesson',
      teaches: 'forgeTyrantSkillLearned',
      skillId: 'forgebreaker',
      materialsPaid: { gravewardenSeal: 2 },
      learnedBefore: false,
    });
    // The skill can now be fielded.
    expect((await saveForgebreaker(p)).statusCode).toBe(200);
  });

  it('refuse a full pack and grant nothing', async () => {
    const p = await hero('hunter', 46, { ...WARDEN, hollowSovereignDefeated: true });
    const took = await accept(p, 'theSovereignsLesson');
    expect(took.statusCode, took.body).toBe(201);
    await felled(p, 'hollowSovereign');
    await give(p, 'tyrantsEmber', 2);
    const row = (await board(p)).skills[1]!;
    const rows = Array.from(
      { length: DEFAULT_ACTIVITY_OPTIONS.rules.inventory.capacity },
      (_, i) => ({
        id: randomUUID(),
        characterId: p.hero.id,
        baseId: 'iron-ring',
        rarityId: 'common' as const,
        itemLevel: 1,
        affixes: [],
        seed: i,
        equippedSlot: null,
        source: 'drop',
        createdAt: now(),
      }),
    );
    await db().insert(itemInstances).values(rows);
    const full = await turnIn(p, row.questRowId!);
    expect(full.json().error.code, full.body).toBe('inventory_full');
    expect(await held(p, 'tyrantsEmber')).toBe(2);
    expect((await progressOf(p)).hollowSovereignSkillLearned).toBeUndefined();
  });
});

describe('migration 0049: skills kept from 9.2’s kill flags', () => {
  const backfill = () => {
    const dir = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const file = readdirSync(dir).find((f) => f.startsWith('0049_'))!;
    // The data statements (after the index): the two `WITH kept AS (...)` blocks.
    return readFileSync(`${dir}${file}`, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.includes('WITH kept AS'));
  };
  const run = async () => {
    for (const statement of backfill()) await db().execute(sql.raw(statement));
  };

  it('keeps the skills of heroes who had felled the bosses, and a second run changes nothing', async () => {
    expect(backfill()).toHaveLength(2);
    const tyrant = await hero('warrior', 40, { ...WARDEN, forgeTyrantDefeated: true });
    const both = await hero('warlock', 50, {
      ...WARDEN,
      forgeTyrantDefeated: true,
      hollowSovereignDefeated: true,
    });
    const none = await hero('mage', 40, WARDEN);
    const kept = async () =>
      (await db().select().from(auditLog).where(eq(auditLog.event, 'skill.kept'))).filter((a) =>
        [tyrant, both, none].some((h) => h.hero.id === a.characterId),
      );
    await run();
    expect(await progressOf(tyrant)).toMatchObject({ forgeTyrantSkillLearned: true });
    expect((await progressOf(tyrant)).hollowSovereignSkillLearned).toBeUndefined();
    expect(await progressOf(both)).toMatchObject({
      forgeTyrantSkillLearned: true,
      hollowSovereignSkillLearned: true,
      // Nothing else in the progress moves.
      gravewardenDefeated: true,
      cryptTierCleared: 4,
    });
    expect(await progressOf(none)).toEqual(WARDEN);
    expect(await kept()).toHaveLength(3);
    // Twice: no flag moves, no second audit row.
    await run();
    expect(await kept()).toHaveLength(3);
    expect(await progressOf(none)).toEqual(WARDEN);
    // The kept skill is fielded; the quest can still be taken for its reward.
    expect((await saveForgebreaker(tyrant)).statusCode).toBe(200);
    const b = await board(tyrant);
    expect(b.skills[0]).toMatchObject({ state: 'available', learned: true });
  });
});
