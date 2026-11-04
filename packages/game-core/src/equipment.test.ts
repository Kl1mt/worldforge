import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  EQUIPMENT_SLOT_IDS,
  ITEM_BASES,
  checkEquip,
  defaultEquipSlot,
  deriveCharacterStats,
  deriveEquippedStats,
  equipmentSlotsForKind,
  generateItem,
  getImplicitStats,
  itemSecondaryModifiers,
  itemStatContribution,
  validateItem,
  type GeneratedItem,
} from './index.js';

const sword: GeneratedItem = {
  seed: 1,
  baseId: 'longsword-notched',
  rarityId: 'rare',
  itemLevel: 10,
  affixes: [
    { affixId: 'physical-damage', tier: 2, value: 6 },
    { affixId: 'gold-find', tier: 1, value: 0.05 },
  ],
};

describe('itemStatContribution', () => {
  it('sums implicit stats and core-stat affixes, leaving gold find out', () => {
    const implicit = getImplicitStats(sword)[0]!;
    expect(implicit.stat).toBe('physicalDamage');
    expect(itemStatContribution(sword)).toEqual({ physicalDamage: implicit.value + 6 });
    expect(itemSecondaryModifiers(sword)).toEqual({ goldFind: 0.05 });
  });

  it('ignores unknown affixes and throws on unknown bases', () => {
    const odd = { ...sword, affixes: [{ affixId: 'nope', tier: 1, value: 99 }] };
    expect(itemStatContribution(odd)).toEqual({
      physicalDamage: getImplicitStats(sword)[0]!.value,
    });
    expect(() => itemStatContribution({ ...sword, baseId: 'nope' })).toThrow();
  });

  it('only contains finite core stats for many generated items', () => {
    for (let seed = 0; seed < 500; seed++) {
      const item = generateItem({ seed, itemLevel: 1 + (seed % 30) })!;
      expect(validateItem(item)).toEqual([]);
      for (const value of Object.values(itemStatContribution(item))) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });
});

describe('deriveEquippedStats', () => {
  it('equals deriveCharacterStats with the items’ contributions', () => {
    expect(deriveEquippedStats('warrior', 5, [sword])).toEqual(
      deriveCharacterStats('warrior', 5, [itemStatContribution(sword)]),
    );
    expect(deriveEquippedStats('warrior', 5, [])).toEqual(deriveCharacterStats('warrior', 5));
    expect(deriveEquippedStats('warrior', 5, [sword]).physicalDamage).toBeGreaterThan(
      deriveCharacterStats('warrior', 5).physicalDamage,
    );
  });
});

describe('checkEquip', () => {
  it('accepts every base in its own slots for allowed classes', () => {
    for (const base of ITEM_BASES) {
      for (const classId of CLASS_IDS) {
        for (const slot of equipmentSlotsForKind(base.slot)) {
          const expected = base.classes.includes(classId)
            ? { ok: true }
            : { ok: false, reason: 'wrong_class' };
          expect(checkEquip(base.id, classId, slot)).toEqual(expected);
        }
      }
    }
  });

  it('rejects wrong slots and unknown bases', () => {
    expect(checkEquip('iron-helm', 'warrior', 'chest')).toEqual({
      ok: false,
      reason: 'wrong_slot',
    });
    expect(checkEquip('brass-ring', 'mage', 'neck')).toEqual({ ok: false, reason: 'wrong_slot' });
    expect(checkEquip('nope', 'mage', 'head')).toEqual({ ok: false, reason: 'unknown_base' });
    // A slot check comes before the class check: a staff never fits the head slot.
    expect(checkEquip('skull-staff', 'warrior', 'head')).toEqual({
      ok: false,
      reason: 'wrong_slot',
    });
  });

  it('accepts rings in both ring slots', () => {
    expect(checkEquip('brass-ring', 'hunter', 'ring1')).toEqual({ ok: true });
    expect(checkEquip('brass-ring', 'hunter', 'ring2')).toEqual({ ok: true });
  });
});

describe('defaultEquipSlot', () => {
  it('picks the first free ring slot', () => {
    expect(defaultEquipSlot('iron-ring', new Set())).toBe('ring1');
    expect(defaultEquipSlot('iron-ring', new Set(['ring1']))).toBe('ring2');
    expect(defaultEquipSlot('iron-ring', new Set(['ring1', 'ring2']))).toBe('ring1');
  });

  it('uses the only slot for other bases', () => {
    expect(defaultEquipSlot('iron-helm', new Set(EQUIPMENT_SLOT_IDS))).toBe('head');
    expect(defaultEquipSlot('nope', new Set())).toBeUndefined();
  });
});
