/**
 * Ticket 5.1: `GET /api/characters/:id/scores` (docs/LEADERBOARDS.md). The scores come from the
 * hero's server rows through game-core's formulas: the route equals `computeScores` on the stored
 * input, a forged item row counts 0, the guild boss stage needs an earned reward of a week the hero
 * fought in, and another account's hero is a 404.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ITEM_BASES,
  canClassUseItem,
  computeScores,
  equipmentSlotsForKind,
  generateItem,
  type EquipmentSlotId,
  type Scores,
} from '@worldforge/game-core';
import { buildApp } from '../app.js';
import {
  characters,
  guildBossAttempts,
  guildBossRewards,
  itemInstances,
  type Character,
} from '../db/schema.js';
import type { DatabaseHandle } from '../db/types.js';
import { uuidv7 } from '../db/uuid.js';
import { itemEffectColumns } from '../inventory/columns.js';
import { createTestDatabase } from '../test/db.js';
import { insertGuild } from '../test/guilds.js';
import { insertCharacter } from '../test/heroes.js';
import { caller, insertAccount, type TestAccount } from '../test/social.js';
import { scoringInput } from './routes.js';

const WEEK = '2026-11-02';

describe('hero scores', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  let owner: TestAccount;
  let hero: Character;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({ database });
    await app.ready();
    call = caller(app);
    owner = await insertAccount(database.db);
    hero = await insertCharacter(database.db, owner.id, {
      classId: 'hunter',
      level: 22,
      progress: { gravewardenDefeated: true, cryptTierCleared: 2 },
    });
    // A real kit: one generated epic per slot the hunter can fill, at item level 21.
    const taken = new Set<string>();
    let seed = 7;
    for (const base of ITEM_BASES.filter(
      (b) => !b.unique && b.minItemLevel <= 21 && canClassUseItem(b, 'hunter'),
    ).sort((a, b) => b.tier - a.tier)) {
      if (taken.has(base.slot)) continue;
      taken.add(base.slot);
      for (const slot of equipmentSlotsForKind(base.slot)) {
        const item = generateItem({
          seed: seed++,
          itemLevel: 21,
          baseId: base.id,
          rarityId: 'epic',
        })!;
        await database.db.insert(itemInstances).values({
          id: uuidv7(),
          characterId: hero.id,
          baseId: item.baseId,
          rarityId: item.rarityId,
          itemLevel: item.itemLevel,
          affixes: item.affixes,
          seed: item.seed,
          equippedSlot: slot as EquipmentSlotId,
          source: 'test',
          upgradeLevel: 4,
          ...itemEffectColumns(item),
        });
      }
    }
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const scoresOf = async (who: TestAccount, id: string) => {
    const res = await call(who, 'GET', `/api/characters/${id}/scores`);
    return { status: res.statusCode, scores: (res.json() as { scores: Scores }).scores };
  };

  it('returns the four scores computed from the hero’s server state', async () => {
    const { status, scores } = await scoresOf(owner, hero.id);
    expect(status).toBe(200);
    const [row] = await database.db.select().from(characters).where(eq(characters.id, hero.id));
    expect(scores).toEqual(computeScores(await scoringInput(app, database.db, row!)));
    expect(scores.level.sortKey).toEqual([22, 0]);
    expect(scores.gearScore.lines.every((l) => l.counted)).toBe(true);
    expect(scores.gearScore.value).toBeGreaterThan(0);
    expect(scores.power.value).toBeGreaterThan(0);
    expect(scores.pveProgress.sortKey).toEqual([7, 7, 0]);
    // The same value on the next call.
    expect((await scoresOf(owner, hero.id)).scores).toEqual(scores);
  });

  it('a forged item row counts 0 and does not fight', async () => {
    const before = (await scoresOf(owner, hero.id)).scores;
    const [weapon] = await database.db
      .select()
      .from(itemInstances)
      .where(eq(itemInstances.equippedSlot, 'weapon'));
    const forged = weapon!.affixes.map((a) => ({ ...a, value: a.value * 40 }));
    await database.db
      .update(itemInstances)
      .set({ affixes: forged })
      .where(eq(itemInstances.id, weapon!.id));
    const after = (await scoresOf(owner, hero.id)).scores;
    const line = after.gearScore.lines.find((l) => l.id === 'weapon')!;
    expect(line).toMatchObject({ counted: false, points: 0, reason: 'invalid_item' });
    expect(after.gearScore.value).toBeLessThan(before.gearScore.value);
    expect(after.power.value).toBeLessThan(before.power.value);
    await database.db
      .update(itemInstances)
      .set({ affixes: weapon!.affixes })
      .where(eq(itemInstances.id, weapon!.id));
    expect((await scoresOf(owner, hero.id)).scores).toEqual(before);
  });

  it('counts a guild boss stage only from a week the hero fought in and the account earned', async () => {
    const fighter = await insertCharacter(database.db, owner.id, {
      level: 22,
      progress: { gravewardenDefeated: true, cryptTierCleared: 2 },
    });
    const other = await insertCharacter(database.db, owner.id, { level: 12 });
    const guild = await insertGuild(database.db, owner.id);
    const attempt = (characterId: string, week: string, no: number) =>
      database.db.insert(guildBossAttempts).values({
        id: uuidv7(),
        accountId: owner.id,
        week,
        attemptNo: no,
        guildId: guild.id,
        characterId,
        bossId: 'risenGravewarden',
        snapshot: { classId: 'hunter', level: 22, xp: 0, equipment: [] },
        damage: 100,
        counted: 100,
        end: 'fell',
        durationMs: 1000,
      });
    const reward = (week: string, stage: number, status: 'earned' | 'pending') =>
      database.db.insert(guildBossRewards).values({
        accountId: owner.id,
        week,
        stage,
        guildId: guild.id,
        bossId: 'risenGravewarden',
        status,
        gold: 1,
        materials: {},
        earnedAt: status === 'earned' ? new Date() : null,
      });
    // Week 1: the other hero fought; stage 3 earned. Not this hero's.
    await attempt(other.id, WEEK, 1);
    await reward(WEEK, 3, 'earned');
    expect((await scoresOf(owner, fighter.id)).scores.pveProgress.sortKey[2]).toBe(0);
    expect((await scoresOf(owner, other.id)).scores.pveProgress.sortKey[2]).toBe(3);
    // Week 2: this hero fought; stage 2 earned, stage 4 only pending.
    await attempt(fighter.id, '2026-11-09', 1);
    await reward('2026-11-09', 2, 'earned');
    await reward('2026-11-09', 4, 'pending');
    const pve = (await scoresOf(owner, fighter.id)).scores.pveProgress;
    expect(pve.sortKey).toEqual([7, 7, 2]);
    expect(pve.lines.at(-1)!.detail).toMatch(/^Stage 2 of 5, Staggered/);
  });

  it('is a 404 for another account’s hero and needs a session', async () => {
    const stranger = await insertAccount(database.db);
    expect((await call(stranger, 'GET', `/api/characters/${hero.id}/scores`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', `/api/characters/${uuidv7()}/scores`)).statusCode).toBe(404);
    expect((await call(null, 'GET', `/api/characters/${hero.id}/scores`)).statusCode).toBe(401);
    expect((await call(owner, 'GET', `/api/characters/not-a-uuid/scores`)).statusCode).toBe(400);
  });
});
