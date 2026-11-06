import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { accountAchievements, auditLog, dataBackfills } from '../db/schema.js';
import { writeAudit } from '../db/audit.js';
import type { DatabaseHandle } from '../db/types.js';
import { createTestDatabase } from '../test/db.js';
import { insertCharacter, insertItem, insertTurnedInQuest } from '../test/heroes.js';
import { caller, insertAccount } from '../test/social.js';
import { refreshAchievements } from './award.js';
import { ACHIEVEMENT_BACKFILL_ID, backfillAchievements } from './backfill.js';

describe('achievements (ticket 4.2)', () => {
  let database: DatabaseHandle;
  let app: FastifyInstance;
  const now = new Date('2026-11-06T12:00:00Z');
  const db = () => database.db;

  beforeAll(async () => {
    database = await createTestDatabase();
    app = buildApp({ database });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
  });

  const awarded = async (accountId: string) =>
    (
      await db()
        .select()
        .from(accountAchievements)
        .where(eq(accountAchievements.accountId, accountId))
    )
      .map((a) => a.achievementId)
      .sort();
  const awardAudits = async (accountId: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.event, 'achievement.award')));

  it('awards from the facts an event names, once, with one audit row each', async () => {
    const acc = await insertAccount(db());
    const hero = await insertCharacter(db(), acc.id, { level: 12 });
    await insertItem(db(), hero.id, { rarityId: 'legendary' });

    // A hook that names only the level does not look at items.
    expect(await refreshAchievements(db(), hero, ['maxCharacterLevel'], now)).toEqual(['level10']);
    expect(await refreshAchievements(db(), hero, ['maxRarity'], now)).toEqual([
      'firstEpic',
      'firstLegendary',
    ]);
    // Again: nothing new, no new audit rows.
    expect(await refreshAchievements(db(), hero, ['maxRarity', 'maxCharacterLevel'], now)).toEqual(
      [],
    );
    expect(await awarded(acc.id)).toEqual(['firstEpic', 'firstLegendary', 'level10']);
    const audits = await awardAudits(acc.id);
    expect(audits.map((a) => a.data.achievementId).sort()).toEqual([
      'firstEpic',
      'firstLegendary',
      'level10',
    ]);
    expect(audits.every((a) => a.data.source === 'live' && a.characterId === hero.id)).toBe(true);
  });

  it('is account-bound: a second hero earns nothing the first already has', async () => {
    const acc = await insertAccount(db());
    const a = await insertCharacter(db(), acc.id, { level: 10 });
    const b = await insertCharacter(db(), acc.id, { level: 11 });
    expect(await refreshAchievements(db(), a, ['maxCharacterLevel'], now)).toEqual(['level10']);
    expect(await refreshAchievements(db(), b, ['maxCharacterLevel'], now)).toEqual([]);
    const [row] = await db()
      .select()
      .from(accountAchievements)
      .where(eq(accountAchievements.accountId, acc.id));
    expect(row!.characterId).toBe(a.id);
  });

  it('counts contracts across the account and story quests per hero', async () => {
    const acc = await insertAccount(db());
    const a = await insertCharacter(db(), acc.id);
    const b = await insertCharacter(db(), acc.id);
    for (let i = 0; i < 6; i++) await insertTurnedInQuest(db(), a.id, 'contract', 'cullTheDead', i);
    for (let i = 0; i < 3; i++) await insertTurnedInQuest(db(), b.id, 'contract', 'cullTheDead', i);
    expect(await refreshAchievements(db(), b, ['contractsTurnedIn'], now)).toEqual([]);
    await insertTurnedInQuest(db(), b.id, 'contract', 'cullTheDead', 3);
    expect(await refreshAchievements(db(), b, ['contractsTurnedIn'], now)).toEqual(['contracts10']);
    await insertTurnedInQuest(db(), a.id, 'story', 'theNamelessCrypt');
    expect(await refreshAchievements(db(), a, ['storyQuestsTurnedIn'], now)).toEqual([
      'storyGraumark',
    ]);
  });

  it('awards the full set when its last piece is equipped through the API', async () => {
    const acc = await insertAccount(db());
    const hero = await insertCharacter(db(), acc.id, { level: 30 });
    const pieces: [string, string][] = [
      ['vigil-helm', 'head'],
      ['vigil-hauberk', 'chest'],
      ['vigil-gauntlets', 'hands'],
      ['vigil-sabatons', 'feet'],
      ['vigil-oath-chain', 'amulet'],
    ];
    for (const [baseId, slot] of pieces) {
      await insertItem(db(), hero.id, {
        baseId,
        rarityId: 'legendary',
        setId: 'drowned-vigil',
        equippedSlot: slot as never,
      });
    }
    const call = caller(app);
    expect(await refreshAchievements(db(), hero, ['fullSetWorn'], now)).toEqual([]);
    const ring = await insertItem(db(), hero.id, {
      baseId: 'vigil-seal',
      rarityId: 'legendary',
      setId: 'drowned-vigil',
    });
    const res = await call(acc, 'POST', `/api/characters/${hero.id}/items/${ring.id}/equip`, {});
    expect(res.statusCode).toBe(200);
    expect(await awarded(acc.id)).toEqual(['fullSet']);
  });

  it('backfills from state and audit history, exactly once', async () => {
    const acc = await insertAccount(db());
    const hero = await insertCharacter(db(), acc.id, {
      level: 21,
      progress: { gravewardenDefeated: true, cryptTierCleared: 3 },
    });
    await insertItem(db(), hero.id, { rarityId: 'epic', upgradeLevel: 4 });
    await insertTurnedInQuest(db(), hero.id, 'story', 'theNamelessCrypt');
    // History the state lost: a sold Legendary, an item once at +10 (since salvaged).
    await writeAudit(db(), {
      event: 'merchant.sell',
      accountId: acc.id,
      characterId: hero.id,
      data: { items: [{ itemId: 'x', baseId: 'longsword', rarityId: 'legendary' }] },
    });
    await writeAudit(db(), {
      event: 'forge.upgrade',
      accountId: acc.id,
      characterId: hero.id,
      data: { fromLevel: 9, toLevel: 10, success: true },
    });
    // Auto-salvaged by the loot filter: never owned, does not count.
    await writeAudit(db(), {
      event: 'activity.reward',
      accountId: acc.id,
      characterId: hero.id,
      data: { notableItems: [], filtered: { items: [{ rarityId: 'mythic' }] } },
    });
    // Already awarded live before the backfill: not awarded again.
    await refreshAchievements(db(), hero, ['maxCharacterLevel'], now);

    const first = await backfillAchievements(db(), { now: () => now, force: true });
    expect(first.ran).toBe(true);
    expect(await awarded(acc.id)).toEqual(
      [
        'cryptTier2',
        'cryptTier3',
        'firstEpic',
        'firstLegendary',
        'forgePlus10',
        'forgePlus5',
        'gravewardenSlain',
        'level10',
        'level20',
        'storyGraumark',
      ].sort(),
    );
    const audits = await awardAudits(acc.id);
    expect(audits).toHaveLength(10);
    expect(audits.filter((a) => a.data.source === 'backfill')).toHaveLength(8);

    // Recorded once per database; a forced re-run awards nothing new.
    const [marker] = await db()
      .select()
      .from(dataBackfills)
      .where(eq(dataBackfills.id, ACHIEVEMENT_BACKFILL_ID));
    expect(marker).toBeDefined();
    expect((await backfillAchievements(db(), { now: () => now })).ran).toBe(false);
    await backfillAchievements(db(), { now: () => now, force: true, batch: 2 });
    expect(await awardAudits(acc.id)).toHaveLength(10);
  });

  it('a backfill over accounts without progress awards nothing', async () => {
    const acc = await insertAccount(db());
    await insertCharacter(db(), acc.id);
    await backfillAchievements(db(), { now: () => now, force: true });
    expect(await awarded(acc.id)).toEqual([]);
  });
});
