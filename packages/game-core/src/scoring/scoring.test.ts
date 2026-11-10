import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  CLASS_IDS,
  ITEM_BASES,
  MAX_UPGRADE_LEVEL,
  NO_WORLD_FLAGS,
  RARITY_IDS,
  canClassUseItem,
  createRng,
  equipmentSlotsForKind,
  generateItem,
  xpToNextLevel,
  type ClassId,
  type RarityId,
} from '../index.js';
import {
  FORMULA_VERSIONS,
  PVE_MILESTONES,
  affixQuality,
  checkEquipment,
  compareSortKeys,
  computeScores,
  gearItemPoints,
  gearScore,
  levelScore,
  powerScore,
  pveProgressScore,
  slotHands,
  type ScoredItem,
  type ScoringInput,
} from './index.js';
import { AREAS } from '../world/areas.js';
import { DUNGEONS } from '../world/dungeons.js';

/** One item per slot of the best tier the class can use (the balance suite's "geared" kit). */
function kit(
  classId: ClassId,
  itemLevel: number,
  rarityId: RarityId = 'common',
  upgradeLevel = 0,
): ScoredItem[] {
  const rng = createRng(`score-kit:${classId}:${itemLevel}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const out: ScoredItem[] = [];
  const taken = new Set<string>();
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (const slot of equipmentSlotsForKind(base.slot)) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel,
        baseId: base.id,
        rarityId,
        classId,
      })!;
      out.push({ ...item, slot, upgradeLevel });
    }
  }
  return out;
}

const hero = (over: Partial<ScoringInput> = {}): ScoringInput => ({
  classId: 'warrior',
  level: 20,
  experience: 1234,
  equipment: kit('warrior', 19, 'rare', 3),
  progress: { gravewardenDefeated: true, cryptTierCleared: 2 },
  world: NO_WORLD_FLAGS,
  guildBossStage: 2,
  ...over,
});

describe('determinism', () => {
  it('gives the same scores in every call', () => {
    const a = computeScores(hero());
    const b = computeScores(JSON.parse(JSON.stringify(hero())) as ScoringInput);
    expect(b).toEqual(a);
  });

  // Pinned values: the same in every process and on every machine (no clock, no Math.random, no
  // ambient state). If one moves, a formula changed: bump its `FORMULA_VERSIONS` entry and update
  // the pin and docs/LEADERBOARDS.md in the same change (5.2 recomputes stored values on a bump).
  it('pins the values of reference heroes (bump FORMULA_VERSIONS when one moves)', () => {
    expect(FORMULA_VERSIONS).toEqual({ level: 1, gearScore: 2, power: 2, pveProgress: 4 });
    const pinned = CLASS_IDS.map((classId) => {
      // Ticket 6.1: the version-1 pins, computed at version 1 (unchanged by 6.1).
      const s = computeScores(hero({ classId, equipment: kit(classId, 19, 'rare', 3) }), {
        ...FORMULA_VERSIONS,
        power: 1,
        pveProgress: 1,
      });
      return [classId, s.level.sortKey, s.gearScore.sortKey, s.power.value, s.pveProgress.sortKey];
    });
    expect(pinned).toMatchInlineSnapshot(`
      [
        [
          "warrior",
          [
            20,
            1234,
          ],
          [
            2493,
            422,
          ],
          1703,
          [
            7,
            7,
            2,
          ],
        ],
        [
          "mage",
          [
            20,
            1234,
          ],
          [
            2492,
            517,
          ],
          1509,
          [
            7,
            7,
            2,
          ],
        ],
        [
          "hunter",
          [
            20,
            1234,
          ],
          [
            2492,
            353,
          ],
          1647,
          [
            7,
            7,
            2,
          ],
        ],
        [
          "warlock",
          [
            20,
            1234,
          ],
          [
            2492,
            591,
          ],
          1486,
          [
            7,
            7,
            2,
          ],
        ],
      ]
    `);
  });
});

describe('Character Level', () => {
  it('ranks by level, then by experience within the level', () => {
    expect(levelScore(12, 500).sortKey).toEqual([12, 500]);
    expect(levelScore(60, 0).sortKey).toEqual([60, 0]);
  });

  it('a level-up never lowers the score', () => {
    for (let level = 1; level < 60; level++) {
      const top = levelScore(level, xpToNextLevel(level) - 1).sortKey;
      const next = levelScore(level + 1, 0).sortKey;
      expect(next[0]! > top[0]!, `level ${level}`).toBe(true);
    }
  });

  it('refuses values the server never stores', () => {
    for (const [l, xp] of [
      [0, 0],
      [61, 0],
      [1.5, 0],
      [5, -1],
      [5, xpToNextLevel(5)],
      [5, 0.5],
      [60, 1],
      [Number.NaN, 0],
    ] as const) {
      expect(() => levelScore(l, xp), `${l}/${xp}`).toThrow(RangeError);
    }
  });
});

describe('Gear Score', () => {
  it('counts equipped items by item level, rarity, upgrades and Void', () => {
    const item = { itemLevel: 20, rarityId: 'legendary' as const, upgradeLevel: 5, variant: null };
    expect(gearItemPoints(item).points).toBe(Math.round(20 * 10 * 1.75 * 1.2));
    expect(gearItemPoints({ ...item, variant: 'void' }).points).toBe(
      Math.round(20 * 10 * 1.75 * 1.2 * 1.1),
    );
    expect(gearScore('mage', []).value).toBe(0);
  });

  it('counts Prismatic like Void (ticket 6.4), with no new version', () => {
    const item = { itemLevel: 30, rarityId: 'mythic' as const, upgradeLevel: 3, variant: null };
    const prism = gearItemPoints({ ...item, variant: 'prismatic' });
    expect(prism.points).toBe(gearItemPoints({ ...item, variant: 'void' }).points);
    expect(prism.points).toBe(Math.round(30 * 10 * 2 * 1.12 * 1.1));
    // A stray flag on an Epic (never valid) counts nothing extra.
    expect(gearItemPoints({ ...item, rarityId: 'epic', variant: 'prismatic' }).points).toBe(
      gearItemPoints({ ...item, rarityId: 'epic' }).points,
    );
    // The version is unchanged: no item could be stored as Prismatic before 6.4.
    expect(FORMULA_VERSIONS.gearScore).toBe(2);
    // The breakdown names the variant; a kit with one Prismatic piece scores above the plain kit.
    const items = kit('hunter', 27, 'legendary', 1);
    const plain = gearScore('hunter', items);
    const one = gearScore(
      'hunter',
      items.map((i, n) => (n === 0 ? { ...i, variant: 'prismatic' as const } : i)),
    );
    expect(one.value).toBeGreaterThan(plain.value);
    expect(one.lines.some((l) => l.detail.includes('Prismatic'))).toBe(true);
  });

  it('version 2 (B.4): magic quality breaks ties and never moves the value', () => {
    // Each affix scores 0–100 on its own tiers: the best roll of the top tier is 100. Ticket 6.1:
    // on the tiers before the Cinderwastes (item level ≤ 29); tier 5 scores above 100, so no
    // version-2 value moved.
    for (const def of AFFIXES) {
      const legacy = def.tiers.filter((t) => t.minBaseItemLevel === undefined);
      const top = legacy[legacy.length - 1]!;
      const t5 = def.tiers.find((t) => t.tier === 5);
      if (t5) {
        expect(affixQuality({ affixId: def.id, tier: 5, value: t5.min }), def.id).toBe(100);
        expect(affixQuality({ affixId: def.id, tier: 5, value: t5.max }), def.id).toBe(125);
      }
      const low = def.tiers[0]!;
      expect(affixQuality({ affixId: def.id, tier: top.tier, value: top.max }), def.id).toBe(100);
      expect(affixQuality({ affixId: def.id, tier: low.tier, value: low.min }), def.id).toBe(0);
      // A higher roll, or a higher tier, never scores less.
      for (const t of def.tiers) {
        const a = affixQuality({ affixId: def.id, tier: t.tier, value: t.min });
        const b = affixQuality({ affixId: def.id, tier: t.tier, value: t.max });
        expect(b).toBeGreaterThanOrEqual(a);
        const next = def.tiers.find((x) => x.tier === t.tier + 1);
        if (next) {
          expect(
            affixQuality({ affixId: def.id, tier: next.tier, value: next.min }),
          ).toBeGreaterThanOrEqual(b);
        }
      }
    }
    expect(affixQuality({ affixId: 'no-such-affix', tier: 1, value: 1 })).toBe(0);
    // Two kits of equal value: the better-rolled one ranks higher; the value is version 1's.
    const items = kit('hunter', 25, 'legendary', 2);
    const plain = gearScore('hunter', items);
    expect(plain.sortKey).toHaveLength(2);
    expect(plain.sortKey[0]).toBe(plain.value);
    const best = items.map((i) => ({
      ...i,
      affixes: i.affixes.map((a) => {
        const def = AFFIXES.find((d) => d.id === a.affixId)!;
        const band = def.tiers.find((t) => t.tier === a.tier)!;
        return { ...a, value: band.max };
      }),
    }));
    const better = gearScore('hunter', best);
    expect(better.value).toBe(plain.value);
    if (items.some((i) => i.affixes.length > 0)) {
      expect(better.sortKey[1]!).toBeGreaterThanOrEqual(plain.sortKey[1]!);
      expect(compareSortKeys(better.sortKey, plain.sortKey)).toBeLessThanOrEqual(0);
    }
    // A forged item counts 0 and adds no quality.
    expect(gearScore('hunter', []).sortKey).toEqual([0, 0]);
  });

  it('weighs a two-handed weapon as both hands, so every class can reach the same total', () => {
    expect(slotHands('warrior', 'weapon')).toBe(1);
    for (const c of ['mage', 'hunter', 'warlock'] as const) expect(slotHands(c, 'weapon')).toBe(2);
    const totals = CLASS_IDS.map((c) => gearScore(c, kit(c, 22, 'epic')).value);
    expect(Math.max(...totals) / Math.min(...totals)).toBeLessThan(1.001);
  });

  it('a strictly better item never lowers the score', () => {
    // Every factor (item level, rarity, upgrade, Void) separately and all together.
    let checks = 0;
    for (const [r, rarityId] of RARITY_IDS.entries()) {
      for (let itemLevel = 1; itemLevel <= 60; itemLevel++) {
        for (let up = 0; up <= MAX_UPGRADE_LEVEL; up++) {
          const variants =
            rarityId === 'legendary' || rarityId === 'mythic' ? [null, 'void'] : [null];
          for (const variant of variants as (null | 'void')[]) {
            const base = gearItemPoints({ itemLevel, rarityId, upgradeLevel: up, variant }).points;
            const better: Parameters<typeof gearItemPoints>[0][] = [];
            if (itemLevel < 60)
              better.push({ itemLevel: itemLevel + 1, rarityId, upgradeLevel: up, variant });
            if (r < RARITY_IDS.length - 1)
              better.push({
                itemLevel,
                rarityId: RARITY_IDS[r + 1]!,
                upgradeLevel: up,
                variant: null,
              });
            if (up < MAX_UPGRADE_LEVEL)
              better.push({ itemLevel, rarityId, upgradeLevel: up + 1, variant });
            if (variants.length > 1 && !variant)
              better.push({ itemLevel, rarityId, upgradeLevel: up, variant: 'void' });
            for (const b of better) {
              expect(gearItemPoints(b).points, JSON.stringify(b)).toBeGreaterThanOrEqual(base);
              checks++;
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(10_000);
  });

  it('replacing an item with a better one in its slot never lowers the total', () => {
    for (const c of CLASS_IDS) {
      const worse = kit(c, 18, 'rare', 2);
      const better = kit(c, 18, 'epic', 2);
      const total = gearScore(c, worse).value;
      for (let i = 0; i < worse.length; i++) {
        const swapped = worse.slice();
        swapped[i] = better[i]!;
        expect(gearScore(c, swapped).value, `${c} ${worse[i]!.slot}`).toBeGreaterThan(total);
      }
    }
  });
});

describe('stat-inflation resistance', () => {
  const base = () => kit('warrior', 22, 'legendary', 4);
  const forge = (f: (i: ScoredItem) => ScoredItem, index = 0): ScoredItem[] => {
    const items = base();
    items[index] = f(items[index]!);
    return items;
  };
  const cases: [string, ScoredItem[], string][] = [
    [
      'an affix above its tier',
      forge((i) => ({ ...i, affixes: i.affixes.map((a) => ({ ...a, value: a.value * 50 })) })),
      'invalid_item',
    ],
    [
      'an extra affix',
      forge((i) => ({ ...i, affixes: [...i.affixes, i.affixes[0]!] })),
      'invalid_item',
    ],
    ['an item level above the cap', forge((i) => ({ ...i, itemLevel: 500 })), 'invalid_item'],
    ['a non-finite item level', forge((i) => ({ ...i, itemLevel: Number.NaN })), 'invalid_item'],
    ['an unknown base', forge((i) => ({ ...i, baseId: 'godslayer' })), 'wrong_slot'],
    ['an unknown rarity', forge((i) => ({ ...i, rarityId: 'divine' as RarityId })), 'invalid_item'],
    ['upgrade +11', forge((i) => ({ ...i, upgradeLevel: 11 })), 'invalid_upgrade'],
    ['upgrade +2.5', forge((i) => ({ ...i, upgradeLevel: 2.5 })), 'invalid_upgrade'],
    ['upgrade −1', forge((i) => ({ ...i, upgradeLevel: -1 })), 'invalid_upgrade'],
    ['Void on a rare', forge((i) => ({ ...i, rarityId: 'rare', variant: 'void' })), 'invalid_item'],
    [
      'a forged effect',
      forge((i) => ({ ...i, effectId: 'starfall', effectRoll: 1 })),
      'invalid_item',
    ],
    ['a forged set', forge((i) => ({ ...i, setId: 'ashen-choir' })), 'invalid_item'],
    ['an unknown slot', forge((i) => ({ ...i, slot: 'tail' })), 'wrong_slot'],
    [
      'an item in a slot it does not fit',
      forge((i) => ({ ...i, slot: 'shoulders' })),
      'wrong_slot',
    ],
  ];

  it.each(cases)('%s counts 0 and does not fight', (_, items, reason) => {
    const valid = base();
    const without = valid.filter((_, i) => i !== 0);
    const gear = gearScore('warrior', items);
    const line = gear.lines.find((l) => !l.counted)!;
    expect(line.reason).toBe(reason);
    expect(gear.value).toBe(gearScore('warrior', without).value);
    expect(gear.value).toBeLessThan(gearScore('warrior', valid).value);
    expect(powerScore('warrior', 23, items).value).toBe(powerScore('warrior', 23, without).value);
  });

  it('a second item in one slot makes neither count', () => {
    const items = base();
    const weapon = items.find((i) => i.slot === 'weapon')!;
    const doubled = [...items, { ...weapon, seed: weapon.seed + 1 }];
    const checked = checkEquipment('warrior', doubled);
    expect(checked.filter((c) => c.rejection === 'duplicate_slot')).toHaveLength(2);
  });

  it('a class item another class wears counts 0 (a shield on a mage)', () => {
    const shield = kit('warrior', 22, 'epic').find((i) => i.slot === 'offhand')!;
    const items = [...kit('mage', 22, 'epic'), shield];
    expect(gearScore('mage', items).value).toBe(gearScore('mage', kit('mage', 22, 'epic')).value);
  });

  it('every generated item counts (no false rejections)', () => {
    for (const c of CLASS_IDS) {
      for (const r of RARITY_IDS) {
        for (const il of [1, 9, 15, 22, 27]) {
          for (const c2 of checkEquipment(c, kit(c, il, r, 10))) {
            expect(c2.rejection, `${c} ${r} ${il} ${c2.item.baseId}`).toBeNull();
          }
        }
      }
    }
  });
});

describe('Character Power', () => {
  it('grows with level and with gear', () => {
    for (const c of CLASS_IDS) {
      let last = 0;
      for (const level of [1, 5, 10, 15, 20, 25, 30, 35]) {
        const p = powerScore(c, level, kit(c, Math.max(1, level - 1))).value;
        expect(p, `${c} ${level}`).toBeGreaterThan(last);
        last = p;
      }
      const tiers = [
        powerScore(c, 23, []).value,
        powerScore(c, 23, kit(c, 22, 'common')).value,
        powerScore(c, 23, kit(c, 22, 'rare')).value,
        powerScore(c, 23, kit(c, 22, 'epic', 5)).value,
        powerScore(c, 23, kit(c, 22, 'legendary', 10)).value,
      ];
      expect(
        [...tiers].sort((a, b) => a - b),
        `${c}: ${tiers.join(' < ')}`,
      ).toEqual(tiers);
      expect(new Set(tiers).size).toBe(tiers.length);
    }
  });

  // Power measures real strength, so it shows the class balance too (boards filter by class);
  // with the same kind of kit no class is far ahead (measured up to × 1.21, hunter over warlock).
  it('keeps the classes close with the same kind of kit', () => {
    for (const level of [10, 20, 28]) {
      const ps = CLASS_IDS.map((c) => powerScore(c, level, kit(c, level - 1, 'rare', 3)).value);
      expect(Math.max(...ps) / Math.min(...ps), `${level}: ${ps.join(' / ')}`).toBeLessThan(1.3);
    }
  });

  it('version 2 (6.1) is version 1 plus the trials at 30 and 34', () => {
    for (const c of CLASS_IDS) {
      for (const [level, il, rarity, up] of [
        [12, 11, 'common', 0],
        [23, 22, 'legendary', 5],
        [30, 29, 'epic', 5],
        [34, 33, 'legendary', 10],
      ] as const) {
        const items = kit(c, il, rarity, up);
        const v1 = powerScore(c, level, items, 1);
        const v2 = powerScore(c, level, items, 2);
        const added = v2.lines.filter((l) => l.id === 'trial:30' || l.id === 'trial:34');
        expect(added, c).toHaveLength(2);
        // Every old trial gives exactly its version-1 points; the value only grows.
        for (const line of v1.lines) {
          expect(v2.lines.find((l) => l.id === line.id)?.points, `${c} ${line.id}`).toBe(
            line.points,
          );
        }
        expect(v2.value, `${c} L${level}`).toBeGreaterThanOrEqual(v1.value);
        expect(
          Math.abs(v2.value - v1.value - added.reduce((t, l) => t + l.points, 0)),
        ).toBeLessThanOrEqual(2);
        expect(v2.formulaVersion).toBe(2);
        expect(v1.formulaVersion).toBe(1);
      }
    }
    // The Cinderwastes' gear shows: tier-4 epics +10 score above the Pass's (item level 27).
    for (const c of CLASS_IDS) {
      expect(powerScore(c, 34, kit(c, 33, 'epic', 10)).value, c).toBeGreaterThan(
        powerScore(c, 34, kit(c, 27, 'epic', 10)).value,
      );
    }
    expect(() => powerScore('mage', 10, [], 3)).toThrow(RangeError);
  });

  it('explains every trial', () => {
    const s = powerScore('hunter', 22, kit('hunter', 21, 'epic'));
    expect(s.lines).toHaveLength(22);
    expect(powerScore('hunter', 22, kit('hunter', 21, 'epic'), 1).lines).toHaveLength(20);
    expect(s.lines.reduce((t, l) => t + l.points, 0)).toBeGreaterThan(s.value - 20);
    expect(s.lines[0]!.detail).toMatch(/^Cleared in \d+ s$/);
    expect(s.lines.at(-1)!.detail).toMatch(/fights won$/);
  });

  // Budget: computed on every equip and level-up (5.2). ~2 ms per call on a laptop; the bound is
  // ten times that, so a slow CI runner still passes and a 10× regression fails.
  it('stays within its performance budget', () => {
    const items = kit('warlock', 27, 'legendary', 10);
    const start = Date.now();
    for (let i = 0; i < 100; i++) powerScore('warlock', 28, items);
    expect((Date.now() - start) / 100).toBeLessThan(25);
  });
});

describe('PvE Progress', () => {
  const progress = (over: Partial<Parameters<typeof pveProgressScore>[0]> = {}) =>
    pveProgressScore({
      level: 1,
      progress: { gravewardenDefeated: false },
      guildBossStage: 0,
      ...over,
    });

  it('lists every area and every crypt tier, once, in the order heroes meet them', () => {
    const areas = PVE_MILESTONES.flatMap((m) => (m.kind === 'area' ? [m.areaId] : []));
    expect([...areas].sort()).toEqual(AREAS.map((a) => a.id).sort());
    const crypt = DUNGEONS.find((d) => d.id === 'namelessCrypt')!;
    const tiers = PVE_MILESTONES.flatMap((m) => (m.kind === 'cryptTier' ? [m.tier] : []));
    expect(tiers).toEqual(crypt.tiers.map((t) => t.tier));
    expect(new Set(PVE_MILESTONES.map((m) => m.id)).size).toBe(PVE_MILESTONES.length);
  });

  it('a fresh hero has reached the first field', () => {
    expect(progress().sortKey).toEqual([1, 1, 0]);
  });

  it('counts milestones; ties go to the furthest, then the guild boss stage', () => {
    const tier2 = progress({
      level: 20,
      progress: { gravewardenDefeated: true, cryptTierCleared: 2 },
    });
    expect(tier2.sortKey).toEqual([7, 7, 0]);
    // The Pass open (level 24 and the community's flag) without tiers II and III.
    const pass = progress({
      level: 24,
      progress: { gravewardenDefeated: true, cryptTierCleared: 1 },
      world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
    });
    expect(pass.sortKey).toEqual([7, 9, 0]);
    const top = progress({
      level: 28,
      progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
      world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
      guildBossStage: 5,
    });
    // Version 2 (6.1): the Warden opens the Ashfall Verge at 28 (milestone 11 of 13; also in 3).
    expect(top.sortKey).toEqual([11, 11, 5]);
    const v1 = (i: Parameters<typeof progress>[0]) =>
      pveProgressScore(
        { level: 1, progress: { gravewardenDefeated: false }, guildBossStage: 0, ...i },
        1,
      );
    expect(
      v1({
        level: 28,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
        world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
        guildBossStage: 5,
      }).sortKey,
    ).toEqual([10, 10, 5]);
    const verge = (level: number) =>
      progress({
        level,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
        world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
        guildBossStage: 5,
      });
    expect(verge(30).sortKey).toEqual([11, 11, 5]);
    expect(verge(31).sortKey).toEqual([12, 12, 5]);
    // Version 3 (6.2): level 34 also opens the Cinder Depths (milestone 14 of 17).
    expect(verge(34).sortKey).toEqual([14, 14, 5]);
    const v2 = (level: number) =>
      pveProgressScore(
        {
          level,
          progress: { gravewardenDefeated: true, cryptTierCleared: 3, ashenWardenDefeated: true },
          world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
          guildBossStage: 5,
        },
        2,
      );
    expect(v2(34).sortKey).toEqual([13, 13, 5]);
    expect(v2(34).lines.every((l) => l.id === 'guildBoss' || l.counted)).toBe(true);
    expect(verge(37).sortKey).toEqual([15, 15, 5]);
    // The Forge Tyrant (milestone 16) counts at any level; the Depths' top at 40.
    const depths = (level: number, tyrant: boolean) =>
      progress({
        level,
        progress: {
          gravewardenDefeated: true,
          cryptTierCleared: 3,
          ashenWardenDefeated: true,
          ...(tyrant ? { forgeTyrantDefeated: true } : {}),
        },
        world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
        guildBossStage: 5,
      });
    expect(depths(38, true).sortKey).toEqual([16, 16, 5]);
    expect(depths(40, false).sortKey).toEqual([16, 17, 5]);
    expect(depths(40, true).sortKey).toEqual([17, 17, 5]);
    // Version 4 (6.3): the Heroic crypt (milestone 18) is the one left.
    expect(
      depths(40, true)
        .lines.filter((l) => !l.counted)
        .map((l) => l.id),
    ).toEqual(['crypt:4']);
    const heroic = (level: number, tyrant: boolean) =>
      progress({
        level,
        progress: {
          gravewardenDefeated: true,
          cryptTierCleared: 4,
          ashenWardenDefeated: true,
          ...(tyrant ? { forgeTyrantDefeated: true } : {}),
        },
        world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
        guildBossStage: 5,
      });
    expect(heroic(40, true).sortKey).toEqual([18, 18, 5]);
    expect(heroic(40, true).lines.every((l) => l.counted)).toBe(true);
    // A level-32 Heroic clear is the furthest milestone: it breaks a tie of counts.
    expect(heroic(32, false).sortKey).toEqual([13, 18, 5]);
    const v3 = (level: number, tier: number) =>
      pveProgressScore(
        {
          level,
          progress: {
            gravewardenDefeated: true,
            cryptTierCleared: tier,
            ashenWardenDefeated: true,
          },
          world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
          guildBossStage: 5,
        },
        3,
      );
    // Version 3 ignores the Heroic clear; version 4 adds exactly it (never below version 3).
    expect(v3(32, 4).sortKey).toEqual(v3(32, 3).sortKey);
    for (const level of [1, 24, 28, 32, 34, 37, 40]) {
      expect(heroic(level, false).value).toBeGreaterThanOrEqual(v3(level, 4).value);
      expect(heroic(level, false).value - v3(level, 4).value).toBeLessThanOrEqual(1);
    }
    // Every version-2 hero scores the same under version 3 or more (never less).
    for (const level of [1, 24, 28, 31, 34, 37, 40]) {
      expect(depths(level, false).value).toBeGreaterThanOrEqual(v2(level).value);
    }
    // Level 34 without the Warden: none of the Verge's milestones.
    expect(
      progress({
        level: 34,
        progress: { gravewardenDefeated: true, cryptTierCleared: 3 },
        world: { ...NO_WORLD_FLAGS, ashenPassCleared: true },
      }).sortKey,
    ).toEqual([9, 9, 0]);
  });

  it('never counts a guild boss stage that does not exist', () => {
    for (const s of [-1, 1.5, Number.NaN])
      expect(progress({ guildBossStage: s }).sortKey[2]).toBe(0);
    expect(progress({ guildBossStage: 99 }).sortKey[2]).toBe(5);
  });

  it('progress only adds milestones (never lowers the score)', () => {
    const steps = [
      { level: 1, progress: { gravewardenDefeated: false } },
      { level: 13, progress: { gravewardenDefeated: false } },
      { level: 15, progress: { gravewardenDefeated: true, cryptTierCleared: 1 } },
      { level: 18, progress: { gravewardenDefeated: true, cryptTierCleared: 2 } },
      { level: 22, progress: { gravewardenDefeated: true, cryptTierCleared: 3 } },
    ];
    let last = 0;
    for (const s of steps) {
      const v = progress(s).value;
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});
