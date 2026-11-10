import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  DEFAULT_LOOT_CONFIG,
  HEROIC_PRISMATIC_CHANCE,
  ITEM_SETS,
  ITEM_VARIANTS,
  LOOT_TABLES,
  MYTHIC_ITEMS,
  PRISMATIC_AFFIX_BONUS,
  PRISMATIC_CHANCE,
  PRISMATIC_TABLE_IDS,
  RARITY_IDS,
  activeVariant,
  createRng,
  effectivePrismaticChance,
  effectiveVoidChance,
  equipmentModifiers,
  generateItem,
  getImplicitStats,
  getLootTable,
  itemEffectInstances,
  itemSecondaryModifiers,
  itemStatContribution,
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

const noPrismatic = (t: LootTableDefinition): LootTableDefinition => ({ ...t, prismaticChance: 0 });
const prismatic = ITEM_VARIANTS.find((v) => v.id === 'prismatic')!;

describe('Prismatic content (ticket 6.4)', () => {
  it('is a variant of Legendary and Mythic items (set pieces included), with no base or effect bonus', () => {
    expect([...prismatic.rarities].sort()).toEqual(['legendary', 'mythic']);
    expect(prismatic.implicitBonus).toBe(0);
    expect(prismatic.effectStrength).toBe(1);
    expect(prismatic.affixBonus).toBe(PRISMATIC_AFFIX_BONUS);
    // A small, different bonus: the item's combat affixes, not more than a quarter.
    expect(prismatic.affixBonus).toBeGreaterThan(1);
    expect(prismatic.affixBonus).toBeLessThanOrEqual(1.25);
    // Void keeps its shape and puts nothing into affixes.
    expect(ITEM_VARIANTS.find((v) => v.id === 'void')!.affixBonus).toBe(1);
  });

  it('drops only in Ashen-tier and newer sources, rarer than Void in each, under the cap', () => {
    const withPrismatic = LOOT_TABLES.filter((t) => effectivePrismaticChance(t) > 0).map(
      (t) => t.id,
    );
    expect(withPrismatic.sort()).toEqual([...PRISMATIC_TABLE_IDS].sort());
    for (const t of LOOT_TABLES) {
      const p = effectivePrismaticChance(t);
      expect(p).toBeLessThanOrEqual(DEFAULT_LOOT_CONFIG.maxPrismaticChance);
      if (p === 0) continue;
      const v = effectiveVoidChance(t);
      // Prismatic is only rolled after a failed Void roll: its share is (1 − v) · p, below v.
      expect((1 - v) * p, t.id).toBeLessThan(v / 2);
    }
    expect(effectivePrismaticChance(getLootTable('ashenPass'))).toBe(PRISMATIC_CHANCE);
    expect(effectivePrismaticChance(getLootTable('gravewardenIV'))).toBe(HEROIC_PRISMATIC_CHANCE);
    // Older sources never roll it: the Abbey, the crypt's tiers I–III, the older areas.
    for (const id of ['sunkenAbbey', 'namelessCryptIII', 'gravewardenIII', 'blackwater']) {
      expect(effectivePrismaticChance(getLootTable(id)), id).toBe(0);
    }
    const pass = getLootTable('ashenPass');
    expect(effectivePrismaticChance({ ...pass, prismaticChance: 0.9 })).toBe(
      DEFAULT_LOOT_CONFIG.maxPrismaticChance,
    );
    expect(effectivePrismaticChance({ ...pass, prismaticChance: Number.NaN })).toBe(0);
    expect(effectivePrismaticChance(pass, { ...DEFAULT_LOOT_CONFIG, maxPrismaticChance: 0 })).toBe(
      0,
    );
  });
});

