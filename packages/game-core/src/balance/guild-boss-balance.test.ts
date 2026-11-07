import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  GUILD_BOSS_ATTEMPTS_PER_WEEK,
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
  getGuildBoss,
  guildBossStageOf,
  simulateGuildBossAttempt,
  type ClassId,
  type EquippedItem,
  type GeneratedItem,
  type RarityId,
} from '../index.js';
import { buildItems, chassis, classMythic } from './builds.js';

/**
 * Guild boss balance (ticket 4.9, docs/GUILD_BOSS.md "Balance"): a small guild finishes the first
 * stage in a week; a full guild of the strongest builds needs nearly every attempt for the last
 * stage, and a full guild of ordinary late-game heroes cannot reach it. One hero cannot carry a
 * guild past the first stages alone (the per-attempt cap).
 */
const boss = getGuildBoss('risenGravewarden');
const threshold = (stage: number) => boss.stages[stage - 1]!.threshold;

function kit(classId: ClassId, itemLevel: number, rarityId: RarityId, upgradeLevel = 0) {
  const rng = createRng(`gb-kit:${classId}:${itemLevel}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: (GeneratedItem & { upgradeLevel: number })[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId,
      })!;
      out.push({ ...item, upgradeLevel });
    }
  }
  return out;
}

/** A best-in-slot hero: 4 Ashen Choir, the class Mythic, crit Legendaries, all +10 Void. */
function bestInSlot(classId: ClassId): EquippedItem[] {
  const c = chassis(classId, [['ashen-choir', 4]], [classMythic(classId)]);
  return buildItems(
    {
      classId,
      chassis: c.name,
      picks: c.fixed.map((f) => f ?? { kind: 'legendary', effectId: null }),
      pkg: 'crit',
      upgradeLevel: 10,
      void: true,
    },
    27,
  );
}

interface Member {
  classId: ClassId;
  level: number;
  equipment: readonly EquippedItem[];
}

/** Counted damage of a guild's attempts this week (each member, `attempts` each). */
function weekTotal(guild: string, members: Member[], attempts = GUILD_BOSS_ATTEMPTS_PER_WEEK) {
  let total = 0;
  members.forEach((m, i) => {
    for (let n = 1; n <= attempts; n++) {
      total += simulateGuildBossAttempt({
        bossId: boss.id,
        character: { classId: m.classId, level: m.level },
        equipment: m.equipment,
        seed: `${guild}:${i}:${n}`,
      }).counted;
    }
  });
  return total;
}

const guildOf = (size: number, make: (c: ClassId) => Member) =>
  Array.from({ length: size }, (_, i) => make(CLASS_IDS[i % CLASS_IDS.length]!));

describe('guild boss balance (ticket 4.9)', () => {
  it('a small guild finishes the first stage in a week', () => {
    // Three level-14 heroes in commons (the crypt's entry gear), every attempt.
    const three = guildOf(3, (c) => ({ classId: c, level: 14, equipment: kit(c, 13, 'common') }));
    const t3 = weekTotal('small-3', three);
    expect(t3).toBeGreaterThanOrEqual(threshold(1));
    expect(guildBossStageOf(boss, t3)).toBe(1);
    // Five level-12 heroes in commons, every attempt.
    const five = guildOf(5, (c) => ({ classId: c, level: 12, equipment: kit(c, 11, 'common') }));
    expect(weekTotal('small-5', five)).toBeGreaterThanOrEqual(threshold(1));
    // But not with one attempt each: the first stage still takes the week's effort.
    expect(weekTotal('small-3', three, 1)).toBeLessThan(threshold(1));
  });

  it('a small guild of late-game heroes breaks the second stage in a week (ticket B.3)', () => {
    // Three heroes at the Pass's entry in Legendaries, or five at the Abbey's top in epics.
    const three = guildOf(3, (c) => ({
      classId: c,
      level: 24,
      equipment: kit(c, 23, 'legendary'),
    }));
    expect(guildBossStageOf(boss, weekTotal('pass-3', three))).toBeGreaterThanOrEqual(2);
    const five = guildOf(5, (c) => ({ classId: c, level: 21, equipment: kit(c, 20, 'epic') }));
    expect(guildBossStageOf(boss, weekTotal('abbey-5', five))).toBeGreaterThanOrEqual(2);
    // Mid-game heroes stop at the first stage: three level-18 heroes in rares.
    const rares = guildOf(3, (c) => ({ classId: c, level: 18, equipment: kit(c, 17, 'rare') }));
    expect(guildBossStageOf(boss, weekTotal('rares-3', rares))).toBe(1);
    // The second stage stays above one capped hero's week (3 × the cap): no hero carries it.
    expect(threshold(2)).toBeGreaterThan(GUILD_BOSS_ATTEMPTS_PER_WEEK * boss.attemptDamageCap);
  });

  it('a full guild of the strongest builds cannot trivialise every stage', () => {
    const top = guildOf(30, (c) => ({ classId: c, level: 28, equipment: bestInSlot(c) }));
    // Everyone hits the per-attempt cap…
    expect(weekTotal('top', top.slice(0, 4), 1)).toBe(4 * boss.attemptDamageCap);
    // …so the last stage needs more than three quarters of every attempt the guild has.
    expect(30 * GUILD_BOSS_ATTEMPTS_PER_WEEK * boss.attemptDamageCap * 0.75).toBeLessThan(
      threshold(boss.stages.length),
    );
    expect(guildBossStageOf(boss, weekTotal('top', top))).toBe(boss.stages.length);
    expect(guildBossStageOf(boss, weekTotal('top', top, 2))).toBeLessThan(boss.stages.length);
    // Twenty of them (two thirds of the roster) fall short of it too.
    expect(guildBossStageOf(boss, weekTotal('top', top.slice(0, 20)))).toBeLessThan(
      boss.stages.length,
    );
  });

  it('a full guild of ordinary late-game heroes reaches the middle stages, not the last', () => {
    const legend = guildOf(30, (c) => ({
      classId: c,
      level: 24,
      equipment: kit(c, 23, 'legendary'),
    }));
    const stage = guildBossStageOf(boss, weekTotal('legend', legend));
    expect(stage).toBeGreaterThanOrEqual(3);
    expect(stage).toBeLessThan(boss.stages.length);
    const rares = guildOf(30, (c) => ({ classId: c, level: 18, equipment: kit(c, 17, 'rare') }));
    expect(guildBossStageOf(boss, weekTotal('rares', rares))).toBe(3);
  });

  it('one hero cannot carry the guild (no monopoly)', () => {
    const one = [{ classId: 'hunter' as const, level: 28, equipment: bestInSlot('hunter') }];
    const alone = weekTotal('alone', one);
    expect(alone).toBe(GUILD_BOSS_ATTEMPTS_PER_WEEK * boss.attemptDamageCap);
    expect(alone).toBeLessThan(threshold(2));
  });

  it('every class can take part from the minimum level', () => {
    for (const c of CLASS_IDS) {
      const r = simulateGuildBossAttempt({
        bossId: boss.id,
        character: { classId: c, level: boss.minLevel },
        equipment: kit(c, boss.minLevel - 1, 'common'),
        seed: `min:${c}`,
      });
      expect(r.counted).toBeGreaterThan(threshold(1) / 30);
    }
  });
});
