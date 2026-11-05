import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  AREA_LOOT_TABLES,
  BOSS_LOOT_TABLES,
  CLASS_IDS,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_LOOT_CONFIG,
  DEFAULT_PROFESSION_CONFIG,
  ITEM_BASES,
  RARITY_IDS,
  SECONDARY_STAT_IDS,
  affixAllowedOn,
  affixPoolFor,
  buildEncounter,
  createRng,
  equipmentModifiers,
  findAffix,
  generateItem,
  getEnemy,
  getItemBase,
  getLootTable,
  normalizeProfessions,
  rollGathering,
  rollLoot,
  settleFarming,
  statGroup,
  validateItem,
  deriveCharacterStats,
  type ClassId,
  type GeneratedItem,
  type LootTableDefinition,
  type RarityId,
  type SettleFarmingInput,
} from '../index.js';

/**
 * Ticket 3.1: affix depth. Gates (slot, class, content tier, item level), rarity and content
 * tier scaling, caps, and the wiring of the new modifiers into the systems they change.
 */

function sample(
  n: number,
  opts: { itemLevel: number; table?: LootTableDefinition; classId?: ClassId; rarityId?: RarityId },
  seed = 'depth',
): GeneratedItem[] {
  const rng = createRng(seed);
  const out: GeneratedItem[] = [];
  for (let i = 0; i < n; i++) {
    const item = generateItem({
      seed: rng.int(0, 0xffffffff),
      itemLevel: opts.itemLevel,
      ...(opts.table ? { lootTable: opts.table } : {}),
      ...(opts.classId ? { classId: opts.classId } : {}),
      ...(opts.rarityId ? { rarityId: opts.rarityId } : {}),
    });
    if (item) out.push(item);
  }
  return out;
}

const meanTier = (items: GeneratedItem[]) => {
  const tiers = items.flatMap((i) => i.affixes.map((a) => a.tier));
  return tiers.reduce((a, b) => a + b, 0) / tiers.length;
};

describe('affix content', () => {
  it('every affix has a tooltip group and a class-affix exists for every class', () => {
    for (const affix of AFFIXES) expect(statGroup(affix.stat)).toBeDefined();
    for (const classId of CLASS_IDS) {
      expect(AFFIXES.some((a) => a.classes?.length === 1 && a.classes[0] === classId)).toBe(true);
    }
  });

  it('keeps every class-free pool at least as large as the highest affix count', () => {
    const max = Math.max(...RARITY_IDS.map((id) => DEFAULT_LOOT_CONFIG.rarities[id].affixCount));
    for (const base of ITEM_BASES) expect(affixPoolFor(base).length).toBeGreaterThanOrEqual(max);
  });

  it('caps every secondary modifier in config', () => {
    for (const id of SECONDARY_STAT_IDS) {
      const cap = DEFAULT_ACTIVITY_CONFIG.modifierCaps[id];
      expect(cap).toBeGreaterThan(0);
      expect(cap).toBeLessThanOrEqual(1);
    }
  });
});

