import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOT_CONFIG,
  ITEM_SETS,
  ITEM_VARIANTS,
  LOOT_TABLES,
  MYTHIC_ITEMS,
  RARITY_IDS,
  VOID_CHANCE,
  activeVariant,
  combineEffects,
  createRng,
  describeEffect,
  effectiveVoidChance,
  equipmentModifiers,
  generateItem,
  getImplicitStats,
  getItemBase,
  getLootTable,
  itemEffectInstances,
  resolveEffectComponents,
  rollLoot,
  setBonusInstances,
  validateItem,
  wornSets,
  type GeneratedItem,
  type LootConfig,
  type LootTableDefinition,
  type RarityId,
} from '../index.js';

/** Only the given rarities roll (equal weights). */
const only = (...ids: RarityId[]): LootConfig => ({
  ...DEFAULT_LOOT_CONFIG,
  rarities: Object.fromEntries(
    RARITY_IDS.map((id) => [
      id,
      { ...DEFAULT_LOOT_CONFIG.rarities[id], weight: ids.includes(id) ? 1 : 0 },
    ]),
  ) as LootConfig['rarities'],
});

const abbey = getLootTable('sunkenAbbey');
const noVoid = (table: LootTableDefinition): LootTableDefinition => ({ ...table, voidChance: 0 });
const withoutVariant = ({ variant: _, ...item }: GeneratedItem): GeneratedItem => item;

describe('Void content (ticket 3.5)', () => {
  it('has Void (and, since 6.4, Prismatic), on Legendary and Mythic only', () => {
    expect(ITEM_VARIANTS.map((v) => v.id)).toEqual(['void', 'prismatic']);
    const v = ITEM_VARIANTS[0]!;
    expect([...v.rarities].sort()).toEqual(['legendary', 'mythic']);
    // A small bonus (GDD §7.5): a few upgrade levels' worth of base stats, +10 % effect magnitudes.
    expect(v.implicitBonus).toBeGreaterThan(0);
    expect(v.implicitBonus).toBeLessThanOrEqual(0.1);
    expect(v.effectStrength).toBeGreaterThan(1);
    expect(v.effectStrength).toBeLessThanOrEqual(1.1);
  });

  it('only the late-game sources roll Void, and every chance is under the hard cap', () => {
    const withVoid = LOOT_TABLES.filter((t) => effectiveVoidChance(t) > 0).map((t) => t.id);
    // Ticket 3.6 adds the deeper crypt tiers' chambers and Gravewarden.
    // Ticket 4.8 adds the Ashen Pass and the Ashen Warden's hoard; 6.1 the Ashfall Verge; 6.2 the
    // Cinder Depths and the Forge Tyrant's hoard; 6.3 the Heroic crypt's chambers and hoard.
    expect(withVoid.sort()).toEqual([
      'ashenPass',
      'ashenWarden',
      'ashfallVerge',
      'cinderDepths',
      'forgeTyrant',
      'gravewarden',
      'gravewardenII',
      'gravewardenIII',
      'gravewardenIV',
      'namelessCrypt',
      'namelessCryptII',
      'namelessCryptIII',
      'namelessCryptIV',
      'sunkenAbbey',
    ]);
    for (const t of LOOT_TABLES) {
      expect(effectiveVoidChance(t)).toBeLessThanOrEqual(DEFAULT_LOOT_CONFIG.maxVoidChance);
    }
    expect(effectiveVoidChance(abbey)).toBe(VOID_CHANCE);
    // A table asking for more is clamped to the config's cap.
    expect(effectiveVoidChance({ ...abbey, voidChance: 0.9 })).toBe(
      DEFAULT_LOOT_CONFIG.maxVoidChance,
    );
    expect(effectiveVoidChance({ ...abbey, voidChance: Number.NaN })).toBe(0);
    expect(effectiveVoidChance(abbey, { ...DEFAULT_LOOT_CONFIG, maxVoidChance: 0 })).toBe(0);
  });
});

