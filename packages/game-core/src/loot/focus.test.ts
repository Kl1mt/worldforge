import { describe, expect, it } from 'vitest';
import {
  CRYPT_LOOT_FOCI,
  DEFAULT_LOOT_CONFIG,
  DUNGEON_TIERS,
  EFFECTS,
  ITEM_SETS,
  createRng,
  findEffect,
  generateItem,
  getDungeonTier,
  getItemBase,
  getLootTable,
  setForBase,
  validateItem,
  type GeneratedItem,
  type LootConfig,
  type LootTableDefinition,
} from '../index.js';

/**
 * Ticket 3.6: targeted loot. A loot focus only reweights draws the generator makes anyway, so the
 * same seed rolls the same rarity, item level and set/Mythic outcome with or without it.
 */

const N = 3000;
const seeds = (label: string, n = N) => {
  const rng = createRng(`focus:${label}`);
  return Array.from({ length: n }, () => rng.int(0, 2 ** 32 - 1));
};
const roll = (table: LootTableDefinition, seed: number, config?: LootConfig) =>
  generateItem({ seed, itemLevel: 20, lootTable: table, classId: 'warrior' }, config)!;
const withoutFocus = (table: LootTableDefinition): LootTableDefinition =>
  Object.fromEntries(
    Object.entries(table).filter(([k]) => k !== 'focus'),
  ) as unknown as LootTableDefinition;
/** Legendary rolls only, to see set pieces and effects often. */
const legendaryOnly: LootConfig = {
  ...DEFAULT_LOOT_CONFIG,
  rarities: Object.fromEntries(
    Object.entries(DEFAULT_LOOT_CONFIG.rarities).map(([id, r]) => [
      id,
      { ...r, weight: id === 'legendary' ? 1 : 0 },
    ]),
  ) as LootConfig['rarities'],
};

