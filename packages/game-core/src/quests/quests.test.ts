import { describe, expect, it } from 'vitest';
import { settleFarming } from '../activity/settle.js';
import { findItemBase } from '../items/bases.js';
import { RARITY_IDS } from '../rarity.js';
import { AREA_IDS, isAreaId } from '../world/areas.js';
import { getEnemy, isEnemyId } from '../world/enemies.js';
import { isMaterialId } from '../world/materials.js';
import { worldFlagsFrom } from '../world/projects.js';
import {
  CONTRACTS_PER_DAY,
  CONTRACT_TEMPLATES,
  STORY_QUESTS,
  STORY_QUEST_IDS,
  applyQuestEvents,
  contractAreaBlockers,
  contractDay,
  contractReward,
  dailyContracts,
  findContractTemplate,
  initialProgress,
  isQuestComplete,
  nextStoryOffer,
  questEventsFromSettlement,
  type QuestEvent,
  type QuestObjective,
  type StoryQuestId,
  isTargetedItemReward,
  offersRewardSlot,
  targetedRewardSlots,
  targetedRewardSeed,
  generateTargetedItem,
} from './index.js';
import { CLASS_IDS } from '../classes.js';
import { canClassUseItem, getItemBase } from '../items/bases.js';
import { validateItem } from '../loot/validate.js';

function checkObjective(o: QuestObjective): void {
  switch (o.kind) {
    case 'kill':
      expect(isEnemyId(o.enemyId)).toBe(true);
      expect(o.count).toBeGreaterThan(0);
      break;
    case 'gather':
      expect(isMaterialId(o.materialId)).toBe(true);
      expect(o.count).toBeGreaterThan(0);
      break;
    case 'reach':
      expect(isAreaId(o.areaId)).toBe(true);
      break;
    case 'defeatBoss':
      expect(getEnemy(o.bossId).rank).toBe('boss');
      break;
  }
}

describe('quest content', () => {
  it('story quests reference existing content and form one chain', () => {
    expect(STORY_QUESTS.map((q) => q.id)).toEqual([...STORY_QUEST_IDS]);
    STORY_QUESTS.forEach((q, i) => {
      expect(q.after).toBe(i === 0 ? null : STORY_QUESTS[i - 1]!.id);
      expect(q.objectives.length).toBeGreaterThan(0);
      q.objectives.forEach(checkObjective);
      if (i > 0) expect(q.level).toBeGreaterThanOrEqual(STORY_QUESTS[i - 1]!.level);
      expect(q.reward.xp).toBeGreaterThan(0);
      for (const id of Object.keys(q.reward.materials)) expect(isMaterialId(id)).toBe(true);
      expect(isTargetedItemReward(q.reward.item)).toBe(false);
      if (q.reward.item && !isTargetedItemReward(q.reward.item)) {
        const base = findItemBase(q.reward.item.baseId);
        expect(base).toBeDefined();
        expect(RARITY_IDS).toContain(q.reward.item.rarityId);
        expect(q.reward.item.itemLevel).toBeGreaterThanOrEqual(base!.minItemLevel);
        // Reward items must be usable by every class.
        expect(base!.classes.length).toBe(4);
      }
    });
  });

  it('the chain leads to the crypt: its last step is defeating the Gravewarden', () => {
    const last = STORY_QUESTS.at(-1)!;
    expect(last.objectives).toEqual([{ kind: 'defeatBoss', bossId: 'gravewarden' }]);
  });

  it('contract templates have unique ids and valid objectives in every area', () => {
    const ids = CONTRACT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    CONTRACT_TEMPLATES.forEach((t) => checkObjective(t.objective));
    for (const area of AREA_IDS) {
      expect(CONTRACT_TEMPLATES.some((t) => t.areaId === area)).toBe(true);
    }
    expect(findContractTemplate('slay.risenFarmhand')?.areaId).toBe('abandonedFields');
    expect(findContractTemplate('slay.gravewarden')).toBeUndefined();
  });
});

