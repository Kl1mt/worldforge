import { describe, expect, it } from 'vitest';
import {
  BOSS_MODIFIER_IDS,
  CLASS_IDS,
  getDungeonTier,
  getLootTable,
  simulateDungeonRun,
  simulateGuildBossAttempt,
  validateItem,
  type BossModifierId,
  type ClassId,
  type DungeonId,
  type DungeonTier,
  type GeneratedItem,
} from '../index.js';
import { kit, legendaryKit, rates, upgraded, winRate } from './kits.js';

/**
 * Ticket 6.3: the Heroic crypt (tier IV) and the weekly boss modifiers, measured with game-core
 * on pinned seeds (`tools/balance/heroic.ts` prints the full tables; docs/DUNGEONS.md "The Heroic
 * crypt" and "Weekly boss modifiers").
 */
const VERGE_IL = 33;

function runs(
  dungeonId: DungeonId,
  tier: DungeonTier,
  c: ClassId,
  level: number,
  gear: GeneratedItem[],
  bossModifier: BossModifierId | null = null,
  n = 16,
) {
  return Array.from({ length: n }, (_, i) =>
    simulateDungeonRun({
      dungeonId,
      tier,
      character: { classId: c, level, xp: 0 },
      equipment: gear,
      seed: `heroic-balance:${i}`,
      bossLootEligible: false,
      inventoryCount: 0,
      bossModifier,
    }),
  );
}

