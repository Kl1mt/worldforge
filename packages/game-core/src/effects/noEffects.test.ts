import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  ITEM_BASES,
  canClassUseItem,
  createRng,
  generateItem,
  settleFarming,
  simulateDungeonRun,
  simulateFarming,
  setBonusInstances,
  type ClassId,
  type GeneratedItem,
  type RarityId,
} from '../index.js';

/**
 * Ticket 3.2 regression: without an effect equipped every number comes out exactly as before the
 * effect system existed. The hashes were computed on `main` before ticket 3.2 (commit fd6f726):
 * one-hour settlements with epic kits in three areas, detailed simulations and crypt runs, for
 * every class. Legendary and Mythic drops are left out of the settlement hash: since 3.2 they
 * carry an effect (and a Mythic roll outside late-game tables becomes a Legendary).
 *
 * Ticket 3.3 runs the same pinned hashes again: set pieces (Legendary rolls in late-game tables)
 * fall under the same exclusion, and kits whose items all carry set ids that cannot count (ids of
 * sets they are no piece of) still give exactly the pre-3.2 numbers.
 *
 * Ticket 3.4 runs them once more with every kit item at +0 carrying forge state: an explicit
 * `upgradeLevel: 0`, pity and reroll counters, and affixes marked `improvements: 0` /
 * `rerolled: true`. Only the upgrade level changes stats, and +0 must change nothing.
 */
const BEFORE_EFFECTS: Record<string, string> = {
  'settle:warrior:abandonedFields': '1273120753d9015e',
  'detailed:warrior:abandonedFields': '501d2889a23a12e2',
  'settle:warrior:oldBurialGrounds': 'bb794f83952b3ab6',
  'detailed:warrior:oldBurialGrounds': '87ed1af01e1c3269',
  'settle:warrior:sunkenAbbey': '552d0d6f5e8bb7e8',
  'detailed:warrior:sunkenAbbey': '90c0800f0957e4b6',
  'crypt:warrior': '3c62620aef1ccd8b',
  'settle:mage:abandonedFields': 'ee0577614cc0e542',
  'detailed:mage:abandonedFields': 'a4ddae16857650ef',
  'settle:mage:oldBurialGrounds': 'd84d44d1a58927d8',
  'detailed:mage:oldBurialGrounds': '1524daf167cd5f32',
  'settle:mage:sunkenAbbey': 'f3b9a90e01cdc6a7',
  'detailed:mage:sunkenAbbey': '6745287f5585d590',
  'crypt:mage': '21afe5a857ed1a75',
  'settle:hunter:abandonedFields': 'd16dd29fa6966590',
  'detailed:hunter:abandonedFields': 'e8370711608b2f0c',
  'settle:hunter:oldBurialGrounds': 'ecab3eb392e74272',
  'detailed:hunter:oldBurialGrounds': '0b3e1e27c1844e7c',
  'settle:hunter:sunkenAbbey': 'ec1564996fa8e0a8',
  'detailed:hunter:sunkenAbbey': '0a4b16415da2858c',
  'crypt:hunter': '09e9511d620cb828',
  'settle:warlock:abandonedFields': '864a22b5769a7bd0',
  'detailed:warlock:abandonedFields': '551dfa7cd23c2b0d',
  'settle:warlock:oldBurialGrounds': '48a80a64ba41cc4f',
  'detailed:warlock:oldBurialGrounds': '6d89093d28ebc934',
  'settle:warlock:sunkenAbbey': '07a2d8257e599116',
  'detailed:warlock:sunkenAbbey': 'ab55408db6392208',
  'crypt:warlock': 'a4a07c152bed8038',
};