describe('Prismatic validation (ticket 6.4)', () => {
  const legendary = generateItem({
    seed: 7,
    itemLevel: 27,
    baseId: 'bone-amulet',
    rarityId: 'legendary',
    classId: 'warrior',
  })!;

  it('is valid on Legendary, Mythic and set pieces only', () => {
    expect(validateItem({ ...legendary, variant: 'prismatic' })).toEqual([]);
    const mythic = generateItem({ seed: 1, itemLevel: 27, baseId: MYTHIC_ITEMS[0]!.baseId })!;
    expect(validateItem({ ...mythic, variant: 'prismatic' })).toEqual([]);
    const piece = generateItem({ seed: 2, itemLevel: 27, baseId: ITEM_SETS[0]!.pieces[0]! })!;
    expect(validateItem({ ...piece, variant: 'prismatic' })).toEqual([]);
    for (const rarityId of ['common', 'uncommon', 'rare', 'epic'] as const) {
      const item = generateItem({ seed: 7, itemLevel: 27, baseId: 'iron-ring', rarityId })!;
      expect(validateItem({ ...item, variant: 'prismatic' })).toEqual([
        `variant prismatic on a ${rarityId} item`,
      ]);
      // A stray flag (never generated) does nothing either.
      expect(activeVariant({ ...item, variant: 'prismatic' })).toBeUndefined();
      expect(itemStatContribution({ ...item, variant: 'prismatic' })).toEqual(
        itemStatContribution(item),
      );
    }
  });

  it('never stacks with Void: one variant per item, and a Void roll is never replaced', () => {
    // The column holds one value; every generated item carries at most one.
    for (const id of PRISMATIC_TABLE_IDS) {
      const table = getLootTable(id);
      for (let seed = 0; seed < 1_500; seed++) {
        const a = generateItem(
          { seed, itemLevel: table.itemLevel!.min, lootTable: table, classId: 'hunter' },
          only('legendary', 'mythic'),
        )!;
        const b = generateItem(
          {
            seed,
            itemLevel: table.itemLevel!.min,
            lootTable: noPrismatic(table),
            classId: 'hunter',
          },
          only('legendary', 'mythic'),
        )!;
        // A Void item is the same Void item with or without Prismatic odds.
        if (b.variant === 'void') expect(a).toEqual(b);
        expect([undefined, 'void', 'prismatic']).toContain(a.variant);
        expect(validateItem(a)).toEqual([]);
      }
    }
  });
});

