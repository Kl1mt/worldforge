import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_LOOT_CONFIG,
  EFFECTS,
  ITEM_SETS,
  canClassUseItem,
  createRng,
  equipmentModifiers,
  findEffect,
  findItemBase,
  resolveEffectComponents,
  findSet,
  generateItem,
  getItemBase,
  getLootTable,
  LOOT_TABLES,
  setBonusInstances,
  setForBase,
  settleFarming,
  simulateDungeonRun,
  validateItem,
  wornSets,
  type EquippedItem,
  type GeneratedItem,
  type LootConfig,
  SET_SHARE,
} from '../index.js';

/** An item without its set id (the column null), as `EquippedItem` reads it. */
const strip = ({ setId: _, ...item }: GeneratedItem): GeneratedItem => item;

/** A set piece as the generator makes it. */
const piece = (baseId: string, seed = 1): GeneratedItem =>
  generateItem({ seed, itemLevel: 18, baseId, classId: 'warrior' })!;

/**
 * A synthetic Void copy (game-core items carry `variant` since ticket 3.5; generated Void pieces are
 * tested in `variants.test.ts`). Counting must never read it.
 */
const voidCopy = (item: GeneratedItem) => ({ ...item, variant: 'void' as const });

const vigil = findSet('drowned-vigil')!;
const choir = findSet('ashen-choir')!;
const hunt = findSet('bloodmoon-hunt')!;

/** Only legendary rolls, to measure the set share of a table. */
const legendaryOnly: LootConfig = {
  ...DEFAULT_LOOT_CONFIG,
  rarities: Object.fromEntries(
    Object.entries(DEFAULT_LOOT_CONFIG.rarities).map(([id, r]) => [
      id,
      { ...r, weight: id === 'legendary' ? 1 : 0 },
    ]),
  ) as LootConfig['rarities'],
};

describe('set content (ticket 3.3)', () => {
  it('has 2–3 sets of 4–6 named pieces on their own bases, one piece per slot kind', () => {
    expect(ITEM_SETS.length).toBeGreaterThanOrEqual(2);
    expect(ITEM_SETS.length).toBeLessThanOrEqual(3);
    const allPieces = ITEM_SETS.flatMap((s) => s.pieces);
    expect(new Set(allPieces).size).toBe(allPieces.length);
    for (const set of ITEM_SETS) {
      expect(set.pieces.length, set.id).toBeGreaterThanOrEqual(4);
      expect(set.pieces.length, set.id).toBeLessThanOrEqual(6);
      const slots = set.pieces.map((p) => getItemBase(p).slot);
      expect(new Set(slots).size, set.id).toBe(slots.length);
      for (const id of set.pieces) {
        const base = getItemBase(id);
        expect(base.unique, id).toBe(true);
        expect(setForBase(id)?.id).toBe(set.id);
        // Armor and jewelry: every class can wear every piece (GDD §7.1).
        for (const c of CLASS_IDS) expect(canClassUseItem(base, c), `${id} ${c}`).toBe(true);
        // Never in a tier-wide table: pieces drop only through the set roll.
        for (const t of LOOT_TABLES) expect(t.entries.some((e) => e.baseId === id)).toBe(false);
      }
    }
  });

  it('has bonuses at 2, 4 and 6 pieces that are set effects of the one registry', () => {
    const used = new Set<string>();
    for (const set of ITEM_SETS) {
      const counts = set.bonuses.map((b) => b.pieces);
      expect(counts, set.id).toEqual([2, 4, 6].filter((n) => n <= set.pieces.length));
      for (const b of set.bonuses) {
        expect(findEffect(b.effectId)?.kind, b.effectId).toBe('set');
        expect(findEffect(b.effectId)?.classId, b.effectId).toBeUndefined();
        expect(used.has(b.effectId), b.effectId).toBe(false);
        used.add(b.effectId);
      }
    }
    // Every set effect belongs to a set.
    for (const e of EFFECTS.filter((x) => x.kind === 'set'))
      expect(used.has(e.id), e.id).toBe(true);
  });
});