function plainKit(classId: ClassId, itemLevel: number, rarityId: RarityId): GeneratedItem[] {
  const rng = createRng(`fp:${classId}:${itemLevel}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= itemLevel && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: GeneratedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel,
          baseId: base.id,
          rarityId,
          classId,
        })!,
      );
    }
  }
  return out;
}

/** Hash of a result; `momentum` (new in 3.2, always 0 here) is left out. */
const hash = (v: unknown) => {
  const text = JSON.stringify(v, (k, x: unknown) => (k === 'momentum' ? undefined : x));
  // Two FNV-1a passes (different offsets) → 64 bits as hex.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
};

/** Ticket 3.3: every kit item claims a set it is not a piece of; none of it may count. */
const forgedSetIds = (items: GeneratedItem[]) =>
  items.map((item, i) => ({
    ...item,
    setId: ['drowned-vigil', 'ashen-choir', 'bloodmoon-hunt'][i % 3]!,
  }));

/** Ticket 3.4: +0 items with forge history (counters and affix marks, no upgrade level). */
const forgedAtPlusZero = (items: GeneratedItem[]) =>
  items.map((item, i) => ({
    ...item,
    upgradeLevel: 0,
    upgradePity: i % 4,
    rerollCount: i % 3,
    affixes: item.affixes.map((a, j) => ({ ...a, improvements: 0, rerolled: (i + j) % 2 === 0 })),
  }));

describe.each([
  ['no effects equipped (ticket 3.2)', (items: GeneratedItem[]) => items],
  ['set ids that cannot count (ticket 3.3)', forgedSetIds],
  ['+0 items with forge state (ticket 3.4)', forgedAtPlusZero],
])('%s', (_, dress) => {
  it('farming, detailed simulation and the crypt give exactly the pre-3.2 results', () => {
    const kit = (classId: ClassId, itemLevel: number, rarityId: RarityId) => {
      const items = dress(plainKit(classId, itemLevel, rarityId));
      expect(setBonusInstances(items)).toEqual([]);
      return items;
    };
    const out: Record<string, string> = {};
    for (const c of CLASS_IDS) {
      for (const [area, level] of [
        ['abandonedFields', 3],
        ['oldBurialGrounds', 11],
        ['sunkenAbbey', 19],
      ] as const) {
        const s = settleFarming({
          character: { classId: c, level, xp: 0 },
          equipment: kit(c, level - 1, 'epic'),
          areaId: area,
          seed: `fp:${c}`,
          firstCycle: 0,
          durationMs: 3_600_000,
          inventoryCount: 0,
        });
        expect(s.momentum).toBe(0);
        out[`settle:${c}:${area}`] = hash({
          ...s,
          items: s.items.filter((i) => i.rarityId !== 'legendary' && i.rarityId !== 'mythic'),
          salvaged: [],
          goldSalvaged: 0,
        });
        const d = simulateFarming(
          {
            character: { classId: c, level, xp: 0 },
            equipment: [],
            areaId: area,
            seed: `fpd:${c}`,
            durationMs: 600_000,
          },
          { maxEvents: 500 },
        );
        out[`detailed:${c}:${area}`] = hash(d);
      }
      const r = simulateDungeonRun({
        dungeonId: 'namelessCrypt',
        character: { classId: c, level: 15, xp: 0 },
        equipment: kit(c, 14, 'rare'),
        seed: `fp-crypt:${c}`,
        bossLootEligible: true,
        inventoryCount: 0,
      });
      out[`crypt:${c}`] = hash({ ...r, items: [], salvaged: [] });
    }
    expect(out).toEqual(BEFORE_EFFECTS);
  });
});

it('the +0 check can fail: the same kit at +5 changes the settlement (ticket 3.4)', () => {
  const run = (upgradeLevel: number) =>
    hash(
      settleFarming({
        character: { classId: 'warrior', level: 19, xp: 0 },
        equipment: plainKit('warrior', 18, 'epic').map((i) => ({ ...i, upgradeLevel })),
        areaId: 'sunkenAbbey',
        seed: 'fp:warrior',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      }),
    );
  expect(run(5)).not.toBe(run(0));
});