describe('quest progress from events', () => {
  const objectives: QuestObjective[] = [
    { kind: 'kill', enemyId: 'risenFarmhand', count: 10 },
    { kind: 'gather', materialId: 'timber', count: 5 },
    { kind: 'reach', areaId: 'crowwood' },
    { kind: 'defeatBoss', bossId: 'gravewarden' },
  ];

  it('advances matching objectives and caps them at the target', () => {
    let p = initialProgress(objectives);
    p = applyQuestEvents(objectives, p, [
      { type: 'enemyKilled', enemyId: 'risenFarmhand', count: 7 },
      { type: 'enemyKilled', enemyId: 'carrionWolf', count: 50 },
      { type: 'materialGathered', materialId: 'timber', count: 9 },
      { type: 'areaReached', areaId: 'abandonedFields' },
    ]);
    expect(p).toEqual([7, 5, 0, 0]);
    p = applyQuestEvents(objectives, p, [
      { type: 'enemyKilled', enemyId: 'risenFarmhand', count: 7 },
      { type: 'areaReached', areaId: 'crowwood' },
      { type: 'areaReached', areaId: 'crowwood' },
    ]);
    expect(p).toEqual([10, 5, 1, 0]);
    expect(isQuestComplete(objectives, p)).toBe(false);
  });

  it('completes the Gravewarden step from a dungeon bossDefeated event (ticket 2.5 shape)', () => {
    const event: QuestEvent = { type: 'bossDefeated', bossId: 'gravewarden' };
    const crypt = STORY_QUESTS.find((q) => q.id === 'theNamelessCrypt')!;
    const p = applyQuestEvents(crypt.objectives, initialProgress(crypt.objectives), [event]);
    expect(isQuestComplete(crypt.objectives, p)).toBe(true);
    // Other bosses or normal kills of the boss id do not count.
    const other = applyQuestEvents(
      crypt.objectives,
      [0],
      [{ type: 'enemyKilled', enemyId: 'gravewarden', count: 1 }],
    );
    expect(other).toEqual([0]);
  });

  it('ignores negative or fractional counts', () => {
    const p = applyQuestEvents(
      objectives,
      [3, 0, 0, 0],
      [
        { type: 'enemyKilled', enemyId: 'risenFarmhand', count: -5 },
        { type: 'materialGathered', materialId: 'timber', count: 1.9 },
      ],
    );
    expect(p).toEqual([3, 1, 0, 0]);
  });

  it('settlement events: area reached only after a committed cycle', () => {
    expect(
      questEventsFromSettlement({
        startAreaId: 'abandonedFields',
        endAreaId: 'abandonedFields',
        encounters: 0,
        killsByEnemy: {},
        materials: {},
      }),
    ).toEqual([]);
    expect(
      questEventsFromSettlement({
        startAreaId: 'abandonedFields',
        endAreaId: 'crowwood',
        encounters: 3,
        killsByEnemy: { carrionWolf: 2, risenFarmhand: 0 },
        materials: { timber: 1 },
      }),
    ).toEqual([
      { type: 'areaReached', areaId: 'abandonedFields' },
      { type: 'areaReached', areaId: 'crowwood' },
      { type: 'enemyKilled', enemyId: 'carrionWolf', count: 2 },
      { type: 'materialGathered', materialId: 'timber', count: 1 },
    ]);
  });

  it('progress from farming does not depend on how often it is settled (invariance)', () => {
    const quest: QuestObjective[] = [
      { kind: 'kill', enemyId: 'risenFarmhand', count: 1000 },
      { kind: 'kill', enemyId: 'carrionWolf', count: 1000 },
      { kind: 'gather', materialId: 'timber', count: 1000 },
      { kind: 'gather', materialId: 'ashwort', count: 6 },
      { kind: 'reach', areaId: 'abandonedFields' },
    ];
    const totalMs = 40 * 60 * 1000;
    const base = {
      character: { classId: 'warrior' as const, level: 4, xp: 0 },
      areaId: 'abandonedFields' as const,
      seed: 'quest-invariance',
      inventoryCount: 0,
    };

    function run(chunkMs: number): number[] {
      let progress = initialProgress(quest);
      let cycle = 0;
      let carry = 0;
      let level = base.character.level;
      let xp = base.character.xp;
      let health: number | undefined;
      let professions;
      for (let t = 0; t < totalMs; t += chunkMs) {
        const s = settleFarming({
          ...base,
          character: { classId: 'warrior', level, xp, ...(health !== undefined ? { health } : {}) },
          firstCycle: cycle,
          durationMs: carry + Math.min(chunkMs, totalMs - t),
          ...(professions ? { professions } : {}),
        });
        cycle += s.encounters;
        carry = s.unusedMs;
        level = s.level;
        xp = s.xp;
        health = s.health;
        professions = s.professions;
        progress = applyQuestEvents(
          quest,
          progress,
          questEventsFromSettlement({
            startAreaId: base.areaId,
            endAreaId: s.areaId,
            encounters: s.encounters,
            killsByEnemy: s.killsByEnemy,
            materials: s.materials,
          }),
        );
      }
      return progress;
    }

    const once = run(totalMs);
    expect(once[0]).toBeGreaterThan(0);
    expect(once[4]).toBe(1);
    expect(run(60 * 1000)).toEqual(once);
    expect(run(7 * 60 * 1000 + 13)).toEqual(once);
  });
});

