import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  AFFIX_BONUS_STATS,
  ITEM_SETS,
  affixAllowedOn,
  combineEffects,
  equipmentModifiers,
  generateItem,
  getItemBase,
  itemEffectInstances,
  itemStatContribution,
  setBonusInstances,
  type EquippedItem,
} from '../index.js';
import { bestBase } from '../balance/builds.js';
import {
  DEFAULT_AWAKENING_SETTINGS,
  awakenItem,
  awakenedAffix,
  awakenedEffectStrength,
  awakeningCost,
  awakeningRefusal,
  evaluationSettings,
  type AwakenableItem,
} from './awakening.js';

/** Tickets 6.5 and 6.5b: the Item Awakening rules (docs/AWAKENING.md). */

const legendary = (overrides: Partial<AwakenableItem> = {}): AwakenableItem => {
  const base = bestBase('warrior', 'weapon', 37);
  const item = generateItem({
    seed: 7,
    itemLevel: 37,
    baseId: base.id,
    rarityId: 'legendary',
    classId: 'warrior',
  })!;
  return {
    ...item,
    effectId: 'tyrants-bane',
    effectRoll: 0.5,
    upgradeLevel: 10,
    ...overrides,
  } as AwakenableItem;
};

/** A core combat affix the item may roll and doesn't carry (what option (a) offers). */
const freeAffix = (item: AwakenableItem) =>
  AFFIXES.find(
    (a) =>
      AFFIX_BONUS_STATS.has(a.stat) &&
      a.stat !== 'bossDamage' &&
      a.stat !== 'skillDamage' &&
      affixAllowedOn(a, getItemBase(item.baseId), 'warrior') &&
      !item.affixes.some((x) => x.affixId === a.id),
  )!;

const B = evaluationSettings({ option: 'effect', effectStrength: 1.25 });
const A = evaluationSettings({ option: 'affixSlot', affixValueShare: 1 });

describe('the shipped rule (ticket 6.5b)', () => {
  it("is option (b) at × 1.1 with the owner's price, and on (no switch)", () => {
    expect(DEFAULT_AWAKENING_SETTINGS).toMatchObject({
      option: 'effect',
      rarities: ['legendary', 'mythic'],
      upgradeLevel: 10,
      minItemLevel: 23,
      effectStrength: 1.1,
      cost: { tyrantsEmber: 3, gravewardenSeal: 2, goldAtItemLevel20: 15_000, soulShard: 30 },
    });
    const item = legendary();
    const r = awakenItem(item);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.awakening).toEqual({ option: 'effect', effectStrength: 1.1 });
    expect(awakeningRefusal(item)).toBeNull();
    // About 25,000 gold at the Tyrant's item level (docs/AWAKENING.md "Costs and sinks").
    expect(awakeningCost({ itemLevel: 37 })).toEqual({
      gold: 25_200,
      tyrantsEmber: 3,
      gravewardenSeal: 2,
      soulShard: 30,
    });
  });

  it('is frozen, so nothing can change it in place', () => {
    expect(Object.isFrozen(DEFAULT_AWAKENING_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_AWAKENING_SETTINGS.cost)).toBe(true);
  });

  it('never changes its input', () => {
    const item = legendary();
    const copy = JSON.parse(JSON.stringify(item)) as AwakenableItem;
    awakenItem(item, B);
    awakenItem(item, A, { affixId: 'health', roll: 1, classId: 'warrior' });
    expect(item).toEqual(copy);
  });
});

describe('eligibility', () => {
  it('needs a Legendary or Mythic at +10, item level 23+, not yet awakened', () => {
    expect(awakeningRefusal(legendary(), B)).toBeNull();
    expect(awakeningRefusal(legendary({ rarityId: 'epic' }), B)).toBe('rarity');
    expect(awakeningRefusal(legendary({ upgradeLevel: 9 }), B)).toBe('upgrade_level');
    expect(awakeningRefusal(legendary({ itemLevel: 22 }), B)).toBe('item_level');
    expect(awakeningRefusal(legendary({ itemLevel: 23 }), B)).toBeNull();
    const awakened = awakenItem(legendary(), B);
    expect(awakened.ok).toBe(true);
    if (awakened.ok) expect(awakeningRefusal(awakened.item, B)).toBe('already_awakened');
  });

  it('option (b) needs an effect or a set; option (a) does not', () => {
    const plain = legendary({ effectId: null, effectRoll: null });
    expect(awakeningRefusal(plain, B)).toBe('nothing_to_awaken');
    expect(awakeningRefusal(plain, A)).toBeNull();
  });

  it('Void and Prismatic items are eligible and keep their variant', () => {
    for (const variant of ['void', 'prismatic'] as const) {
      const r = awakenItem(legendary({ variant }), B);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.item.variant).toBe(variant);
    }
  });
});

