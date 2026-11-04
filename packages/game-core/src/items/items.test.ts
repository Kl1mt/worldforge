import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  CLASS_IDS,
  DEFAULT_LOOT_CONFIG,
  EQUIPMENT_SLOT_IDS,
  ITEM_BASES,
  ITEM_SLOT_KINDS,
  affixesForSlot,
  canClassUseItem,
  equipmentSlotsForKind,
  getItemBase,
  isCoreStatId,
  itemFitsSlot,
} from '../index.js';

/** The curated icons in apps/web/public/assets/items/ (ticket 0.2). */
const ITEM_ICONS = [
  'bone-amulet',
  'brass-ring',
  'chainmail',
  'heater-shield',
  'horned-helm',
  'hunting-bow',
  'iron-gauntlets',
  'iron-helm',
  'iron-ring',
  'leather-boots',
  'leather-gloves',
  'leather-jerkin',
  'longsword-notched',
  'longsword',
  'plate-cuirass',
  'round-shield',
  'skull-staff',
];

describe('item bases', () => {
  it('has exactly one tier-1 base per curated item icon', () => {
    const tier1 = ITEM_BASES.filter((b) => b.tier === 1);
    expect(tier1.map((b) => b.icon).sort()).toEqual(ITEM_ICONS.map((i) => `item.${i}`).sort());
    expect(new Set(ITEM_BASES.map((b) => b.id)).size).toBe(ITEM_BASES.length);
  });

  it('gives every tier 2–3 base its own icon named after the base (ticket A.4)', () => {
    // Boss-exclusive bases (ticket 2.5) borrow an existing icon until they get their own art.
    const regular = ITEM_BASES.filter((b) => !b.unique);
    for (const b of regular.filter((b) => b.tier !== 1)) expect(b.icon, b.id).toBe(`item.${b.id}`);
    expect(new Set(regular.map((b) => b.icon)).size).toBe(regular.length);
  });

  it('has a tier 2 and a tier 3 base per slot kind with art and per weapon family', () => {
    const families = (b: (typeof ITEM_BASES)[number]) =>
      b.slot === 'weapon' ? `weapon:${[...b.classes].sort().join('+')}` : b.slot;
    const tier1 = new Set(ITEM_BASES.filter((b) => b.tier === 1).map(families));
    for (const tier of [2, 3] as const) {
      const bases = ITEM_BASES.filter((b) => b.tier === tier && !b.unique);
      expect(new Set(bases.map(families))).toEqual(tier1);
      expect(bases.length).toBe(tier1.size);
    }
  });

  it('makes higher tiers stronger at the same item level and later to drop', () => {
    const family = (b: (typeof ITEM_BASES)[number]) =>
      b.slot === 'weapon' ? `weapon:${[...b.classes].sort().join('+')}` : b.slot;
    const total = (b: (typeof ITEM_BASES)[number], level: number) =>
      b.stats.reduce((s, x) => s + x.base + x.perLevel * (level - 1), 0);
    for (const tier of [2, 3] as const) {
      for (const b of ITEM_BASES.filter((x) => x.tier === tier)) {
        const lower = ITEM_BASES.filter((x) => x.tier === tier - 1 && family(x) === family(b));
        expect(lower.length, b.id).toBeGreaterThan(0);
        for (const l of lower) {
          expect(b.minItemLevel, b.id).toBeGreaterThan(l.minItemLevel);
          expect(total(b, b.minItemLevel), `${b.id} vs ${l.id}`).toBeGreaterThan(
            total(l, b.minItemLevel),
          );
        }
      }
    }
  });

  it('maps every slot kind onto the 12 equipment slots', () => {
    const covered = ITEM_SLOT_KINDS.flatMap((k) => equipmentSlotsForKind(k));
    expect([...covered].sort()).toEqual([...EQUIPMENT_SLOT_IDS].sort());
    expect(itemFitsSlot(getItemBase('iron-ring'), 'ring1')).toBe(true);
    expect(itemFitsSlot(getItemBase('iron-ring'), 'ring2')).toBe(true);
    expect(itemFitsSlot(getItemBase('iron-ring'), 'neck')).toBe(false);
  });

  it('uses valid stats, classes and levels', () => {
    for (const base of ITEM_BASES) {
      expect(base.classes.length).toBeGreaterThan(0);
      expect(base.minItemLevel).toBeGreaterThanOrEqual(1);
      expect(base.minItemLevel).toBeLessThanOrEqual(DEFAULT_LOOT_CONFIG.maxItemLevel);
      for (const s of base.stats) expect(isCoreStatId(s.stat)).toBe(true);
    }
  });

  it('restricts weapons and shields by class and leaves armor and jewelry open', () => {
    expect(canClassUseItem(getItemBase('longsword'), 'warrior')).toBe(true);
    expect(canClassUseItem(getItemBase('longsword'), 'mage')).toBe(false);
    expect(canClassUseItem(getItemBase('skull-staff'), 'warlock')).toBe(true);
    expect(canClassUseItem(getItemBase('hunting-bow'), 'hunter')).toBe(true);
    expect(canClassUseItem(getItemBase('round-shield'), 'hunter')).toBe(false);
    for (const cls of CLASS_IDS) {
      expect(ITEM_BASES.some((b) => b.slot === 'weapon' && canClassUseItem(b, cls))).toBe(true);
    }
    for (const base of ITEM_BASES.filter((b) => b.slot !== 'weapon' && b.slot !== 'offhand')) {
      expect([...base.classes].sort()).toEqual([...CLASS_IDS].sort());
    }
  });
});

describe('affixes', () => {
  it('covers the Phase 1 affix pool', () => {
    expect(AFFIXES.map((a) => a.stat).sort()).toEqual(
      [
        'armor',
        'attackSpeed',
        'critChance',
        'critDamage',
        'goldFind',
        'health',
        'magicDamage',
        'physicalDamage',
        'resistance',
      ].sort(),
    );
  });

  it('has well-formed tiers with a level-1 tier', () => {
    for (const affix of AFFIXES) {
      expect(new Set(AFFIXES.map((a) => a.id)).size).toBe(AFFIXES.length);
      expect(affix.tiers.some((t) => t.minItemLevel === 1)).toBe(true);
      let prevMax = -Infinity;
      for (const t of affix.tiers) {
        expect(t.min).toBeLessThanOrEqual(t.max);
        expect(t.min).toBeGreaterThan(prevMax);
        expect(t.weight).toBeGreaterThan(0);
        prevMax = t.max;
        const steps = (t.max - t.min) / affix.step;
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
      }
    }
  });

  it('offers every slot that has bases enough affixes for the rarest tier', () => {
    const maxAffixes = Math.max(
      ...Object.values(DEFAULT_LOOT_CONFIG.rarities).map((r) => r.affixCount),
    );
    for (const slot of new Set(ITEM_BASES.map((b) => b.slot))) {
      expect(affixesForSlot(slot).length).toBeGreaterThanOrEqual(maxAffixes);
    }
  });
});