describe('notice board', () => {
  const none = { accepted: new Set<StoryQuestId>(), turnedIn: new Set<StoryQuestId>() };

  it('offers the next story quest in chain order with its blockers', () => {
    expect(nextStoryOffer(1, none)).toEqual({ quest: STORY_QUESTS[0], blockers: [] });
    const afterFirstAccepted = {
      accepted: new Set<StoryQuestId>(['furrowsOfTheDead']),
      turnedIn: new Set<StoryQuestId>(),
    };
    expect(nextStoryOffer(1, afterFirstAccepted)?.blockers).toEqual([
      { kind: 'quest', questId: 'furrowsOfTheDead' },
      { kind: 'level', required: 2 },
    ]);
    const all = new Set<StoryQuestId>(STORY_QUEST_IDS);
    expect(nextStoryOffer(30, { accepted: all, turnedIn: all })).toBeNull();
  });

  it('picks the same contracts for the same character and day, distinct per slot', () => {
    const a = dailyContracts('char-1', '2026-11-04', 1, { gravewardenDefeated: false });
    const b = dailyContracts('char-1', '2026-11-04', 1, { gravewardenDefeated: false });
    expect(a).toEqual(b);
    expect(a).toHaveLength(CONTRACTS_PER_DAY);
    expect(new Set(a.map((o) => o.template.id)).size).toBe(CONTRACTS_PER_DAY);
    expect(a.map((o) => o.slot)).toEqual([0, 1, 2]);
    // Level 1 only has the Abandoned Fields.
    expect(a.every((o) => o.template.areaId === 'abandonedFields')).toBe(true);
  });

  it('changes contracts with the day and only offers unlocked areas', () => {
    const days = ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
    const picks = days.map((d) =>
      dailyContracts('char-1', d, 20, { gravewardenDefeated: false })
        .map((o) => o.template.id)
        .join(),
    );
    expect(new Set(picks).size).toBeGreaterThan(1);
    for (const d of days) {
      for (const o of dailyContracts('char-2', d, 20, { gravewardenDefeated: false })) {
        expect(o.template.areaId).not.toBe('sunkenAbbey');
      }
    }
  });

  it('contract rewards scale with level and the UTC day is the contract day', () => {
    const t = findContractTemplate('slay.risenFarmhand')!;
    expect(contractReward(t, 10).xp).toBeGreaterThan(contractReward(t, 2).xp);
    expect(contractReward(t, 10).gold).toBeGreaterThan(contractReward(t, 2).gold);
    expect(contractDay(new Date('2026-11-04T23:59:59.999Z'))).toBe('2026-11-04');
    expect(contractDay(new Date('2026-11-05T00:00:00.000Z'))).toBe('2026-11-05');
  });
});

describe('targeted contract rewards (ticket 3.6)', () => {
  const abbey = CONTRACT_TEMPLATES.filter((t) => t.areaId === 'sunkenAbbey');

  it('only Abbey contracts offer a reward slot', () => {
    expect(abbey.length).toBeGreaterThan(0);
    for (const t of CONTRACT_TEMPLATES)
      expect(offersRewardSlot(t), t.id).toBe(t.areaId === 'sunkenAbbey');
    const fields = CONTRACT_TEMPLATES.find((t) => t.areaId === 'abandonedFields')!;
    expect(() => contractReward(fields, 5, 'ring')).toThrow(RangeError);
    expect(contractReward(fields, 5).item).toBeNull();
  });

  it('the chosen slot is fixed in the reward at acceptance; gold and XP are unchanged', () => {
    const t = abbey[0]!;
    const plain = contractReward(t, 20);
    const targeted = contractReward(t, 20, 'neck');
    expect({ ...targeted, item: null }).toEqual(plain);
    expect(targeted.item).toEqual({
      slot: 'neck',
      rarityId: 'epic',
      itemLevel: 20,
      lootTableId: 'sunkenAbbey',
    });
    // The item level stays inside the Abbey's item levels.
    expect(contractReward(t, 30, 'neck').item).toMatchObject({ itemLevel: 23 });
    expect(contractReward(t, 12, 'neck').item).toMatchObject({ itemLevel: 16 });
  });

  it('every class can choose every slot it can wear from the Abbey, and gets that slot', () => {
    for (const c of CLASS_IDS) {
      const slots = targetedRewardSlots(c, 20);
      expect(slots, c).toEqual(
        expect.arrayContaining(['head', 'chest', 'hands', 'feet', 'neck', 'ring', 'weapon']),
      );
      for (const slot of slots) {
        const reward = contractReward(abbey[0]!, 20, slot).item!;
        if (!isTargetedItemReward(reward)) throw new Error('not targeted');
        for (let i = 0; i < 20; i++) {
          const seed = targetedRewardSeed(`00000000-0000-7000-8000-${String(i).padStart(12, '0')}`);
          const item = generateTargetedItem(reward, seed, c)!;
          const base = getItemBase(item.baseId);
          expect(base.slot, `${c} ${slot}`).toBe(slot);
          expect(canClassUseItem(base, c)).toBe(true);
          expect(base.unique).toBeFalsy();
          expect(item.rarityId).toBe('epic');
          expect(item.itemLevel).toBe(20);
          expect(item.variant).toBeUndefined();
          expect(validateItem(item), `${c} ${slot}`).toEqual([]);
          // Deterministic in the seed.
          expect(generateTargetedItem(reward, seed, c)).toEqual(item);
        }
      }
    }
  });

  it('the seed comes from the quest row, so one contract always grants the same item', () => {
    const id = '0190f5d2-7c1e-7a3b-9d4e-5f6a7b8c9d0e';
    expect(targetedRewardSeed(id)).toBe(targetedRewardSeed(id));
    expect(targetedRewardSeed(id)).not.toBe(targetedRewardSeed(`${id.slice(0, -1)}f`));
  });
});