describe('Prismatic drops (ticket 6.4)', () => {
  it('rolls at (1 − Void) × its chance on Legendary, Mythic and set rolls of every source', () => {
    const n = 8_000;
    for (const id of PRISMATIC_TABLE_IDS) {
      const table = getLootTable(id);
      const v = effectiveVoidChance(table);
      const p = (1 - v) * effectivePrismaticChance(table);
      let all = 0;
      let prism = 0;
      let voids = 0;
      for (let seed = 0; seed < n; seed++) {
        const item = generateItem(
          { seed, itemLevel: table.itemLevel!.max, lootTable: table, classId: 'mage' },
          only('legendary', 'mythic'),
        )!;
        all++;
        if (item.variant === 'prismatic') prism++;
        if (item.variant === 'void') voids++;
      }
      // 4 standard deviations of a binomial.
      const tol = (q: number) => 4 * Math.sqrt((q * (1 - q)) / all);
      expect(Math.abs(prism / all - p), `${id} prismatic ${prism}/${all}`).toBeLessThan(tol(p));
      expect(Math.abs(voids / all - v), `${id} void ${voids}/${all}`).toBeLessThan(tol(v));
      expect(prism).toBeLessThan(voids);
    }
  });

  it('never on Common to Epic, never on requested bases, never in older tables', () => {
    const pass = getLootTable('ashenPass');
    for (let seed = 0; seed < 3_000; seed++) {
      const low = generateItem(
        { seed, itemLevel: 27, lootTable: pass },
        only('common', 'uncommon', 'rare', 'epic'),
      )!;
      expect(low.variant).toBeUndefined();
      const mythic = MYTHIC_ITEMS[seed % MYTHIC_ITEMS.length]!;
      expect(
        generateItem({ seed, itemLevel: 27, baseId: mythic.baseId, lootTable: pass })!.variant,
      ).toBeUndefined();
      const set = ITEM_SETS[seed % ITEM_SETS.length]!;
      expect(
        generateItem({ seed, itemLevel: 27, baseId: set.pieces[0]!, lootTable: pass })!.variant,
      ).toBeUndefined();
      for (const table of LOOT_TABLES.filter((t) => !t.prismaticChance)) {
        const item = generateItem(
          { seed, itemLevel: 20, lootTable: table },
          only('legendary', 'mythic'),
        );
        expect(item?.variant, table.id).not.toBe('prismatic');
      }
    }
  });

  it('is the last draw: every item rolls exactly as before 6.4, apart from the flag', () => {
    for (const id of PRISMATIC_TABLE_IDS) {
      const table = getLootTable(id);
      let prisms = 0;
      for (let seed = 0; seed < 2_000; seed++) {
        for (const config of [DEFAULT_LOOT_CONFIG, only('legendary', 'mythic')]) {
          const params = {
            seed,
            itemLevel: table.itemLevel!.min + (seed % 3),
            lootTable: table,
            classId: 'warlock' as const,
          };
          const a = generateItem(params, config)!;
          const b = generateItem({ ...params, lootTable: noPrismatic(table) }, config)!;
          expect(b.variant).not.toBe('prismatic');
          if (a.variant === 'prismatic') {
            prisms++;
            const rest: GeneratedItem = { ...a };
            delete rest.variant;
            expect(rest).toEqual(b);
          } else {
            expect(a).toEqual(b);
          }
        }
      }
      expect(prisms, id).toBeGreaterThan(0);
    }
  });

  it('leaves kill loot (gold, rarity, item count) of every source unchanged', () => {
    for (const id of ['ashenPass', 'cinderDepths', 'namelessCryptIV']) {
      const table = getLootTable(id);
      const summary = (t: LootTableDefinition) => {
        const rng = createRng(`prismatic-kills:${id}`);
        const out: string[] = [];
        for (let i = 0; i < 20_000; i++) {
          const d = rollLoot({ rng, sourceLevel: table.itemLevel!.min + 1, lootTable: t });
          out.push(`${d.gold}:${d.items.map((x) => `${x.seed}/${x.rarityId}`).join(',')}`);
        }
        return out;
      };
      expect(summary(table)).toEqual(summary(noPrismatic(table)));
    }
  });
});