describe('generation gates', () => {
  it('rolls class affixes only for their class, on bases that class can use', () => {
    for (const classId of CLASS_IDS) {
      for (const item of sample(3000, { itemLevel: 20, classId, rarityId: 'mythic' }, classId)) {
        const base = getItemBase(item.baseId);
        for (const a of item.affixes) {
          const def = findAffix(a.affixId)!;
          if (def.classes) {
            expect(def.classes).toContain(classId);
            expect(base.classes).toContain(classId);
          }
        }
      }
    }
  });

  it('never rolls class affixes without a class', () => {
    for (const item of sample(3000, { itemLevel: 20, rarityId: 'mythic' })) {
      for (const a of item.affixes) expect(findAffix(a.affixId)!.classes).toBeUndefined();
    }
  });

  it('keeps tier-gated affixes (boss damage, item find) off tier-1 bases', () => {
    const fields = getLootTable('abandonedFields');
    for (const item of sample(5000, { itemLevel: 7, table: fields, rarityId: 'mythic' })) {
      expect(getItemBase(item.baseId).tier).toBe(1);
      for (const a of item.affixes) expect(['boss-damage', 'item-find']).not.toContain(a.affixId);
    }
    const crypt = getLootTable('namelessCrypt');
    const ids = new Set(
      sample(3000, { itemLevel: 16, table: crypt, rarityId: 'mythic' }).flatMap((i) =>
        i.affixes.map((a) => a.affixId),
      ),
    );
    expect(ids).toContain('boss-damage');
    expect(ids).toContain('item-find');
  });

  it('generates only valid items for every table, class and rarity', () => {
    const tables = [...AREA_LOOT_TABLES, ...BOSS_LOOT_TABLES];
    for (const table of tables) {
      for (const classId of CLASS_IDS) {
        for (const rarityId of RARITY_IDS) {
          const level = table.itemLevel?.max ?? 20;
          for (const item of sample(40, { itemLevel: level, table, classId, rarityId }, table.id)) {
            expect(validateItem(item)).toEqual([]);
            const base = getItemBase(item.baseId);
            for (const a of item.affixes) {
              expect(affixAllowedOn(findAffix(a.affixId)!, base, classId)).toBe(true);
            }
          }
        }
      }
    }
  });

  it('rejects a class affix on a base no class of it can use, and a tier-gated affix on tier 1', () => {
    const ring = generateItem({ seed: 5, itemLevel: 10, baseId: 'iron-ring', rarityId: 'rare' })!;
    expect(getItemBase('iron-ring').tier).toBe(1);
    const withAffix = (affixId: string) =>
      validateItem({
        ...ring,
        affixes: [ring.affixes[0]!, { affixId, tier: 1, value: 0.05 }],
      });
    expect(withAffix('item-find')).not.toEqual([]);
    const bow = generateItem({ seed: 5, itemLevel: 10, baseId: 'hunting-bow', rarityId: 'rare' })!;
    expect(
      validateItem({
        ...bow,
        affixes: [bow.affixes[0]!, { affixId: 'rage-heavy-strike', tier: 1, value: 0.05 }],
      }),
    ).not.toEqual([]);
  });
});

describe('tier scaling', () => {
  it('higher rarities unlock tiers early and lean toward higher tiers', () => {
    // At item level 16, tier 3 of the 20-level affixes needs the Legendary/Mythic level bonus.
    const tier3AtLevel16 = (rarityId: RarityId) =>
      sample(4000, { itemLevel: 16, rarityId }, `early-${rarityId}`).some((i) =>
        i.affixes.some(
          (a) => findAffix(a.affixId)!.tiers.find((t) => t.tier === a.tier)!.minItemLevel > 16,
        ),
      );
    expect(tier3AtLevel16('rare')).toBe(false);
    expect(tier3AtLevel16('legendary')).toBe(true);
    expect(tier3AtLevel16('mythic')).toBe(true);

    const rare = meanTier(sample(4000, { itemLevel: 30, rarityId: 'rare' }, 'bias'));
    const epic = meanTier(sample(4000, { itemLevel: 30, rarityId: 'epic' }, 'bias'));
    const mythic = meanTier(sample(4000, { itemLevel: 30, rarityId: 'mythic' }, 'bias'));
    expect(epic).toBeGreaterThan(rare);
    expect(mythic).toBeGreaterThan(epic);
  });

  it('higher-tier areas and the crypt roll better affixes at the same item level', () => {
    const at = (id: string) =>
      meanTier(sample(4000, { itemLevel: 16, table: getLootTable(id), rarityId: 'rare' }, 'area'));
    expect(at('oldBurialGrounds')).toBeGreaterThan(at('crowwood'));
    expect(at('namelessCrypt')).toBeGreaterThan(at('oldBurialGrounds'));
    expect(at('gravewarden')).toBeGreaterThan(at('namelessCrypt'));
  });
});

