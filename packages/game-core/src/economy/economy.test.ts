import { describe, expect, it } from 'vitest';
import { CLASS_IDS } from '../classes.js';
import { RARITY_IDS } from '../rarity.js';
import { ITEM_BASES, canClassUseItem, getItemBase } from '../items/bases.js';
import { validateItem } from '../loot/validate.js';
import { AREA_IDS, getArea } from '../world/areas.js';
import { isMaterialId } from '../world/materials.js';
import {
  DEFAULT_ECONOMY_CONFIG,
  FORGE_RECIPES,
  buyPrice,
  craftBlockers,
  craftItem,
  findForgeRecipe,
  merchantDay,
  merchantRestockAt,
  merchantStock,
  parseOfferId,
  recipeSlots,
  salvageYield,
  sellPrice,
  sumYields,
} from './index.js';

const CHARACTER = '0190f000-0000-7000-8000-000000000001';

describe('prices', () => {
  it('grow with item level and rarity, and buying always costs more than selling or salvaging pays', () => {
    for (const rarityId of RARITY_IDS) {
      for (let itemLevel = 1; itemLevel <= 60; itemLevel++) {
        const item = { baseId: 'iron-helm', rarityId, itemLevel };
        const sell = sellPrice(item);
        expect(Number.isInteger(sell)).toBe(true);
        expect(sell).toBeGreaterThanOrEqual(1);
        expect(buyPrice(item)).toBeGreaterThan(sell);
        expect(salvageYield(item).gold).toBeLessThan(Math.max(2, sell));
        if (itemLevel > 1) {
          expect(sell).toBeGreaterThanOrEqual(sellPrice({ rarityId, itemLevel: itemLevel - 1 }));
        }
      }
    }
    expect(sellPrice({ rarityId: 'rare', itemLevel: 10 })).toBeGreaterThan(
      sellPrice({ rarityId: 'common', itemLevel: 10 }),
    );
  });
});