describe('Void generation (ticket 3.5)', () => {
  it('rolls only on Legendary, Mythic and set pieces, at the table chance', () => {
    const n = 12_000;
    const counts: Record<string, { all: number; void: number }> = {};
    for (let seed = 0; seed < n; seed++) {
      for (const config of [only('legendary', 'mythic'), only('common', 'rare', 'epic')]) {
        const item = generateItem(
          { seed, itemLevel: 20, lootTable: abbey, classId: 'mage' },
          config,
        )!;
        const kind = item.setId ? 'set' : item.rarityId;
        const c = (counts[kind] ??= { all: 0, void: 0 });
        c.all++;
        if (item.variant === 'void') c.void++;
        expect(validateItem(item), `seed ${seed}`).toEqual([]);
      }
    }
    for (const kind of ['common', 'rare', 'epic']) expect(counts[kind]!.void, kind).toBe(0);
    for (const kind of ['legendary', 'mythic', 'set']) {
      const c = counts[kind]!;
      const rate = c.void / c.all;
      // 4 standard deviations of a binomial at p = 0.1.
      const tolerance = 4 * Math.sqrt((VOID_CHANCE * (1 - VOID_CHANCE)) / c.all);
      expect(Math.abs(rate - VOID_CHANCE), `${kind} ${rate} over ${c.all}`).toBeLessThan(tolerance);
    }
  });

  it('is the last draw: every item rolls exactly as without Void (rarity, base, affixes, effect, set)', () => {
    for (const table of [abbey, getLootTable('namelessCrypt'), getLootTable('gravewarden')]) {
      let voids = 0;
      for (let seed = 0; seed < 4_000; seed++) {
        for (const config of [DEFAULT_LOOT_CONFIG, only('legendary', 'mythic')]) {
          const params = { seed, itemLevel: 18, lootTable: table, classId: 'warrior' as const };
          const a = generateItem(params, config)!;
          const b = generateItem({ ...params, lootTable: noVoid(table) }, config)!;
          expect(b.variant).toBeUndefined();
          expect(withoutVariant(a)).toEqual(b);
          if (a.variant) voids++;
        }
      }
      expect(voids, table.id).toBeGreaterThan(0);
    }
  });

  it('the rarity distribution of drops is unchanged', () => {
    const rarities = (table: LootTableDefinition) => {
      const out: Record<string, number> = {};
      const rng = createRng('void-rarity');
      for (let i = 0; i < 40_000; i++) {
        for (const item of rollLoot({ rng, sourceLevel: 20, lootTable: table }).items) {
          out[item.rarityId] = (out[item.rarityId] ?? 0) + 1;
        }
      }
      return out;
    };
    expect(rarities(abbey)).toEqual(rarities(noVoid(abbey)));
  });

  it('never makes a requested base Void, and tables without a chance never roll it', () => {
    for (let seed = 0; seed < 2_000; seed++) {
      const mythic = MYTHIC_ITEMS[seed % MYTHIC_ITEMS.length]!;
      expect(
        generateItem({ seed, itemLevel: 20, baseId: mythic.baseId, lootTable: abbey })!.variant,
      ).toBeUndefined();
      const set = ITEM_SETS[seed % ITEM_SETS.length]!;
      expect(
        generateItem({ seed, itemLevel: 20, baseId: set.pieces[0]!, lootTable: abbey })!.variant,
      ).toBeUndefined();
      for (const table of LOOT_TABLES.filter((t) => !t.voidChance)) {
        const item = generateItem(
          { seed, itemLevel: 20, lootTable: table },
          only('legendary', 'mythic'),
        );
        expect(item?.variant, table.id).toBeUndefined();
      }
    }
  });

  it('a stronger table chance is still capped by the config', () => {
    const greedy = { ...abbey, voidChance: 1 };
    let voids = 0;
    const n = 6_000;
    for (let seed = 0; seed < n; seed++) {
      if (generateItem({ seed, itemLevel: 20, lootTable: greedy }, only('legendary'))!.variant) {
        voids++;
      }
    }
    expect(voids / n).toBeGreaterThan(DEFAULT_LOOT_CONFIG.maxVoidChance - 0.02);
    expect(voids / n).toBeLessThan(DEFAULT_LOOT_CONFIG.maxVoidChance + 0.02);
  });
});

