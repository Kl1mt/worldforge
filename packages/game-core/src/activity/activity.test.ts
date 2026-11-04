import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVITY_CONFIG,
  equipmentModifiers,
  generateItem,
  itemContribution,
  salvageValue,
  settleFarming,
  type GeneratedItem,
  type SettleFarmingInput,
} from '../index.js';

const HOUR = 60 * 60 * 1000;

const input = (overrides: Partial<SettleFarmingInput> = {}): SettleFarmingInput => ({
  character: { classId: 'warrior', level: 1, xp: 0 },
  areaId: 'abandonedFields',
  seed: 'activity-test',
  durationMs: HOUR,
  inventoryCount: 0,
  ...overrides,
});

const goldRing = (value: number): GeneratedItem => ({
  seed: 1,
  baseId: 'iron-ring',
  rarityId: 'rare',
  itemLevel: 10,
  affixes: [{ affixId: 'gold-find', tier: 1, value }],
});

describe('itemContribution / equipmentModifiers', () => {
  it('sums implicit stats and affixes, splitting gold find off', () => {
    const item = generateItem({ seed: 42, itemLevel: 20, rarityId: 'mythic' })!;
    const c = itemContribution(item);
    for (const v of Object.values(c.stats)) expect(Number.isFinite(v)).toBe(true);
    expect(c.goldFind).toBeGreaterThanOrEqual(0);
  });

  it('caps total gold find', () => {
    const many = Array.from({ length: 30 }, () => goldRing(0.1));
    const m = equipmentModifiers(many);
    expect(m.goldFindUncapped).toBeCloseTo(3);
    expect(m.goldFind).toBe(DEFAULT_ACTIVITY_CONFIG.modifierCaps.goldFind);
    expect(equipmentModifiers([goldRing(0.1)]).goldFind).toBeCloseTo(0.1);
    expect(equipmentModifiers([]).goldFind).toBe(0);
  });
});

describe('settleFarming', () => {
  it('is deterministic for the same input', () => {
    expect(settleFarming(input())).toEqual(settleFarming(input()));
    expect(settleFarming(input({ seed: 'other' }))).not.toEqual(settleFarming(input()));
  });

  it('accounts for every millisecond and produces progress', () => {
    const r = settleFarming(input({ durationMs: 3 * HOUR }));
    expect(r.simulatedMs + r.unusedMs).toBe(3 * HOUR);
    expect(r.unusedMs).toBeLessThan(60_000);
    expect(r.kills).toBeGreaterThan(100);
    expect(r.xpGained).toBeGreaterThan(0);
    expect(r.level).toBeGreaterThan(1);
    expect(r.goldLooted).toBeGreaterThan(0);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.length + r.salvaged.length).toBeLessThanOrEqual(r.kills);
    for (const v of [r.goldLooted, r.xp, r.health, r.damageTaken]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns nothing for an empty window', () => {
    const r = settleFarming(input({ durationMs: 0 }));
    expect(r).toMatchObject({ kills: 0, xpGained: 0, goldLooted: 0, unusedMs: 0, items: [] });
  });

  it('carries unfinished time instead of awarding it', () => {
    const r = settleFarming(input({ durationMs: 1_000 }));
    expect(r.kills).toBe(0);
    expect(r.unusedMs).toBe(1_000);
  });

  it('item levels follow the character within the area range', () => {
    const r = settleFarming(input({ character: { classId: 'hunter', level: 30, xp: 0 } }));
    for (const item of r.items) expect(item.itemLevel).toBeLessThanOrEqual(7);
  });

  it('salvages items beyond inventory capacity into gold', () => {
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    const roomy = settleFarming(input());
    expect(roomy.items.length).toBeGreaterThan(2);
    expect(roomy.items.length).toBeLessThan(cap);
    expect(roomy.salvaged).toEqual([]);
    const full = settleFarming(input({ inventoryCount: cap }));
    const nearly = settleFarming(input({ inventoryCount: cap - 2 }));
    expect(full.items).toEqual([]);
    expect(full.salvaged).toEqual(roomy.items);
    expect(full.goldSalvaged).toBe(roomy.items.reduce((s, i) => s + salvageValue(i), 0));
    expect(full.goldLooted).toBe(roomy.goldLooted);
    expect(nearly.items).toEqual(roomy.items.slice(0, 2));
    expect(nearly.salvaged.length).toBe(roomy.items.length - 2);
  });

  it('gold find raises gold, but only up to the cap', () => {
    const base = settleFarming(input({ durationMs: 3 * HOUR }));
    const capped = settleFarming(
      input({ durationMs: 3 * HOUR, equipment: Array.from({ length: 20 }, () => goldRing(0.1)) }),
    );
    const atCap = settleFarming(
      input({ durationMs: 3 * HOUR, equipment: Array.from({ length: 10 }, () => goldRing(0.1)) }),
    );
    expect(capped.goldFind).toBe(1);
    expect(capped.goldLooted).toBeGreaterThan(base.goldLooted);
    // Same rolls with and without the excess: the cap makes them identical in gold.
    expect(capped.goldLooted).toBe(atCap.goldLooted);
  });

  it('rejects invalid input', () => {
    expect(() => settleFarming(input({ durationMs: -1 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ durationMs: 1.5 }))).toThrow(RangeError);
    expect(() => settleFarming(input({ inventoryCount: -1 }))).toThrow(RangeError);
  });
});

describe('salvageValue', () => {
  it('grows with rarity and item level', () => {
    const v = (rarityId: GeneratedItem['rarityId'], itemLevel: number) =>
      salvageValue({ rarityId, itemLevel });
    expect(v('common', 1)).toBeGreaterThanOrEqual(1);
    expect(v('rare', 5)).toBeGreaterThan(v('common', 5));
    expect(v('common', 20)).toBeGreaterThan(v('common', 1));
  });
});
