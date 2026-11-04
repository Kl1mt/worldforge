import { describe, expect, it } from 'vitest';
import {
  CLASSES,
  CLASS_IDS,
  CORE_STATS,
  CORE_STAT_IDS,
  EQUIPMENT_SLOTS,
  EQUIPMENT_SLOT_IDS,
  RARITIES,
  RARITY_IDS,
  RESOURCES,
  compareRarity,
  getClass,
  getGameContent,
  isClassId,
  isCoreStatId,
  isEquipmentSlotId,
  isRarityId,
} from './index.js';

const ids = (defs: readonly { id: string }[]) => defs.map((d) => d.id);

describe('classes', () => {
  it('defines the four starting classes with their resources', () => {
    expect(CLASSES.map((c) => [c.id, c.resource])).toEqual([
      ['warrior', 'rage'],
      ['mage', 'mana'],
      ['hunter', 'focus'],
      ['warlock', 'soulFragments'],
    ]);
    expect(ids(CLASSES)).toEqual([...CLASS_IDS]);
  });

  it('references only defined resources', () => {
    const resourceIds = ids(RESOURCES);
    for (const c of CLASSES) expect(resourceIds).toContain(c.resource);
  });

  it('looks up and validates class ids', () => {
    expect(getClass('warlock').name).toBe('Warlock');
    expect(isClassId('mage')).toBe(true);
    expect(isClassId('paladin')).toBe(false);
    expect(isClassId(3)).toBe(false);
  });
});

describe('rarities', () => {
  it('has the six rarities in order with matching tiers', () => {
    expect([...RARITY_IDS]).toEqual(['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']);
    expect(ids(RARITIES)).toEqual([...RARITY_IDS]);
    RARITIES.forEach((r, i) => expect(r.tier).toBe(i));
  });

  it('compares and validates rarities', () => {
    expect(compareRarity('common', 'mythic')).toBeLessThan(0);
    expect(compareRarity('epic', 'rare')).toBeGreaterThan(0);
    expect(compareRarity('rare', 'rare')).toBe(0);
    expect(isRarityId('legendary')).toBe(true);
    expect(isRarityId('artifact')).toBe(false);
  });
});

describe('equipment slots', () => {
  it('has the twelve slots in canonical order', () => {
    expect([...EQUIPMENT_SLOT_IDS]).toEqual([
      'head',
      'shoulders',
      'chest',
      'hands',
      'legs',
      'feet',
      'neck',
      'ring1',
      'ring2',
      'weapon',
      'offhand',
      'relic',
    ]);
    expect(ids(EQUIPMENT_SLOTS)).toEqual([...EQUIPMENT_SLOT_IDS]);
    expect(isEquipmentSlotId('ring2')).toBe(true);
    expect(isEquipmentSlotId('ring3')).toBe(false);
  });
});

describe('core stats', () => {
  it('covers the GDD §6.2 stats', () => {
    expect(ids(CORE_STATS)).toEqual([...CORE_STAT_IDS]);
    expect(isCoreStatId('armor')).toBe(true);
    expect(isCoreStatId('goldFind')).toBe(false);
  });
});

describe('getGameContent', () => {
  it('bundles all definitions and is JSON-serialisable', () => {
    const content = getGameContent();
    expect(content.classes).toHaveLength(4);
    expect(content.rarities).toHaveLength(6);
    expect(content.equipmentSlots).toHaveLength(12);
    expect(JSON.parse(JSON.stringify(content))).toEqual(content);
  });

  it('has unique ids in every collection', () => {
    const c = getGameContent();
    for (const list of [c.classes, c.resources, c.rarities, c.equipmentSlots, c.stats]) {
      expect(new Set(ids(list)).size).toBe(list.length);
    }
  });
});