describe('costs', () => {
  it('scale the gold like the Forge and keep the boss materials fixed', () => {
    expect(awakeningCost({ itemLevel: 20 }, B).gold).toBe(15_000);
    expect(awakeningCost({ itemLevel: 37 }, B)).toEqual({
      gold: 25_200,
      tyrantsEmber: 3,
      gravewardenSeal: 2,
      soulShard: 30,
    });
    const r = awakenItem(legendary(), B);
    expect(r.ok && r.cost).toEqual(awakeningCost({ itemLevel: 37 }, B));
  });
});

describe('option (b): an awakened effect', () => {
  it('multiplies the effect’s magnitudes, and Void’s strength with it', () => {
    const plain = legendary();
    expect(itemEffectInstances(plain)).toEqual([{ effectId: 'tyrants-bane', roll: 0.5 }]);
    const r = awakenItem(plain, B);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(awakenedEffectStrength(r.item)).toBe(1.25);
    expect(itemEffectInstances(r.item)).toEqual([
      { effectId: 'tyrants-bane', roll: 0.5, strength: 1.25 },
    ]);
    const before = combineEffects(itemEffectInstances(plain), 'warrior');
    const after = combineEffects(itemEffectInstances(r.item), 'warrior');
    expect(before.bossSlayer).toBeCloseTo(0.15, 6);
    expect(after.bossSlayer).toBeCloseTo(before.bossSlayer * 1.25, 6);
    const v = awakenItem(legendary({ variant: 'void' }), B);
    expect(v.ok && itemEffectInstances(v.item)[0]!.strength).toBeCloseTo(1.1 * 1.25, 12);
  });

  it('leaves base values and affixes alone', () => {
    const plain = legendary();
    const r = awakenItem(plain, B);
    expect(r.ok && itemStatContribution(r.item)).toEqual(itemStatContribution(plain));
    expect(r.ok && r.item.affixes).toEqual(plain.affixes);
  });

  it('awakens a set bonus of n pieces once n distinct worn pieces are awakened', () => {
    const set = ITEM_SETS.find((s) => s.id === 'drowned-vigil')!;
    const pieces: EquippedItem[] = set.pieces.slice(0, 4).map((baseId, i) => ({
      ...generateItem({ seed: 40 + i, itemLevel: 33, baseId, classId: 'warrior' })!,
      upgradeLevel: 10,
    }));
    const plain = setBonusInstances(pieces);
    expect(plain.map((i) => i.strength)).toEqual([undefined, undefined]);
    const awake = (n: number) =>
      pieces.map((p, i) => {
        if (i >= n) return p;
        const r = awakenItem(p as AwakenableItem, B);
        expect(r.ok, getItemBase(p.baseId).id).toBe(true);
        return r.ok ? r.item : p;
      });
    expect(setBonusInstances(awake(1))).toEqual(plain);
    expect(setBonusInstances(awake(2)).map((i) => i.strength)).toEqual([1.25, undefined]);
    expect(setBonusInstances(awake(4)).map((i) => i.strength)).toEqual([1.25, 1.25]);
    // Two copies of one awakened piece are one piece.
    const twice = [awake(1)[0]!, awake(1)[0]!, ...pieces.slice(1)];
    expect(setBonusInstances(twice)).toEqual(plain);
  });

  it('a reader ignores a strength outside (1, 2] and any other shape', () => {
    for (const effectStrength of [1, 0.5, Number.NaN, Infinity, 5]) {
      const item = { ...legendary(), awakening: { option: 'effect' as const, effectStrength } };
      expect(itemEffectInstances(item)).toEqual(itemEffectInstances(legendary()));
    }
    const slot = { ...legendary(), awakening: { option: 'affixSlot' as const, affixIndex: 9 } };
    expect(itemEffectInstances(slot)).toEqual(itemEffectInstances(legendary()));
  });
});