describe('set counting', () => {
  it('counts distinct pieces of one set and activates the bonuses at 2, 4 and 6', () => {
    const pieces = vigil.pieces.map((id, i) => piece(id, i + 1));
    expect(wornSets([])).toEqual([]);
    expect(wornSets(pieces.slice(0, 1))[0]!.active).toEqual([]);
    expect(setBonusInstances(pieces.slice(0, 1))).toEqual([]);
    for (const [n, bonuses] of [
      [2, 1],
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 3],
    ] as const) {
      const worn = wornSets(pieces.slice(0, n));
      expect(worn).toHaveLength(1);
      expect(worn[0]!.pieces).toHaveLength(n);
      expect(worn[0]!.active.map((b) => b.pieces)).toEqual([2, 4, 6].slice(0, bonuses));
      expect(setBonusInstances(pieces.slice(0, n))).toEqual(
        vigil.bonuses.slice(0, bonuses).map((b) => ({ effectId: b.effectId, roll: 1 })),
      );
    }
  });

  it('counts a piece once, however many copies are worn (two of one ring)', () => {
    const seal = vigil.pieces.find((p) => getItemBase(p).slot === 'ring')!;
    const items = [piece(seal, 1), piece(seal, 2)];
    expect(wornSets(items)[0]!.pieces).toEqual([seal]);
    expect(setBonusInstances(items)).toEqual([]);
  });

  it('counts only items whose set id and base agree', () => {
    const [a, b] = vigil.pieces;
    // A forged set id on a plain base, the other set's id on a piece, a piece without its id.
    const forged: EquippedItem[] = [
      { ...piece(a!), setId: 'ashen-choir' },
      { ...generateItem({ seed: 1, itemLevel: 18, baseId: 'great-helm' })!, setId: vigil.id },
      { ...piece(b!), setId: null },
      { ...piece(b!), setId: 'no-such-set' },
    ];
    expect(wornSets(forged)).toEqual([]);
    expect(setBonusInstances(forged)).toEqual([]);
  });

  it('counts a Void piece as the same piece (GDD §7.4)', () => {
    const [a, b, c, d] = choir.pieces.map((id, i) => piece(id, i + 1));
    // A Void copy of a worn piece adds nothing; Void pieces make up a set with plain ones.
    expect(wornSets([a!, voidCopy(a!)])[0]!.pieces).toHaveLength(1);
    const mixed = [a!, voidCopy(b!), c!, voidCopy(d!)];
    expect(wornSets(mixed)[0]!.active.map((x) => x.pieces)).toEqual([2, 4]);
    expect(setBonusInstances(mixed)).toEqual(setBonusInstances([a!, b!, c!, d!]));
    // All Void is the same set too.
    expect(setBonusInstances([a!, b!].map(voidCopy))).toEqual(setBonusInstances([a!, b!]));
  });

  it('counts several sets at once (2 + 2 + 2)', () => {
    const items = [vigil, choir, hunt].flatMap((s) => s.pieces.slice(0, 2).map((id) => piece(id)));
    const worn = wornSets(items);
    expect(worn.map((w) => w.set.id)).toEqual(['drowned-vigil', 'ashen-choir', 'bloodmoon-hunt']);
    expect(setBonusInstances(items).map((i) => i.effectId)).toEqual([
      'vigil-tidebound',
      'choir-kindled',
      'bloodmoon-scent',
    ]);
  });

  it('feeds the bonuses to combat through the effect registry', () => {
    const items = vigil.pieces.slice(0, 2).map((id) => piece(id));
    const without = equipmentModifiers(items, undefined, undefined, { classId: 'warrior' });
    expect(without.effects.thorns).toBe(0);
    const withSet = equipmentModifiers(items, undefined, undefined, {
      classId: 'warrior',
      extraEffects: setBonusInstances(items),
    });
    expect(withSet.effects.thorns).toBe(
      resolveEffectComponents({ effectId: 'vigil-tidebound', roll: 1 })
        .filter((x) => x.type === 'thorns')
        .reduce((sum, x) => sum + x.reflect, 0),
    );
    expect(withSet.effects.thorns).toBeGreaterThan(0);
    // Stats are the items' own either way.
    expect(withSet.stats).toEqual(without.stats);
  });

  it('settlement and the crypt apply set bonuses only from two pieces on', () => {
    const settle = (equipment: GeneratedItem[]) =>
      settleFarming({
        character: { classId: 'warrior', level: 18, xp: 0 },
        equipment,
        areaId: 'sunkenAbbey',
        seed: 'sets',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      });
    const run = (equipment: GeneratedItem[]) =>
      simulateDungeonRun({
        dungeonId: 'namelessCrypt',
        character: { classId: 'warrior', level: 16, xp: 0 },
        equipment,
        seed: 'sets',
        bossLootEligible: false,
        inventoryCount: 0,
      });
    const [a, b] = vigil.pieces.map((id) => piece(id));
    // One piece: the same as wearing it with its set id stripped (no bonus).
    const stripped = strip(a!);
    expect(settle([a!])).toEqual(settle([stripped]));
    expect(run([a!])).toEqual(run([stripped]));
    // Two pieces: thorns (the 2-piece bonus) changes the fights.
    const two = [a!, b!];
    const strippedTwo = two.map(strip);
    expect(settle(two)).not.toEqual(settle(strippedTwo));
    expect(run(two).events).not.toEqual(run(strippedTwo).events);
  });
});