describe('Prismatic stat shape (ticket 6.4)', () => {
  const ring = generateItem({
    seed: 11,
    itemLevel: 29,
    baseId: 'iron-ring',
    rarityId: 'legendary',
    classId: 'hunter',
  })!;
  const withAffixes = (item: GeneratedItem, ids: string[]): GeneratedItem => ({
    ...item,
    affixes: ids.map((affixId) => {
      const def = AFFIXES.find((a) => a.id === affixId)!;
      const tier = def.tiers.filter((t) => t.minItemLevel <= 29).at(-1)!;
      return { affixId, tier: tier.tier, value: tier.max };
    }),
  });

  it('raises combat affixes × the bonus and leaves base values, crit chance, find affixes alone', () => {
    const item = withAffixes(ring, ['physical-damage', 'crit-chance', 'attack-speed', 'gold-find']);
    expect(validateItem(item)).toEqual([]);
    const prism = { ...item, variant: 'prismatic' as const };
    expect(getImplicitStats(prism)).toEqual(getImplicitStats(item));
    const plain = itemStatContribution(item);
    const raised = itemStatContribution(prism);
    const implicit = Object.fromEntries(getImplicitStats(item).map((s) => [s.stat, s.value]));
    const affix = (stat: string) => (plain[stat as 'health'] ?? 0) - (implicit[stat] ?? 0);
    expect(raised.physicalDamage! - (implicit.physicalDamage ?? 0)).toBe(
      Math.round(affix('physicalDamage') * PRISMATIC_AFFIX_BONUS),
    );
    // Crit chance is left out (it multiplies with crit damage and the crit effects).
    expect(raised.critChance).toBe(plain.critChance);
    expect(raised.attackSpeed).toBeCloseTo(plain.attackSpeed! * PRISMATIC_AFFIX_BONUS, 4);
    // Gold find is economy, not combat: untouched.
    expect(itemSecondaryModifiers(prism).goldFind).toBe(itemSecondaryModifiers(item).goldFind);
    // Stored values never change: the item still validates with its rolled numbers.
    expect(validateItem(prism)).toEqual([]);
  });

  it('raises boss and skill damage, never gold, item, XP or resource find', () => {
    const amulet = generateItem({
      seed: 4,
      itemLevel: 29,
      baseId: 'bone-amulet',
      rarityId: 'legendary',
      classId: 'mage',
    })!;
    const item = withAffixes(amulet, ['boss-damage', 'mana-firebolt', 'xp-gain', 'item-find']);
    const prism = { ...item, variant: 'prismatic' as const };
    const a = itemSecondaryModifiers(item);
    const b = itemSecondaryModifiers(prism);
    expect(b.bossDamage).toBeCloseTo(a.bossDamage * PRISMATIC_AFFIX_BONUS, 4);
    expect(b.skillDamage).toBeCloseTo(a.skillDamage * PRISMATIC_AFFIX_BONUS, 4);
    expect(b.xpGain).toBe(a.xpGain);
    expect(b.itemFind).toBe(a.itemFind);
    // Without the rarity (an affix-only caller) nothing changes.
    expect(itemSecondaryModifiers({ affixes: item.affixes, variant: 'prismatic' })).toEqual(a);
  });

  it('does not scale the item effect, and a Prismatic set piece is the same piece', () => {
    const execute: GeneratedItem = { ...ring, effectId: 'headsmans-due', effectRoll: 1 };
    expect(itemEffectInstances({ ...execute, variant: 'prismatic' })).toEqual(
      itemEffectInstances(execute),
    );
    const set = ITEM_SETS[0]!;
    const pieces = set.pieces.map((id, i) =>
      generateItem({ seed: 10 + i, itemLevel: 27, baseId: id, classId: 'warrior' })!,
    );
    const prisms = pieces.map((p) => ({ ...p, variant: 'prismatic' as const }));
    expect(wornSets(prisms)).toEqual(wornSets(pieces));
    expect(setBonusInstances(prisms)).toEqual(setBonusInstances(pieces));
    const a = equipmentModifiers(prisms, undefined, undefined, { classId: 'warrior' });
    const b = equipmentModifiers(pieces, undefined, undefined, { classId: 'warrior' });
    expect(a.effectInstances).toEqual(b.effectInstances);
    expect(a.stats).not.toEqual(b.stats);
  });

  it('stacks with upgrades and improvements: base values from the upgrade, affixes × the bonus', () => {
    const item = withAffixes(ring, ['physical-damage', 'health']);
    const up = { ...item, upgradeLevel: 10, variant: 'prismatic' as const };
    // Base values follow the upgrade alone (+50 % at +10), like a plain item at +10.
    expect(getImplicitStats(up)).toEqual(getImplicitStats({ ...item, upgradeLevel: 10 }));
    // An improved affix (the stored value grows) is read × the bonus too.
    const improved = {
      ...up,
      affixes: up.affixes.map((a, i) =>
        i === 0 ? { ...a, value: a.value + 1, improvements: 1 } : a,
      ),
    };
    const delta =
      itemStatContribution(improved).physicalDamage! - itemStatContribution(up).physicalDamage!;
    expect(delta).toBeGreaterThanOrEqual(1);
    expect(delta).toBeLessThanOrEqual(2);
  });
});