describe('modifier caps', () => {
  it('sums secondary modifiers and clamps each to its cap', () => {
    const big = (affixId: string): GeneratedItem => ({
      seed: 1,
      baseId: 'iron-ring',
      rarityId: 'common',
      itemLevel: 1,
      affixes: [{ affixId, tier: 1, value: 0.4 }],
    });
    const items = [
      'item-find',
      'xp-gain',
      'resource-yield',
      'boss-damage',
      'rage-heavy-strike',
    ].flatMap((id) => [big(id), big(id)]);
    const m = equipmentModifiers(items);
    const caps = DEFAULT_ACTIVITY_CONFIG.modifierCaps;
    expect(m.uncapped.itemFind).toBeCloseTo(0.8);
    expect(m.itemFind).toBe(caps.itemFind);
    expect(m.xpGain).toBe(caps.xpGain);
    expect(m.resourceYield).toBe(caps.resourceYield);
    expect(m.bossDamage).toBe(caps.bossDamage);
    expect(m.skillDamage).toBe(caps.skillDamage);
    // Secondary modifiers never leak into combat stats.
    expect(m.stats.every((s) => Object.keys(s).every((k) => k === 'health'))).toBe(true);
  });
});

describe('modifiers do something', () => {
  const stats = deriveCharacterStats('warrior', 15, []);

  it('XP gain, skill damage and boss damage change the encounter', () => {
    const wolf = getEnemy('carrionWolf');
    const plain = buildEncounter(wolf, 15, 'warrior', 15, stats, DEFAULT_COMBAT_CONFIG);
    const mod = buildEncounter(wolf, 15, 'warrior', 15, stats, DEFAULT_COMBAT_CONFIG, {
      xpGain: 0.2,
      skillDamage: 0.5,
      bossDamage: 0.5,
    });
    expect(mod.xpReward).toBe(Math.round(plain.xpReward * 1.2));
    expect(mod.skill.normal).toBeGreaterThan(plain.skill.normal);
    expect(mod.auto.normal).toBe(plain.auto.normal); // boss damage: bosses only
    // Zero modifiers are exactly the old encounter.
    expect(buildEncounter(wolf, 15, 'warrior', 15, stats, DEFAULT_COMBAT_CONFIG, {})).toEqual(
      plain,
    );

    const boss = getEnemy('gravewarden');
    const b0 = buildEncounter(boss, 16, 'warrior', 15, stats, DEFAULT_COMBAT_CONFIG);
    const b1 = buildEncounter(boss, 16, 'warrior', 15, stats, DEFAULT_COMBAT_CONFIG, {
      bossDamage: 0.5,
    });
    expect(b1.auto.normal / b0.auto.normal).toBeCloseTo(1.5, 1);
  });

  it('item find raises the per-kill drop chance', () => {
    const table = getLootTable('crowwood');
    const drops = (itemFind: number) => {
      let n = 0;
      for (let i = 0; i < 40_000; i++) {
        n += rollLoot({ rng: createRng(`f${i}`), sourceLevel: 8, lootTable: table, itemFind }).items
          .length;
      }
      return n / 40_000;
    };
    const base = drops(0);
    expect(base).toBeCloseTo(table.itemDropChance, 2);
    expect(drops(0.5)).toBeCloseTo(table.itemDropChance * 1.5, 2);
  });

  it('resource yield raises gathering units; zero yield is unchanged', () => {
    const units = (resourceYield: number, withArg = true) => {
      let n = 0;
      for (let i = 0; i < 5000; i++) {
        const rng = createRng(`g${i}`);
        const finds = withArg
          ? rollGathering(
              { areaId: 'crowwood', outcome: 'kill', enemyId: 'carrionWolf' },
              normalizeProfessions(undefined),
              rng,
              DEFAULT_PROFESSION_CONFIG,
              resourceYield,
            )
          : rollGathering(
              { areaId: 'crowwood', outcome: 'kill', enemyId: 'carrionWolf' },
              normalizeProfessions(undefined),
              rng,
            );
        for (const f of finds) if (f.professionId) n += f.quantity;
      }
      return n;
    };
    expect(units(0)).toBe(units(0, false));
    expect(units(0.5) / units(0)).toBeGreaterThan(1.35);
  });
});