describe('Void rules (ticket 3.5)', () => {
  const legendary = generateItem({
    seed: 7,
    itemLevel: 20,
    baseId: 'bone-amulet',
    rarityId: 'legendary',
    classId: 'warrior',
  })!;
  const execute: GeneratedItem = { ...legendary, effectId: 'headsmans-due', effectRoll: 1 };

  it('validates: Void only on Legendary and Mythic, known ids only', () => {
    expect(validateItem({ ...execute, variant: 'void' })).toEqual([]);
    const epic = generateItem({ seed: 7, itemLevel: 20, baseId: 'iron-ring', rarityId: 'epic' })!;
    expect(validateItem({ ...epic, variant: 'void' })).toEqual(['variant void on a epic item']);
    expect(validateItem({ ...execute, variant: 'glimmer' as unknown as 'void' })).toEqual([
      'unknown variant glimmer',
    ]);
  });

  it('applies only where it is allowed: a Void flag on an epic does nothing', () => {
    expect(activeVariant({ rarityId: 'legendary', variant: 'void' })?.id).toBe('void');
    expect(activeVariant({ rarityId: 'mythic', variant: 'void' })?.id).toBe('void');
    expect(activeVariant({ rarityId: 'epic', variant: 'void' })).toBeUndefined();
    expect(activeVariant({ rarityId: 'legendary', variant: null })).toBeUndefined();
    const epic = generateItem({ seed: 7, itemLevel: 20, baseId: 'chainmail', rarityId: 'epic' })!;
    expect(getImplicitStats({ ...epic, variant: 'void' })).toEqual(getImplicitStats(epic));
  });

  it('adds its implicit bonus to the base stats, next to the upgrade bonus', () => {
    const chest = generateItem({
      seed: 3,
      itemLevel: 20,
      baseId: 'chainmail',
      rarityId: 'legendary',
    })!;
    const raw = getItemBase('chainmail').stats.map((s) => (s.base + s.perLevel * 19) * 1.5);
    expect(getImplicitStats(chest).map((s) => s.value)).toEqual(raw.map((v) => Math.round(v)));
    expect(getImplicitStats({ ...chest, variant: 'void' }).map((s) => s.value)).toEqual(
      raw.map((v) => Math.round(v * 1.1)),
    );
    // Upgrade and Void bonuses add up: +10 Void = +60 % base values.
    expect(
      getImplicitStats({ ...chest, variant: 'void', upgradeLevel: 10 }).map((s) => s.value),
    ).toEqual(raw.map((v) => Math.round(v * 1.6)));
  });

  it('scales its own effect through strength: magnitudes only, under the caps', () => {
    expect(itemEffectInstances(execute)).toEqual([{ effectId: 'headsmans-due', roll: 1 }]);
    const [inst] = itemEffectInstances({ ...execute, variant: 'void' });
    expect(inst).toEqual({ effectId: 'headsmans-due', roll: 1, strength: 1.1 });
    const plainC = resolveEffectComponents({ effectId: 'headsmans-due', roll: 1 });
    const voidC = resolveEffectComponents(inst!);
    expect(voidC).toEqual([{ ...plainC[0]!, bonus: Math.round(0.8 * 1.1 * 1e4) / 1e4 }]);
    expect(describeEffect(inst!)).toContain('88 %');
    expect(describeEffect(inst!)).toContain('30 %'); // the threshold is not scaled
    // Bloodrush: per-stack scales, the stack count and the decay do not.
    const [rush] = resolveEffectComponents({ effectId: 'bloodrush', roll: 1, strength: 1.1 });
    const [rushPlain] = resolveEffectComponents({ effectId: 'bloodrush', roll: 1 });
    expect(rush).toMatchObject({
      maxStacks: (rushPlain as { maxStacks: number }).maxStacks,
      decayMs: (rushPlain as { decayMs: number }).decayMs,
    });
    // The caps still bind: a Void execute item with other execute sources stays at the cap.
    const others = [
      { effectId: 'vigil-undertow', roll: 0 },
      { effectId: 'starfall', roll: 0 },
    ];
    expect(combineEffects([inst!, ...others], 'mage').execute).toEqual(
      combineEffects([{ effectId: 'headsmans-due', roll: 1 }, ...others], 'mage').execute,
    );
    // Ticket B.2: copies of one effect count once, the Void one being the strongest.
    const copies = [{ effectId: 'headsmans-due', roll: 1 }, inst!];
    expect(combineEffects(copies, 'warrior')).toEqual(combineEffects([inst!], 'warrior'));
  });

  it('scales a Mythic signature, and an epic with a stray Void flag stays unscaled', () => {
    const crown = MYTHIC_ITEMS.find((m) => m.id === 'crown-of-the-hollow-king') ?? MYTHIC_ITEMS[0]!;
    const mythic = generateItem({ seed: 1, itemLevel: 20, baseId: crown.baseId })!;
    expect(itemEffectInstances({ ...mythic, variant: 'void' })[0]!.strength).toBe(1.1);
    expect(
      itemEffectInstances({ ...execute, rarityId: 'epic', variant: 'void' })[0]!.strength,
    ).toBeUndefined();
  });

  it('a Void set piece is the same piece: the set bonus is unchanged, only its stats grow', () => {
    const set = ITEM_SETS[0]!;
    const pieces = set.pieces.map((id, i) =>
      generateItem({ seed: 10 + i, itemLevel: 20, baseId: id, classId: 'warrior' })!,
    );
    const voids = pieces.map((p) => ({ ...p, variant: 'void' as const }));
    expect(wornSets(voids)).toEqual(wornSets(pieces));
    expect(setBonusInstances(voids)).toEqual(setBonusInstances(pieces));
    const mixed = pieces.map((p, i) => (i % 2 ? voids[i]! : p));
    expect(setBonusInstances(mixed)).toEqual(setBonusInstances(pieces));
    // Set pieces carry no effect of their own, so Void adds stats only.
    const a = equipmentModifiers(voids, undefined, undefined, { classId: 'warrior' });
    const b = equipmentModifiers(pieces, undefined, undefined, { classId: 'warrior' });
    expect(a.effectInstances).toEqual(b.effectInstances);
    expect(a.stats).not.toEqual(b.stats);
  });
});