describe('crypt loot foci (ticket 3.6)', () => {
  it('each tier declares one focus, shared by its chambers and its Gravewarden', () => {
    const ids = new Set<string>();
    for (const t of DUNGEON_TIERS) {
      const tier = getDungeonTier('namelessCrypt', t);
      const rooms = getLootTable(tier.lootTableId);
      const boss = getLootTable(tier.bossLoot.lootTableId);
      expect(rooms.focus, `tier ${t}`).toBe(CRYPT_LOOT_FOCI[t]);
      expect(boss.focus, `tier ${t}`).toBe(CRYPT_LOOT_FOCI[t]);
      ids.add(rooms.focus!.id);
    }
    expect(ids.size).toBe(DUNGEON_TIERS.length);
  });

  it('every focus names real sets, slots and Legendary effects, with sane weights', () => {
    for (const focus of Object.values(CRYPT_LOOT_FOCI)) {
      expect(focus.name.length).toBeGreaterThan(0);
      expect(focus.description.length).toBeGreaterThan(0);
      const f: {
        sets?: readonly string[];
        effects?: readonly string[];
        slots?: readonly string[];
      } = focus;
      for (const s of f.sets ?? []) expect(ITEM_SETS.map((x) => x.id)).toContain(s);
      for (const e of f.effects ?? []) expect(findEffect(e)?.kind, e).toBe('legendary');
      // A focus favours something.
      expect(
        (f.sets?.length ?? 0) + (f.effects?.length ?? 0) + (f.slots?.length ?? 0),
      ).toBeGreaterThan(0);
    }
    expect(CRYPT_LOOT_FOCI[1].slotWeight).toBeGreaterThan(1);
    expect(CRYPT_LOOT_FOCI[3].effectWeight).toBeGreaterThan(1);
  });

  it('a slot focus favours its slots and leaves every rarity, level and set roll as it was', () => {
    const table = getLootTable('gravewarden');
    const plain = withoutFocus(table);
    const isFocused = (i: GeneratedItem) => ['ring', 'neck'].includes(getItemBase(i.baseId).slot);
    let focused = 0;
    let before = 0;
    for (const seed of seeds('slots')) {
      const a = roll(table, seed);
      const b = roll(plain, seed);
      expect([a.rarityId, a.itemLevel, a.setId !== undefined, a.mythicId]).toEqual([
        b.rarityId,
        b.itemLevel,
        b.setId !== undefined,
        b.mythicId,
      ]);
      expect(validateItem(a)).toEqual([]);
      if (isFocused(a)) focused++;
      if (isFocused(b)) before++;
    }
    // Weight × 3 on rings and amulets (the boss's seal and chain already weigh a lot): their
    // share rises clearly, but other slots still drop.
    expect(focused / before).toBeGreaterThan(1.4);
    expect(focused / N).toBeLessThan(0.8);
  });

  it('a set focus turns every set piece into a piece of its set, at the same rolls', () => {
    for (const [tableId, setId] of [
      ['namelessCryptII', 'drowned-vigil'],
      ['gravewardenII', 'drowned-vigil'],
      ['namelessCryptIII', 'ashen-choir'],
      ['gravewardenIII', 'ashen-choir'],
    ] as const) {
      const table = getLootTable(tableId);
      const plain = withoutFocus(table);
      const pieces = new Set<string>();
      let sets = 0;
      for (const seed of seeds(tableId, 800)) {
        const a = roll(table, seed, legendaryOnly);
        const b = roll(plain, seed, legendaryOnly);
        expect(a.setId !== undefined, tableId).toBe(b.setId !== undefined);
        expect(a.variant, tableId).toBe(b.variant);
        if (a.setId === undefined) {
          // Tier III's effect focus may pick another effect; nothing else differs.
          expect({ ...a, effectId: undefined }).toEqual({ ...b, effectId: undefined });
          continue;
        }
        sets++;
        expect(a.setId).toBe(setId);
        expect(setForBase(a.baseId)?.id).toBe(setId);
        expect(validateItem(a, legendaryOnly)).toEqual([]);
        pieces.add(a.baseId);
      }
      // About SET_SHARE (a third since ticket B.2) of the Legendary rolls.
      expect(sets, tableId).toBeGreaterThan(200);
      // Every piece of the set can drop there.
      expect(pieces.size, tableId).toBe(ITEM_SETS.find((s) => s.id === setId)!.pieces.length);
    }
  });

  it('an effect focus favours its effects and changes nothing else about an item', () => {
    const table = getLootTable('gravewardenIII');
    const plain = withoutFocus(table);
    const focus = CRYPT_LOOT_FOCI[3].effects as readonly string[];
    let focused = 0;
    let before = 0;
    let effects = 0;
    for (const seed of seeds('effects')) {
      const a = roll(table, seed, legendaryOnly);
      const b = roll(plain, seed, legendaryOnly);
      const { effectId: ea, ...ra } = a;
      const { effectId: eb, ...rb } = b;
      if (a.setId !== undefined) continue;
      expect(ra).toEqual(rb);
      if (ea === undefined) continue;
      effects++;
      expect(validateItem(a, legendaryOnly)).toEqual([]);
      if (focus.includes(ea)) focused++;
      if (eb !== undefined && focus.includes(eb)) before++;
    }
    expect(effects).toBeGreaterThan(1000);
    expect(focused / before).toBeGreaterThan(1.5);
    // Other effects still drop.
    expect(focused / effects).toBeLessThan(0.9);
  });

  it('tables without a focus roll exactly as before (the Abbey and the areas)', () => {
    for (const id of ['sunkenAbbey', 'blackwater', 'crowwood']) {
      const table = getLootTable(id);
      expect(table.focus).toBeUndefined();
      for (const seed of seeds(id, 200))
        expect(roll(table, seed)).toEqual(roll(withoutFocus(table), seed));
    }
    // The registry's own weights are untouched.
    expect(EFFECTS.find((e) => e.id === 'tyrants-bane')?.weight).toBeGreaterThan(0);
  });
});