describe('option (a): an extra affix', () => {
  it('adds the picked affix at the item’s top tier, rolled in its range', () => {
    const plain = legendary();
    expect(plain.affixes).toHaveLength(4);
    const free = freeAffix(plain);
    const pick = free.id;
    const low = awakenedAffix(plain, { affixId: pick, roll: 0, classId: 'warrior' });
    const high = awakenedAffix(plain, { affixId: pick, roll: 1, classId: 'warrior' });
    expect(typeof low).not.toBe('string');
    expect(typeof high).not.toBe('string');
    if (typeof low === 'string' || typeof high === 'string') return;
    expect(low.tier).toBe(high.tier);
    expect(high.value).toBeGreaterThan(low.value);
    const r = awakenItem(plain, A, { affixId: pick, roll: 1, classId: 'warrior' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.affixes).toHaveLength(5);
    expect(r.item.affixes.at(-1)).toEqual(high);
    expect(r.item.awakening).toEqual({ option: 'affixSlot', affixIndex: 4 });
    const before = itemStatContribution(plain);
    const after = itemStatContribution(r.item);
    const stat = free.stat as 'health';
    expect((after[stat] ?? 0) - (before[stat] ?? 0)).toBe(high.value);
  });

  it('the prototype’s tuning rolls half an affix, on the step grid, at least one step', () => {
    expect(DEFAULT_AWAKENING_SETTINGS.affixValueShare).toBe(0.5);
    const plain = legendary();
    const free = freeAffix(plain);
    const choice = { affixId: free.id, roll: 1, classId: 'warrior' as const };
    const full = awakenedAffix(plain, choice);
    const half = awakenedAffix(plain, choice, 0.5);
    const none = awakenedAffix(plain, choice, 0);
    if (typeof full === 'string' || typeof half === 'string' || typeof none === 'string') {
      throw new Error('refused');
    }
    expect(half.value).toBeCloseTo(Math.round(full.value / 2 / free.step) * free.step, 6);
    expect(none.value).toBe(free.step);
    const r = awakenItem(plain, evaluationSettings({ option: 'affixSlot' }), choice);
    expect(r.ok && r.item.affixes.at(-1)).toEqual(half);
  });

  it('refuses an affix the item carries, an unknown one, or one its slot cannot roll', () => {
    const plain = legendary();
    const own = plain.affixes[0]!.affixId;
    expect(awakenedAffix(plain, { affixId: own, roll: 0.5, classId: 'warrior' })).toBe(
      'affix_present',
    );
    expect(awakenedAffix(plain, { affixId: 'nope', roll: 0.5, classId: 'warrior' })).toBe(
      'affix_missing',
    );
    // A weapon never rolls resistance (an armour affix).
    expect(awakenedAffix(plain, { affixId: 'resistance', roll: 0.5, classId: 'warrior' })).toBe(
      'affix_not_allowed',
    );
    expect(awakenItem(plain, A)).toEqual({ ok: false, reason: 'affix_missing' });
  });

  it('a Prismatic item reads the extra affix × 1.1 like its others', () => {
    const plain = legendary({ variant: 'prismatic' });
    const free = freeAffix(plain);
    const pick = free.id;
    const r = awakenItem(plain, A, { affixId: pick, roll: 1, classId: 'warrior' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const stat = free.stat as 'health';
    const added =
      (itemStatContribution(r.item)[stat] ?? 0) - (itemStatContribution(plain)[stat] ?? 0);
    expect(added).toBe(Math.round(r.item.affixes.at(-1)!.value * 1.1));
  });
});

describe('equipment with no awakening reads exactly as before', () => {
  it('an explicit null awakening changes no modifier', () => {
    const items = [legendary(), legendary({ variant: 'void' })];
    const nulls = items.map((i) => ({ ...i, awakening: null }));
    expect(equipmentModifiers(nulls, undefined, undefined, { classId: 'warrior' })).toEqual(
      equipmentModifiers(items, undefined, undefined, { classId: 'warrior' }),
    );
  });
});