describe('merchant stock', () => {
  const params = {
    characterId: CHARACTER,
    classId: 'mage' as const,
    day: '2026-11-04',
    areaIds: ['abandonedFields', 'crowwood'] as const,
  };

  it('is deterministic per character and day, and changes with either', () => {
    const a = merchantStock(params);
    expect(merchantStock(params)).toEqual(a);
    expect(merchantStock({ ...params, day: '2026-11-05' })).not.toEqual(a);
    expect(merchantStock({ ...params, characterId: `${CHARACTER.slice(0, -1)}2` })).not.toEqual(a);
  });

  it('offers basic, class-usable gear of each unlocked area within its levels', () => {
    for (const classId of CLASS_IDS) {
      const stock = merchantStock({ ...params, classId, areaIds: AREA_IDS });
      expect(stock).toHaveLength(AREA_IDS.length * DEFAULT_ECONOMY_CONFIG.merchant.offersPerArea);
      for (const offer of stock) {
        const area = getArea(offer.areaId);
        expect(['common', 'uncommon']).toContain(offer.item.rarityId);
        expect(offer.item.itemLevel).toBeGreaterThanOrEqual(area.minLevel);
        expect(offer.item.itemLevel).toBeLessThanOrEqual(area.maxLevel);
        expect(canClassUseItem(getItemBase(offer.item.baseId), classId)).toBe(true);
        expect(validateItem(offer.item)).toEqual([]);
        expect(offer.price).toBe(buyPrice(offer.item));
        expect(parseOfferId(offer.offerId)).toMatchObject({ day: params.day, areaId: area.id });
      }
    }
  });

  it('adds a newly unlocked area without changing the existing offers', () => {
    const before = merchantStock({ ...params, areaIds: ['abandonedFields'] });
    const after = merchantStock(params);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it('parses only well-formed offer ids', () => {
    expect(parseOfferId('2026-11-04.crowwood.1')).toEqual({
      day: '2026-11-04',
      areaId: 'crowwood',
      index: 1,
    });
    for (const bad of ['', '2026-11-04.mordor.1', '2026-11-04.crowwood', 'x.crowwood.1']) {
      expect(parseOfferId(bad)).toBeNull();
    }
  });

  it('restocks at UTC midnight', () => {
    const now = new Date('2026-11-04T23:59:59.000Z');
    expect(merchantDay(now)).toBe('2026-11-04');
    expect(merchantRestockAt(now).toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });
});

describe('salvage', () => {
  it('gives tier materials by rarity, plus soul shards from rare up', () => {
    expect(salvageYield({ baseId: 'iron-helm', rarityId: 'common', itemLevel: 5 })).toEqual({
      gold: 1,
      materials: { timber: 1 },
    });
    expect(salvageYield({ baseId: 'barbute', rarityId: 'rare', itemLevel: 10 }).materials).toEqual({
      rawHide: 2,
      timber: 2,
      soulShard: 1,
    });
    expect(
      salvageYield({ baseId: 'great-helm', rarityId: 'epic', itemLevel: 16 }).materials,
    ).toEqual({
      ironOre: 6,
      soulShard: 2,
    });
  });

  it('sums yields', () => {
    const a = salvageYield({ baseId: 'iron-helm', rarityId: 'common', itemLevel: 5 });
    const b = salvageYield({ baseId: 'barbute', rarityId: 'rare', itemLevel: 10 });
    expect(sumYields([a, b])).toEqual({
      gold: a.gold + b.gold,
      materials: { timber: 3, rawHide: 2, soulShard: 1 },
    });
  });
});

describe('forge recipes', () => {
  it('are valid content', () => {
    expect(new Set(FORGE_RECIPES.map((r) => r.id)).size).toBe(FORGE_RECIPES.length);
    for (const r of FORGE_RECIPES) {
      expect(findForgeRecipe(r.id)).toBe(r);
      expect(r.materials.every((m) => isMaterialId(m.materialId) && m.quantity > 0)).toBe(true);
      expect(r.rarities.common ?? 0).toBe(0);
      for (const classId of CLASS_IDS) {
        expect(recipeSlots(r, classId)).toContain('weapon');
        expect(recipeSlots(r, classId)).toContain('chest');
      }
    }
  });

  it('craft the chosen slot and tier, usable by the class, deterministically per seed', () => {
    for (const recipe of FORGE_RECIPES) {
      for (const classId of CLASS_IDS) {
        for (const slot of recipeSlots(recipe, classId)) {
          for (let seed = 1; seed <= 20; seed++) {
            const params = { recipe, classId, level: recipe.level, slot, seed };
            const item = craftItem(params)!;
            const base = getItemBase(item.baseId);
            expect(base.slot).toBe(slot);
            expect(base.tier).toBe(recipe.tier);
            expect(canClassUseItem(base, classId)).toBe(true);
            expect(item.rarityId).not.toBe('common');
            expect(item.itemLevel).toBeGreaterThanOrEqual(base.minItemLevel);
            expect(validateItem(item)).toEqual([]);
            expect(craftItem(params)).toEqual(item);
          }
        }
      }
    }
  });

  it('craft nothing for a slot the class cannot fill', () => {
    const t1 = findForgeRecipe('fieldsmithWork')!;
    expect(recipeSlots(t1, 'mage')).not.toContain('offhand');
    expect(
      craftItem({ recipe: t1, classId: 'mage', level: 5, slot: 'offhand', seed: 1 }),
    ).toBeNull();
    expect(ITEM_BASES.some((b) => b.slot === 'legs')).toBe(false);
  });

  it('report level, gold and material blockers', () => {
    const t2 = findForgeRecipe('marchwardenWork')!;
    expect(craftBlockers(t2, { level: 3, gold: 10 }, { timber: 20, rawHide: 1 })).toEqual([
      { kind: 'level', required: 9 },
      { kind: 'gold', required: 150, held: 10 },
      { kind: 'material', materialId: 'rawHide', required: 25, held: 1 },
      { kind: 'material', materialId: 'timber', required: 25, held: 20 },
      { kind: 'material', materialId: 'soulShard', required: 4, held: 0 },
    ]);
    expect(
      craftBlockers(t2, { level: 9, gold: 150 }, { timber: 25, rawHide: 25, soulShard: 4 }),
    ).toEqual([]);
  });

  it('Tyrantforged Work (ticket 6.2): the Forge Tyrant’s ember is its sink, one per item', () => {
    const r = findForgeRecipe('tyrantforgedWork')!;
    expect(r.tier).toBe(4);
    expect(r.materials.find((m) => m.materialId === 'tyrantsEmber')?.quantity).toBe(1);
    // It is the only use of the ember, and the ember is only a boss drop.
    expect(
      FORGE_RECIPES.filter((x) => x.materials.some((m) => m.materialId === 'tyrantsEmber')),
    ).toEqual([r]);
    // Never below Rare, and never above the Depths' top item level, whatever the hero's level.
    expect(Object.keys(r.rarities).sort()).toEqual(['epic', 'rare']);
    for (const level of [36, 40, 41, 50, 60]) {
      for (let seed = 1; seed <= 30; seed++) {
        const item = craftItem({ recipe: r, classId: 'warrior', level, slot: 'chest', seed })!;
        expect(item.itemLevel).toBe(Math.min(level, 41));
        expect(['rare', 'epic']).toContain(item.rarityId);
        expect(validateItem(item)).toEqual([]);
      }
    }
    // Older recipes keep their uncapped item level (no stored craft changes).
    const t3 = findForgeRecipe('knightlyWork')!;
    expect(t3.maxItemLevel).toBeUndefined();
    expect(
      craftItem({ recipe: t3, classId: 'warrior', level: 50, slot: 'chest', seed: 1 })!.itemLevel,
    ).toBe(50);
    // Without the ember, nothing.
    const held = { ironOre: 60, soulShard: 12 };
    expect(craftBlockers(r, { level: 36, gold: 3_000 }, held)).toEqual([
      { kind: 'material', materialId: 'tyrantsEmber', required: 1, held: 0 },
    ]);
    expect(craftBlockers(r, { level: 36, gold: 3_000 }, { ...held, tyrantsEmber: 1 })).toEqual([]);
  });
});