describe('the Heroic crypt (ticket 6.3)', () => {
  const heroic = getDungeonTier('namelessCrypt', 4);
  const at = (gear: (c: ClassId) => GeneratedItem[], level: number, n = 16) =>
    rates((c) => winRate(runs('namelessCrypt', 4, c, level, gear(c), null, n)));

  it('is gated on tier III cleared and level 32, and stays inside today’s item levels', () => {
    expect(heroic.unlock).toEqual({ level: 32, cryptTierCleared: 3 });
    expect(heroic.name).toBe('Heroic');
    for (const id of [heroic.lootTableId, heroic.bossLoot.lootTableId]) {
      const t = getLootTable(id);
      expect(t.itemLevel!.max, id).toBeLessThanOrEqual(getLootTable('cinderDepths').itemLevel!.max);
      expect(t.itemLevel!.min, id).toBeGreaterThanOrEqual(
        getLootTable('ashfallVerge').itemLevel!.min,
      );
    }
  });

  it('upgraded Verge Legendaries win it, not trivially; lesser gear does not', () => {
    for (const level of [32, 35]) {
      expect(at(() => [], level, 6).mean).toBe(0);
      const epic10 = at((c) => upgraded(kit(c, VERGE_IL, 'epic'), 10), level);
      expect(epic10.mean, `L${level}`).toBeLessThanOrEqual(0.1);
      const legendary = at((c) => legendaryKit(c, VERGE_IL), level);
      expect(legendary.mean, `L${level}`).toBeGreaterThanOrEqual(0.15);
      expect(legendary.mean, `L${level}`).toBeLessThanOrEqual(0.6);
      const legendary5 = at((c) => upgraded(legendaryKit(c, VERGE_IL), 5), level);
      expect(legendary5.mean, `L${level}`).toBeGreaterThan(legendary.mean);
      expect(legendary5.mean, `L${level}`).toBeLessThanOrEqual(0.85);
      const legendary10 = at((c) => upgraded(legendaryKit(c, VERGE_IL), 10), level);
      expect(legendary10.mean, `L${level}`).toBeGreaterThanOrEqual(0.85);
      for (const c of CLASS_IDS)
        expect(legendary10.per[c], `${c} L${level}`).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('is harder than tier III for the same kit', () => {
    const gear = (c: ClassId) => legendaryKit(c, VERGE_IL);
    const iii = rates((c) => winRate(runs('namelessCrypt', 3, c, 32, gear(c))));
    expect(iii.mean).toBe(1);
    expect(at(gear, 32).mean).toBeLessThan(0.6);
  });

  it('pays in odds, not power: far more top rarities than tier III, no item above the top', () => {
    const tally = (tier: DungeonTier, level: number) => {
      let items = 0;
      let top = 0;
      let maxIl = 0;
      for (const c of CLASS_IDS)
        for (let i = 0; i < 60; i++) {
          const r = simulateDungeonRun({
            dungeonId: 'namelessCrypt',
            tier,
            character: { classId: c, level, xp: 0 },
            equipment: upgraded(legendaryKit(c, 39), 10),
            seed: `heroic-odds:${c}:${i}`,
            bossLootEligible: true,
            inventoryCount: 0,
          });
          for (const it of [...r.items, ...r.salvaged]) {
            items++;
            if (it.rarityId === 'legendary' || it.rarityId === 'mythic' || it.variant === 'void')
              top++;
            maxIl = Math.max(maxIl, it.itemLevel);
            if (tier === 4) expect(validateItem(it), it.baseId).toEqual([]);
          }
        }
      return { share: top / items, maxIl };
    };
    const iii = tally(3, 24);
    const iv = tally(4, 36);
    expect(iv.share).toBeGreaterThan(2 * iii.share);
    // The current top: the Cinder Depths' and the Forge Tyrant's item level 41.
    expect(iv.maxIl).toBeLessThanOrEqual(41);
  });
});

describe('weekly boss modifiers on every boss (ticket 6.3)', () => {
  /** Each boss at its entry with the kit its own suite calls "a real chance". */
  const BOSSES: [string, DungeonId, DungeonTier, number, (c: ClassId) => GeneratedItem[]][] = [
    ['crypt I', 'namelessCrypt', 1, 14, (c) => kit(c, 13)],
    ['crypt II', 'namelessCrypt', 2, 18, (c) => upgraded(kit(c, 17, 'rare'), 5)],
    ['crypt III', 'namelessCrypt', 3, 21, (c) => legendaryKit(c, 20)],
    ['Heroic', 'namelessCrypt', 4, 34, (c) => upgraded(legendaryKit(c, VERGE_IL), 10)],
    ['Ashen Warden', 'ashenWatch', 1, 26, (c) => upgraded(legendaryKit(c, 25), 5)],
    ['Forge Tyrant', 'tyrantsForge', 1, 36, (c) => upgraded(legendaryKit(c, VERGE_IL), 10)],
  ];

  it('each modifier makes a boss somewhat harder, never a wall, never easier', () => {
    for (const [name, d, t, level, gear] of BOSSES) {
      const none = rates((c) => winRate(runs(d, t, c, level, gear(c), null, 12)));
      for (const m of BOSS_MODIFIER_IDS) {
        const mod = rates((c) => winRate(runs(d, t, c, level, gear(c), m, 12)));
        expect(mod.mean, `${name} ${m}`).toBeLessThanOrEqual(none.mean + 0.05);
        expect(mod.mean, `${name} ${m}`).toBeGreaterThanOrEqual(none.mean - 0.3);
      }
    }
  });

  it('the guild boss: a modifier moves an attempt’s damage by a few percent, either way', () => {
    const damage = (m: BossModifierId | null) =>
      CLASS_IDS.reduce((sum, c) => {
        for (let s = 0; s < 8; s++)
          sum += simulateGuildBossAttempt({
            bossId: 'risenGravewarden',
            character: { classId: c, level: 21 },
            equipment: kit(c, 20, 'epic'),
            seed: `gb-balance:${s}`,
            bossModifier: m,
          }).damage;
        return sum;
      }, 0);
    const none = damage(null);
    for (const m of BOSS_MODIFIER_IDS) {
      const ratio = damage(m) / none;
      expect(ratio, m).toBeGreaterThan(0.85);
      expect(ratio, m).toBeLessThan(1.15);
    }
  });
});