describe('set piece generation', () => {
  it('drops set pieces only from late-game tables, as SET_SHARE of their Legendary rolls', () => {
    const rng = createRng('set-sources');
    for (const tableId of LOOT_TABLES.map((t) => t.id)) {
      const table = getLootTable(tableId);
      let sets = 0;
      const n = 600;
      for (let i = 0; i < n; i++) {
        const item = generateItem(
          { seed: rng.int(0, 2 ** 32 - 1), itemLevel: 17, lootTable: table, classId: 'mage' },
          legendaryOnly,
        )!;
        if (item.setId === undefined) continue;
        sets++;
        expect(validateItem(item, legendaryOnly), item.baseId).toEqual([]);
        expect(item.rarityId).toBe('legendary');
        expect(item.effectId).toBeUndefined();
        expect(setForBase(item.baseId)?.id).toBe(item.setId);
      }
      // Ticket 3.6: the deeper crypt tiers are late-game sources too.
      // Ticket 4.8: the Ashen Pass and the Ashen Warden's hoard too.
      const lateGame = ['sunkenAbbey', 'namelessCrypt', 'gravewarden', 'ashenPass', 'ashenWarden'];
      if (lateGame.some((id) => tableId.startsWith(id))) {
        // Ticket B.2: a third of the Legendary rolls (was half).
        expect(sets / n, tableId).toBeGreaterThan(SET_SHARE - 0.06);
        expect(sets / n, tableId).toBeLessThan(SET_SHARE + 0.06);
      } else {
        expect(sets, tableId).toBe(0);
      }
    }
  });

  it('every piece can drop, roughly evenly, and only from item level 14', () => {
    const rng = createRng('set-pieces');
    const counts = new Map<string, number>();
    const n = 12_000;
    for (let i = 0; i < n; i++) {
      const item = generateItem(
        {
          seed: rng.int(0, 2 ** 32 - 1),
          itemLevel: 18,
          lootTable: getLootTable('sunkenAbbey'),
          classId: CLASS_IDS[i % 4]!,
        },
        legendaryOnly,
      )!;
      if (item.setId) counts.set(item.baseId, (counts.get(item.baseId) ?? 0) + 1);
    }
    const all = ITEM_SETS.flatMap((s) => s.pieces);
    for (const id of all) {
      expect(counts.get(id) ?? 0, id).toBeGreaterThan(((n * SET_SHARE) / all.length) * 0.7);
      expect(counts.get(id) ?? 0, id).toBeLessThan(((n * SET_SHARE) / all.length) * 1.3);
    }
    for (let i = 0; i < 300; i++) {
      const item = generateItem(
        { seed: i, itemLevel: 13, lootTable: getLootTable('namelessCrypt') },
        legendaryOnly,
      )!;
      expect(item.setId).toBeUndefined();
      expect(item.effectId).toBeDefined();
    }
  });

  it('a requested set base is always its set piece, deterministically', () => {
    for (const set of ITEM_SETS) {
      for (const id of set.pieces) {
        const item = generateItem({ seed: 42, itemLevel: 16, baseId: id, rarityId: 'common' })!;
        expect(item).toEqual(
          generateItem({ seed: 42, itemLevel: 16, baseId: id, rarityId: 'common' })!,
        );
        expect(generateItem({ seed: 42, itemLevel: 16, baseId: id })!.rarityId).toBe('legendary');
        expect(item.setId).toBe(set.id);
        expect(item.rarityId).toBe('legendary');
        expect(item.affixes).toHaveLength(DEFAULT_LOOT_CONFIG.rarities.legendary.affixCount);
        expect(validateItem(item)).toEqual([]);
      }
    }
  });

  it('validation rejects forged set pieces', () => {
    const real = piece(vigil.pieces[0]!);
    const errs = (item: GeneratedItem) => validateItem(item).join('; ');
    expect(errs(strip(real))).toMatch(/without its set/);
    expect(errs({ ...real, setId: 'ashen-choir' })).toMatch(/has no piece/);
    expect(errs({ ...real, setId: 'nope' })).toMatch(/unknown set/);
    expect(errs({ ...real, rarityId: 'epic', affixes: real.affixes.slice(0, 3) })).toMatch(
      /is epic/,
    );
    expect(errs({ ...real, effectId: 'emberbrand', effectRoll: 1 })).toMatch(/carries an effect/);
    const plain = generateItem({ seed: 1, itemLevel: 18, baseId: 'great-helm' })!;
    expect(errs({ ...plain, setId: vigil.id })).toMatch(/has no piece/);
    expect(findItemBase(vigil.pieces[0]!)).toBeDefined();
  });
});