describe('Ashen Pass contracts (ticket F.1)', () => {
  const pass = CONTRACT_TEMPLATES.filter((t) => t.areaId === 'ashenPass');
  const passIds = new Set(pass.map((t) => t.id));
  const open = worldFlagsFrom(['warehouseRestored', 'ashenPassCleared']);
  const closed = worldFlagsFrom(['warehouseRestored']);
  const slayer = { gravewardenDefeated: true };
  const days = Array.from({ length: 60 }, (_, i) =>
    contractDay(new Date(Date.UTC(2026, 10, 1 + i))),
  );
  const ids = ['char-1', 'char-2', '0190f0aa-0000-7000-8000-000000000001', 'hero-x'];
  const hasPass = (offers: { template: { id: string } }[]) =>
    offers.some((o) => passIds.has(o.template.id));

  it('the Pass has contract templates, all for its own foes', () => {
    expect(pass.length).toBeGreaterThan(0);
    for (const t of pass) expect(t.objective.kind).toBe('kill');
  });

  it('never offers them while the flag is closed or the hero is under the level', () => {
    for (const id of ids) {
      for (const day of days) {
        for (const level of [17, 23, 24, 28, 35]) {
          expect(hasPass(dailyContracts(id, day, level, slayer))).toBe(false);
          expect(hasPass(dailyContracts(id, day, level, slayer, closed))).toBe(false);
        }
        expect(hasPass(dailyContracts(id, day, 23, slayer, open))).toBe(false);
        // The Pass's own rule also needs the Gravewarden, as on the map.
        expect(hasPass(dailyContracts(id, day, 30, { gravewardenDefeated: false }, open))).toBe(
          false,
        );
      }
    }
  });

  it('offers them, deterministically, once flag and level both hold', () => {
    for (const id of ids) {
      const offered = days.filter((day) => hasPass(dailyContracts(id, day, 24, slayer, open)));
      // Pass contracts weigh most; they come up on most days (not on a single lucky one).
      expect(offered.length).toBeGreaterThan(days.length / 2);
      for (const day of days) {
        expect(dailyContracts(id, day, 24, slayer, open)).toEqual(
          dailyContracts(id, day, 24, slayer, open),
        );
      }
    }
  });

  it('leaves the offers of every hero who cannot reach the Pass unchanged', () => {
    for (const id of ids) {
      for (const day of days) {
        for (const level of [1, 5, 9, 13, 17, 20, 23]) {
          const before = dailyContracts(id, day, level, slayer);
          expect(dailyContracts(id, day, level, slayer, open)).toEqual(before);
          expect(dailyContracts(id, day, level, slayer, closed)).toEqual(before);
        }
        const noBoss = dailyContracts(id, day, 30, { gravewardenDefeated: false });
        expect(dailyContracts(id, day, 30, { gravewardenDefeated: false }, open)).toEqual(noBoss);
      }
    }
  });

  it('contractAreaBlockers uses the map rules', () => {
    const t = pass[0]!;
    expect(contractAreaBlockers(t, 24, slayer, open)).toEqual([]);
    expect(contractAreaBlockers(t, 24, slayer, closed)).toEqual([
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    expect(contractAreaBlockers(t, 24, slayer)).toEqual([
      { kind: 'worldFlag', flag: 'ashenPassCleared' },
    ]);
    expect(contractAreaBlockers(t, 23, slayer, open)).toEqual([{ kind: 'level', required: 24 }]);
    expect(contractAreaBlockers(findContractTemplate('slay.risenFarmhand')!, 1, slayer)).toEqual(
      [],
    );
  });
});
