import { describe, expect, it } from 'vitest';
import {
  awakenItem,
  awakeningErrors,
  awakeningPreview,
  checkEquipment,
  generateItem,
  itemBinding,
  itemEffectInstances,
  setBonusInstances,
  validateItem,
  type AwakenableItem,
  type GeneratedItem,
  type ScoredItem,
} from '../index.js';
import { bestBase } from '../balance/builds.js';

/** Ticket 6.5b: the shipped Item Awakening rule (docs/AWAKENING.md "As built"). */

const AWAKE = { option: 'effect', effectStrength: 1.1 } as const;

const weapon = (overrides: Record<string, unknown> = {}) => {
  const base = bestBase('warrior', 'weapon', 37);
  const item = generateItem({
    seed: 11,
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
  } as AwakenableItem & GeneratedItem;
};

const vigil = (baseId: string, awakened: boolean) => {
  const item = generateItem({
    seed: 3,
    itemLevel: 37,
    baseId,
    rarityId: 'legendary',
    classId: 'warrior',
  })!;
  expect(item.setId).toBe('drowned-vigil');
  return {
    ...item,
    upgradeLevel: 10,
    ...(awakened ? { awakening: { ...AWAKE } } : {}),
  } as AwakenableItem & GeneratedItem;
};

describe('eligibility', () => {
  it('a +10 Legendary at item level 23+ with an effect may awaken; everything else is refused', () => {
    expect(awakenItem(weapon()).ok).toBe(true);
    expect(awakenItem(weapon({ upgradeLevel: 9 }))).toEqual({
      ok: false,
      reason: 'upgrade_level',
    });
    expect(awakenItem(weapon({ itemLevel: 22 }))).toEqual({ ok: false, reason: 'item_level' });
    expect(awakenItem(weapon({ itemLevel: 23 })).ok).toBe(true);
    expect(awakenItem(weapon({ rarityId: 'epic' }))).toEqual({ ok: false, reason: 'rarity' });
    expect(awakenItem(weapon({ effectId: undefined, effectRoll: undefined }))).toEqual({
      ok: false,
      reason: 'nothing_to_awaken',
    });
    expect(awakenItem(weapon({ awakening: { ...AWAKE } }))).toEqual({
      ok: false,
      reason: 'already_awakened',
    });
    // Void and Prismatic items may awaken; the variant is untouched.
    for (const variant of ['void', 'prismatic'] as const) {
      const r = awakenItem(weapon({ variant }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.item.variant).toBe(variant);
    }
    // A set piece (no effect of its own) awakens toward its set.
    expect(awakenItem(vigil('vigil-helm', false)).ok).toBe(true);
  });
});

describe('validation', () => {
  it('validateItem accepts only the shipped awakening on an eligible item', () => {
    const ok = weapon({ awakening: { ...AWAKE } });
    expect(validateItem(ok)).toEqual([]);
    expect(awakeningErrors({ ...ok })).toEqual([]);
    const bad = (a: unknown, extra: Record<string, unknown> = {}) =>
      validateItem({ ...weapon(), ...extra, awakening: a } as unknown as GeneratedItem);
    expect(bad({ option: 'effect', effectStrength: 1.25 })).not.toEqual([]);
    expect(bad({ option: 'affixSlot', affixIndex: 4 })).not.toEqual([]);
    expect(bad({ option: 'effect', effectStrength: 1.1, extra: 1 })).not.toEqual([]);
    expect(bad('awake')).not.toEqual([]);
    expect(bad(AWAKE, { itemLevel: 22 })).not.toEqual([]);
    expect(bad(AWAKE, { effectId: undefined, effectRoll: undefined })).not.toEqual([]);
    expect(awakeningErrors({ ...ok, upgradeLevel: 9 })).not.toEqual([]);
  });

  it('scoring rejects an awakened item below +10 (it counts 0)', () => {
    const item = weapon({ awakening: { ...AWAKE } });
    const scored = (upgradeLevel: number): ScoredItem => ({
      ...item,
      slot: 'weapon',
      upgradeLevel,
    });
    const [at10] = checkEquipment('warrior', [scored(10)]);
    expect(at10!.rejection).toBeNull();
    expect(at10!.equipped?.awakening).toEqual(AWAKE);
    expect(checkEquipment('warrior', [scored(9)])[0]!.rejection).toBe('invalid_item');
  });
});

describe('the effect math', () => {
  it('the own effect counts × 1.1, and × 1.21 on a Void item', () => {
    expect(itemEffectInstances(weapon({ awakening: { ...AWAKE } }))).toEqual([
      { effectId: 'tyrants-bane', roll: 0.5, strength: 1.1 },
    ]);
    const voidAwake = itemEffectInstances(weapon({ variant: 'void', awakening: { ...AWAKE } }));
    expect(voidAwake[0]!.strength).toBeCloseTo(1.21, 10);
    // Prismatic leaves the effect as on a plain item, so awakening is × 1.1 there.
    expect(
      itemEffectInstances(weapon({ variant: 'prismatic', awakening: { ...AWAKE } }))[0]!.strength,
    ).toBe(1.1);
  });

  it('a set bonus of n pieces is awakened once n distinct worn pieces are', () => {
    const pieces = ['vigil-helm', 'vigil-hauberk', 'vigil-gauntlets', 'vigil-sabatons'];
    const kit = (awake: number) => pieces.map((p, i) => vigil(p, i < awake));
    const strengths = (awake: number) => setBonusInstances(kit(awake)).map((b) => b.strength ?? 1);
    expect(strengths(0)).toEqual([1, 1]);
    expect(strengths(1)).toEqual([1, 1]);
    expect(strengths(2)).toEqual([1.1, 1]);
    expect(strengths(3)).toEqual([1.1, 1]);
    expect(strengths(4)).toEqual([1.1, 1.1]);
    // Two copies of one awakened piece count once.
    const twice = [vigil('vigil-helm', true), vigil('vigil-helm', true), ...kit(0).slice(1)];
    expect(setBonusInstances(twice).map((b) => b.strength ?? 1)).toEqual([1, 1]);
  });
});

describe('the quote (awakeningPreview)', () => {
  it('shows the effect before and after and the combat number it moves', () => {
    const p = awakeningPreview(weapon(), [], 'warrior');
    expect(p.effectBefore).toBe('Deal 15 % more damage to bosses.');
    expect(p.effectAfter).toBe('Deal 16.5 % more damage to bosses.');
    expect(p.changes).toEqual([{ key: 'bossSlayer', before: 0.15, after: 0.165 }]);
    expect(p.setProgress).toBeNull();
  });

  it('says when the awakening changes nothing: the effect is already at its cap', () => {
    const ring = weapon({ effectRoll: 1 });
    // A warlock: Tyrant's Bane at 20 % and Abyssal Rot's 10 % already reach the 30 % boss cap.
    const others = [weapon({ effectId: 'abyssal-rot', effectRoll: undefined, rarityId: 'mythic' })];
    const p = awakeningPreview(ring, others, 'warlock');
    expect(p.effectAfter).not.toBe(p.effectBefore);
    expect(p.changes).toEqual([]);
  });

  it('counts set progress: "2 of 4 awakened" wakes the 2-piece bonus', () => {
    const others = [
      vigil('vigil-hauberk', true),
      vigil('vigil-gauntlets', false),
      vigil('vigil-sabatons', false),
    ];
    const p = awakeningPreview(vigil('vigil-helm', false), others, 'warrior');
    expect(p.effectBefore).toBeNull();
    expect(p.setProgress).toMatchObject({
      setId: 'drowned-vigil',
      worn: 4,
      awakenedBefore: 1,
      awakenedAfter: 2,
    });
    expect(p.setProgress!.bonuses.map((b) => [b.pieces, b.before, b.after])).toEqual([
      [2, false, true],
      [4, false, false],
      [6, false, false],
    ]);
    expect(p.changes.map((c) => c.key)).toEqual(['thorns']);
  });
});

describe('binding and trading', () => {
  it('an awakened item is account-bound and never tradeable, whatever the switches', () => {
    const facts = {
      ...weapon({ awakening: { ...AWAKE } }),
      source: 'farming',
      binding: 'equip' as const,
      upgradeLevel: 0,
    };
    const open = {
      trading: true,
      items: true,
      materials: true,
      gold: true,
      categories: {
        epic: true,
        legendary: true,
        set: true,
        mythic: true,
        void: true,
        prismatic: true,
      },
    };
    const b = itemBinding(facts, open);
    expect(b).toMatchObject({ binding: 'account', reason: 'awakened', tradeable: false });
    // Without the awakening the same facts are a tradeable bind-on-equip item.
    expect(itemBinding({ ...facts, awakening: null }, open).tradeable).toBe(true);
  });
});
