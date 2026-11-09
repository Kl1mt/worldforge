import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  DEFAULT_LOOT_CONFIG,
  ITEM_BASES,
  RARITY_IDS,
  STANDARD_LOOT_TABLE,
  affixPossibleOn,
  createRng,
  generateItem,
  getImplicitStats,
  getItemBase,
  rollGoldAmount,
  rollItemLevel,
  rollLoot,
  rollRarity,
  tiersForItemLevel,
  validateItem,
  type GeneratedItem,
  type LootConfig,
  type RarityId,
} from '../index.js';

const N = 40_000;

function totalWeight(config: LootConfig): number {
  return RARITY_IDS.reduce((sum, id) => sum + config.rarities[id].weight, 0);
}

function sampleItems(count: number, itemLevel: number, seedPrefix = 'items'): GeneratedItem[] {
  const out: GeneratedItem[] = [];
  const rng = createRng(seedPrefix);
  for (let i = 0; i < count; i++) {
    const item = generateItem({ seed: rng.int(0, 0xffffffff), itemLevel });
    if (item) out.push(item);
  }
  return out;
}

describe('determinism', () => {
  it('reproduces a drop sequence from the same seed', () => {
    const run = (seed: string) => {
      const rng = createRng(seed);
      return Array.from({ length: 200 }, () => rollLoot({ rng, sourceLevel: 7 }));
    };
    expect(run('kill-seed')).toEqual(run('kill-seed'));
    expect(run('kill-seed')).not.toEqual(run('other-seed'));
  });

  it('regenerates a stored item from its seed and item level', () => {
    const rng = createRng('reproduce');
    const drops = Array.from({ length: 500 }, () => rollLoot({ rng, sourceLevel: 12 }));
    const items = drops.flatMap((d) => d.items);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(generateItem({ seed: item.seed, itemLevel: item.itemLevel })).toEqual(item);
    }
  });

  it('is pinned: rolls for a known seed do not drift', () => {
    // Persisted item seeds must keep reproducing the same item. If this fails, the
    // generator or content changed in a way that breaks reproduction of stored items.
    expect(generateItem({ seed: 123456789, itemLevel: 20 })).toMatchInlineSnapshot(`
      {
        "affixes": [
          {
            "affixId": "armor",
            "tier": 1,
            "value": 4,
          },
          {
            "affixId": "health",
            "tier": 3,
            "value": 36,
          },
          {
            "affixId": "physical-damage",
            "tier": 1,
            "value": 3,
          },
        ],
        "baseId": "round-shield",
        "itemLevel": 20,
        "rarityId": "epic",
        "seed": 123456789,
      }
    `);
  });
});

describe('rarity distribution', () => {
  it('matches configured weights within tolerance', () => {
    const counts = Object.fromEntries(RARITY_IDS.map((id) => [id, 0])) as Record<RarityId, number>;
    for (let s = 0; s < N; s++) counts[rollRarity(createRng(`rarity-${s}`))]++;
    const total = totalWeight(DEFAULT_LOOT_CONFIG);
    for (const id of RARITY_IDS) {
      const p = DEFAULT_LOOT_CONFIG.rarities[id].weight / total;
      const sigma = Math.sqrt((p * (1 - p)) / N);
      expect(Math.abs(counts[id] / N - p)).toBeLessThanOrEqual(4 * sigma + 1 / N);
    }
    // Rarer tiers are never more frequent than more common ones.
    for (let i = 1; i < RARITY_IDS.length; i++) {
      expect(counts[RARITY_IDS[i]!]).toBeLessThanOrEqual(counts[RARITY_IDS[i - 1]!]);
    }
  });

  it('can disable rarities by config', () => {
    const config: LootConfig = {
      ...DEFAULT_LOOT_CONFIG,
      rarities: {
        ...DEFAULT_LOOT_CONFIG.rarities,
        legendary: { ...DEFAULT_LOOT_CONFIG.rarities.legendary, weight: 0 },
        mythic: { ...DEFAULT_LOOT_CONFIG.rarities.mythic, weight: 0 },
      },
    };
    const rng = createRng('disabled');
    for (let i = 0; i < N; i++) {
      expect(['legendary', 'mythic']).not.toContain(rollRarity(rng, config));
    }
  });

  it('applies the per-kill item drop chance', () => {
    const rng = createRng('drop-chance');
    let drops = 0;
    for (let i = 0; i < N; i++) drops += rollLoot({ rng, sourceLevel: 5 }).items.length;
    const p = STANDARD_LOOT_TABLE.itemDropChance;
    expect(Math.abs(drops / N - p)).toBeLessThanOrEqual(4 * Math.sqrt((p * (1 - p)) / N));
  });
});