describe('settlement with the new modifiers', () => {
  const ring = (affixes: GeneratedItem['affixes']) => ({
    baseId: 'iron-ring',
    rarityId: 'rare' as const,
    itemLevel: 5,
    affixes,
  });
  const input = (
    equipment: NonNullable<SettleFarmingInput['equipment']>,
    over: Partial<SettleFarmingInput> = {},
  ): SettleFarmingInput => ({
    character: { classId: 'warrior', level: 3, xp: 0 },
    equipment,
    areaId: 'abandonedFields',
    seed: 'depth-settle',
    firstCycle: 0,
    durationMs: 2 * 60 * 60 * 1000,
    inventoryCount: 0,
    ...over,
  });

  it('item find and resource yield add drops without changing combat', () => {
    const plain = settleFarming(input([ring([])]));
    const found = settleFarming(
      input([
        ring([
          { affixId: 'item-find', tier: 1, value: 0.5 },
          { affixId: 'resource-yield', tier: 1, value: 0.5 },
        ]),
      ]),
    );
    expect(found.kills).toBe(plain.kills);
    expect(found.xpGained).toBe(plain.xpGained);
    // Every plain drop also drops with item find (same per-kill stream, higher chance).
    const all = (s: typeof plain) => [...s.items, ...s.salvaged];
    const seeds = new Set(all(found).map((i) => i.seed));
    for (const item of all(plain)) expect(seeds).toContain(item.seed);
    expect(all(found).length).toBeGreaterThan(all(plain).length);
    for (const [id, n] of Object.entries(plain.materials)) {
      expect(found.materials[id as keyof typeof found.materials] ?? 0).toBeGreaterThanOrEqual(n!);
    }
  });

  it('XP gain raises XP per kill', () => {
    const plain = settleFarming(input([ring([])]));
    const xp = settleFarming(input([ring([{ affixId: 'xp-gain', tier: 1, value: 0.3 }])]));
    expect(xp.xpGained / xp.kills).toBeGreaterThan((plain.xpGained / plain.kills) * 1.15);
  });

  it('stays split-invariant with the new modifiers equipped', () => {
    const equipment = [
      ring([
        { affixId: 'item-find', tier: 1, value: 0.3 },
        { affixId: 'xp-gain', tier: 1, value: 0.1 },
        { affixId: 'resource-yield', tier: 1, value: 0.3 },
      ]),
    ];
    const total = 30 * 60 * 1000;
    const run = (step: number) => {
      let character: SettleFarmingInput['character'] = { classId: 'warrior', level: 3, xp: 0 };
      let firstCycle = 0;
      let carry = 0;
      let professions: SettleFarmingInput['professions'];
      const out = {
        kills: 0,
        xp: 0,
        items: [] as number[],
        materials: {} as Record<string, number>,
      };
      for (let t = 0; t < total; t += step) {
        const s = settleFarming(
          input(equipment, {
            character,
            firstCycle,
            durationMs: carry + Math.min(step, total - t),
            inventoryCount: out.items.length,
            ...(professions ? { professions } : {}),
          }),
        );
        carry = s.unusedMs;
        firstCycle += s.encounters;
        professions = s.professions;
        character = { classId: 'warrior', level: s.level, xp: s.xp, health: s.health };
        out.kills += s.kills;
        out.xp += s.xpGained;
        out.items.push(...s.items.map((i) => i.seed));
        for (const [id, n] of Object.entries(s.materials))
          out.materials[id] = (out.materials[id] ?? 0) + n!;
      }
      return { ...out, character, firstCycle };
    };
    const once = run(total);
    expect(once.kills).toBeGreaterThan(0);
    for (const step of [5_000, 60_000]) expect(run(step)).toEqual(once);
  });
});