describe('generated items', () => {
  const levels = [1, 5, 10, 20, 30, 60];

  it('are always valid: affixes fit the slot, tier and range', () => {
    for (const level of levels) {
      for (const item of sampleItems(3000, level, `valid-${level}`)) {
        expect(validateItem(item)).toEqual([]);
      }
    }
  });

  it('have the affix count of their rarity and no duplicate affixes', () => {
    for (const item of sampleItems(5000, 25)) {
      const ids = item.affixes.map((a) => a.affixId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(DEFAULT_LOOT_CONFIG.rarities[item.rarityId].affixCount);
    }
  });

  it('respects base minimum item levels', () => {
    const bases = new Set(sampleItems(5000, 1).map((i) => i.baseId));
    for (const id of bases) expect(getItemBase(id).minItemLevel).toBe(1);
    expect(bases.has('plate-cuirass')).toBe(false);
    // At high level every base of the (tier 1) standard table can drop.
    expect(new Set(sampleItems(5000, 30).map((i) => i.baseId)).size).toBe(
      STANDARD_LOOT_TABLE.entries.length,
    );
  });

  it('every affix eventually appears on every base it is allowed on', () => {
    // Per base and class (ticket 3.1 gates affixes by content tier and class).
    const seen = new Set<string>();
    const rng = createRng('coverage');
    for (const base of ITEM_BASES) {
      for (let i = 0; i < 400; i++) {
        const classId = base.classes[i % base.classes.length]!;
        const item = generateItem({
          seed: rng.int(0, 0xffffffff),
          itemLevel: 30,
          baseId: base.id,
          rarityId: 'mythic',
          classId,
        })!;
        for (const a of item.affixes) seen.add(`${a.affixId}@${base.id}`);
      }
      for (const affix of AFFIXES) {
        if (affixPossibleOn(affix, base)) expect(seen).toContain(`${affix.id}@${base.id}`);
      }
    }
  });

  it('scale with item level: higher tiers only unlock at higher levels', () => {
    const maxTier = (items: GeneratedItem[]) =>
      Math.max(0, ...items.flatMap((i) => i.affixes.map((a) => a.tier)));
    expect(maxTier(sampleItems(5000, 1))).toBe(1);
    // Ticket 6.1: tier 5 needs item level 31 (Epic and better from 30) and never rolls at 29 or
    // below, so every source before the Cinderwastes rolls exactly as it did.
    expect(maxTier(sampleItems(5000, 29))).toBe(4);
    expect(maxTier(sampleItems(5000, 30))).toBe(5);
    expect(maxTier(sampleItems(5000, 31))).toBe(5);

    const low = getImplicitStats({ baseId: 'longsword', rarityId: 'common', itemLevel: 5 });
    const high = getImplicitStats({ baseId: 'longsword', rarityId: 'common', itemLevel: 25 });
    const epic = getImplicitStats({ baseId: 'longsword', rarityId: 'epic', itemLevel: 25 });
    expect(high[0]!.value).toBeGreaterThan(low[0]!.value);
    expect(epic[0]!.value).toBeGreaterThan(high[0]!.value);
  });

  it('never unlocks tier 5 at item level 29 or below, whatever the rarity (ticket 6.1)', () => {
    for (const affix of AFFIXES) {
      for (const [rarityId, rarity] of Object.entries(DEFAULT_LOOT_CONFIG.rarities)) {
        for (let level = 1; level <= 29; level++) {
          const tiers = tiersForItemLevel(affix, level, rarity.affixLevelBonus);
          // The tiers below 5 unlock exactly as before 6.1 (minItemLevel ≤ level + bonus).
          expect(tiers, `${affix.id} ${rarityId} @${level}`).toEqual(
            affix.tiers.filter(
              (t) => t.tier <= 4 && t.minItemLevel <= level + rarity.affixLevelBonus,
            ),
          );
        }
      }
      const t5 = affix.tiers.find((t) => t.tier === 5);
      if (t5) {
        expect(tiersForItemLevel(affix, 31).at(-1), affix.id).toBe(t5);
        expect(tiersForItemLevel(affix, 30, 2).at(-1), affix.id).toBe(t5);
        expect(tiersForItemLevel(affix, 30).at(-1)?.tier, affix.id).toBe(4);
        // Monotone: each tier needs a higher item level and pays more than the one below.
        const t4 = affix.tiers.find((t) => t.tier === 4)!;
        expect(t5.min, affix.id).toBeGreaterThan(t4.max);
        expect(t5.weight, affix.id).toBeLessThan(t4.weight);
      }
    }
  });

  it('honours fixed base and rarity', () => {
    const item = generateItem({
      seed: 1,
      itemLevel: 10,
      baseId: 'skull-staff',
      rarityId: 'mythic',
    });
    expect(item?.baseId).toBe('skull-staff');
    expect(item?.rarityId).toBe('mythic');
    expect(item?.affixes).toHaveLength(5);
  });

  it('returns null when no base can drop at the level', () => {
    const table = { id: 't', itemDropChance: 1, entries: [{ baseId: 'plate-cuirass', weight: 1 }] };
    expect(generateItem({ seed: 1, itemLevel: 2, lootTable: table })).toBeNull();
    expect(rollLoot({ rng: createRng(1), sourceLevel: 1, lootTable: table }).items).toEqual([]);
  });
});

describe('validateItem', () => {
  const good = generateItem({ seed: 42, itemLevel: 20, baseId: 'iron-ring', rarityId: 'rare' })!;

  it('accepts a generated item', () => {
    expect(validateItem(good)).toEqual([]);
  });

  it('rejects tampered items', () => {
    const bad = (patch: Partial<GeneratedItem>) => validateItem({ ...good, ...patch });
    const a0 = good.affixes[0]!;
    expect(bad({ baseId: 'nope' })).not.toEqual([]);
    expect(bad({ rarityId: 'shiny' as RarityId })).not.toEqual([]);
    expect(bad({ itemLevel: 0 })).not.toEqual([]);
    expect(bad({ itemLevel: 999 })).not.toEqual([]);
    expect(bad({ affixes: [a0] })).not.toEqual([]); // wrong count
    expect(bad({ affixes: [a0, a0] })).not.toEqual([]); // duplicate
    expect(bad({ affixes: [a0, { affixId: 'armor', tier: 1, value: 4 }] })).not.toEqual([]); // armor not on rings
    expect(bad({ affixes: [a0, { ...good.affixes[1]!, value: 1e6 }] })).not.toEqual([]);
    expect(bad({ affixes: [a0, { ...good.affixes[1]!, tier: 9 }] })).not.toEqual([]);
    expect(
      validateItem({
        ...good,
        itemLevel: 1,
        affixes: [{ affixId: 'health', tier: 4, value: 60 }, a0],
      }),
    ).not.toEqual([]); // tier locked at level 1
  });
});

describe('gold', () => {
  it('drops at the configured chance and grows with level', () => {
    const rng = createRng('gold');
    let hits = 0;
    for (let i = 0; i < N; i++) if (rollLoot({ rng, sourceLevel: 3 }).gold > 0) hits++;
    const p = DEFAULT_LOOT_CONFIG.gold.dropChance;
    expect(Math.abs(hits / N - p)).toBeLessThanOrEqual(4 * Math.sqrt((p * (1 - p)) / N));

    const avg = (level: number) => {
      const r = createRng(`gold-${level}`);
      let sum = 0;
      for (let i = 0; i < 2000; i++) sum += rollGoldAmount(level, r);
      return sum / 2000;
    };
    expect(avg(20)).toBeGreaterThan(avg(1) * 2);
  });

  it('applies gold find and ignores negative or invalid bonuses', () => {
    // Level 10, roll r: round(r × 1.9 × (1 + goldFind)) (growth 0.1 per level, ticket B.1).
    const r = createRng(5).int(DEFAULT_LOOT_CONFIG.gold.min, DEFAULT_LOOT_CONFIG.gold.max);
    expect(rollGoldAmount(10, createRng(5), DEFAULT_LOOT_CONFIG, 1)).toBe(Math.round(r * 1.9 * 2));
    expect(rollGoldAmount(10, createRng(5), DEFAULT_LOOT_CONFIG, -5)).toBe(
      rollGoldAmount(10, createRng(5)),
    );
    expect(rollGoldAmount(10, createRng(5), DEFAULT_LOOT_CONFIG, Number.NaN)).toBe(
      rollGoldAmount(10, createRng(5)),
    );
    for (let s = 0; s < 1000; s++) {
      const g = rollGoldAmount(1, createRng(s));
      expect(Number.isInteger(g) && g >= 1).toBe(true);
    }
  });
});

describe('item level', () => {
  it('stays within variance and bounds', () => {
    const rng = createRng('ilvl');
    for (let i = 0; i < 5000; i++) {
      const l = rollItemLevel(10, rng);
      expect(l).toBeGreaterThanOrEqual(9);
      expect(l).toBeLessThanOrEqual(11);
      expect(rollItemLevel(1, rng)).toBeGreaterThanOrEqual(1);
      expect(rollItemLevel(500, rng)).toBe(DEFAULT_LOOT_CONFIG.maxItemLevel);
    }
  });

  it('rejects invalid levels', () => {
    expect(() => rollLoot({ rng: createRng(1), sourceLevel: 0 })).toThrow(RangeError);
    expect(() => rollLoot({ rng: createRng(1), sourceLevel: 1.5 })).toThrow(RangeError);
    expect(() => generateItem({ seed: 1, itemLevel: -1 })).toThrow(RangeError);
  });
});
