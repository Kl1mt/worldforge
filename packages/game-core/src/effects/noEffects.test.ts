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
  getDungeonTier,
  EMPTY_LOOT_FILTER,
  AREA_LOOT_TABLES,
  BOSS_LOOT_TABLES,
  type LootTableDefinition,
  type LootFilterRules,
  type EquippedItem,
  characterPower,
} from '../index.js';
import { awakenItem, evaluationSettings } from '../items/awakening.js';
import { buildItems, buildSlots, chassis, effectPool, type Build } from '../balance/builds.js';

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
 *
 * Ticket 3.5 runs them again with an explicit `variant: null` on every kit item, and with a stray
 * `variant: 'void'` on the epic and rare kits (Void exists only on Legendaries and Mythics, so it
 * must do nothing there). Void Legendary and Mythic drops fall under the drop exclusion above.
 *
 * Ticket 3.6 retuned crypt tier I in exactly two ways (docs/DUNGEONS.md): the Gravewarden's enrage
 * moment is drawn per run from 30–70 s (it was fixed at 45 s), from its own seed stream; and the
 * tier's tables carry a loot focus (rings and amulets weigh × 3), which only changes which base an
 * item seed picks (drops are outside the crypt hash). So the crypt hashes are checked with the
 * enrage pinned back to 45 s (`withPre36Enrage`): everything else about a run must be unchanged.
 * The run result's new `tier` and `enrageAtMs` fields are left out of the hash.
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
  const text = JSON.stringify(v, (k, x: unknown) =>
    // `momentum` (3.2) is always 0 here; an empty `filtered` list (3.7) is "nothing filtered".
    k === 'momentum' || (k === 'filtered' && Array.isArray(x) && x.length === 0) ? undefined : x,
  );
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

/**
 * Ticket 3.6: runs `f` with tier I's enrage fixed at its pre-3.6 moment (45 s). A window of one
 * value draws nothing, so the run is the pre-3.6 run.
 */
function withPre36Enrage<T>(f: () => T): T {
  const enrage = getDungeonTier('namelessCrypt', 1).bossEnrage;
  const window = enrage.atMs;
  enrage.atMs = { min: 45_000, max: 45_000 };
  try {
    return f();
  } finally {
    enrage.atMs = window;
  }
}

/** Ticket 3.6: a crypt run's hash without the fields 3.6 added. */
const cryptHash = (r: ReturnType<typeof simulateDungeonRun>) =>
  hash({
    ...r,
    items: [],
    overCapacity: undefined,
    salvaged: [],
    tier: undefined,
    enrageAtMs: undefined,
  });

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

/** Ticket 3.5: no variant, stated explicitly (the column's null). */
const noVariant = (items: GeneratedItem[]) => items.map((item) => ({ ...item, variant: null }));

/** Ticket 3.5: a Void flag on items that cannot be Void (epic and rare kits) does nothing. */
const strayVoid = (items: GeneratedItem[]) =>
  items.map((item) => ({ ...item, variant: 'void' as const }));
/** Ticket 6.4: likewise a Prismatic flag (Legendary and Mythic only, like Void). */
const strayPrismatic = (items: GeneratedItem[]) =>
  items.map((item) => ({ ...item, variant: 'prismatic' as const }));

/** Ticket 6.5: an explicit `awakening: null` on every item (the field a 6.5b column would fill). */
const noAwakening = (items: GeneratedItem[]) => items.map((item) => ({ ...item, awakening: null }));

/** Ticket 6.5: every item offered to the prototype with the switch off (the default): refused. */
const refusedAwakening = (items: GeneratedItem[]) =>
  items.map((item) => {
    const r = awakenItem(item);
    expect(r).toEqual({ ok: false, reason: 'disabled' });
    return item;
  });

/** Ticket 6.5: neutral awakenings a reader must ignore (strength 1, an empty affix-slot mark). */
const strayAwakening = (items: GeneratedItem[]) =>
  items.map((item, i) => ({
    ...item,
    awakening:
      i % 2 === 0
        ? { option: 'effect' as const, effectStrength: 1 }
        : { option: 'affixSlot' as const, affixIndex: item.affixes.length },
  }));

/**
 * The pinned hashes for a kit dressing and a loot filter (ticket 3.7: the filter only decides what
 * happens to drops, and with no rules nothing changes at all).
 */
/**
 * Ticket B.2: runs `f` with the late-game loot tables as before B.2 (no Legendary weight, half of
 * the Legendary rolls set pieces). B.2 changed only these two table fields, so with them restored
 * every pinned hash must come out exactly as before.
 */
function withPreB2Loot<T>(f: () => T): T {
  const tables = [...AREA_LOOT_TABLES, ...BOSS_LOOT_TABLES].filter(
    (t) => t.legendaryWeight !== undefined,
  ) as LootTableDefinition[];
  const saved = tables.map((t) => ({ t, w: t.legendaryWeight, s: t.setShare }));
  for (const t of tables) {
    delete t.legendaryWeight;
    t.setShare = 0.5;
  }
  try {
    return f();
  } finally {
    for (const { t, w, s } of saved) {
      if (w !== undefined) t.legendaryWeight = w;
      if (s !== undefined) t.setShare = s;
    }
  }
}

function pinnedHashes(
  dress: (items: GeneratedItem[]) => EquippedItem[],
  lootFilter?: LootFilterRules | null,
): Record<string, string> {
  return withPreB2Loot(() => pinnedHashesNow(dress, lootFilter));
}

function pinnedHashesNow(
  dress: (items: GeneratedItem[]) => EquippedItem[],
  lootFilter?: LootFilterRules | null,
): Record<string, string> {
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
        ...(lootFilter !== undefined ? { lootFilter } : {}),
      });
      expect(s.momentum).toBe(0);
      out[`settle:${c}:${area}`] = hash({
        ...s,
        items: s.items.filter((i) => i.rarityId !== 'legendary' && i.rarityId !== 'mythic'),
        // Ticket B.2's field (always empty with an empty pack).
        overCapacity: undefined,
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
    const r = withPre36Enrage(() =>
      simulateDungeonRun({
        dungeonId: 'namelessCrypt',
        character: { classId: c, level: 15, xp: 0 },
        equipment: kit(c, 14, 'rare'),
        seed: `fp-crypt:${c}`,
        bossLootEligible: true,
        inventoryCount: 0,
        ...(lootFilter !== undefined ? { lootFilter } : {}),
      }),
    );
    out[`crypt:${c}`] = cryptHash(r);
  }
  return out;
}

describe.each([
  ['no effects equipped (ticket 3.2)', (items: GeneratedItem[]) => items],
  ['set ids that cannot count (ticket 3.3)', forgedSetIds],
  ['+0 items with forge state (ticket 3.4)', forgedAtPlusZero],
  ['no variant (ticket 3.5)', noVariant],
  ['a Void flag on items that cannot be Void (ticket 3.5)', strayVoid],
  ['a Prismatic flag on items that cannot be Prismatic (ticket 6.4)', strayPrismatic],
  ['no awakening (ticket 6.5)', noAwakening],
  ['awakenings refused by the switch (ticket 6.5)', refusedAwakening],
  ['neutral awakenings (ticket 6.5)', strayAwakening],
])('%s', (_, dress) => {
  it('farming, detailed simulation and the crypt give exactly the pre-3.2 results', () => {
    expect(pinnedHashes(dress)).toEqual(BEFORE_EFFECTS);
  });
});

/**
 * Ticket 3.7: no loot filter (absent or null) gives exactly the pinned numbers, and so do rules
 * that handle nothing (the empty rules, or a rarity rule at Common) apart from an empty
 * `filtered` list.
 */
describe.each([
  ['a null loot filter (ticket 3.7)', null],
  ['the empty loot filter (ticket 3.7)', EMPTY_LOOT_FILTER],
  ['a loot filter below Common (ticket 3.7)', { ...EMPTY_LOOT_FILTER, belowRarity: 'common' }],
] as const)('%s', (_, lootFilter) => {
  it('farming, detailed simulation and the crypt give exactly the pre-3.2 results', () => {
    expect(pinnedHashes((items) => items, lootFilter as LootFilterRules | null)).toEqual(
      BEFORE_EFFECTS,
    );
  });
});

it('the loot filter check can fail: an active filter changes the settlement (ticket 3.7)', () => {
  const lootFilter = { ...EMPTY_LOOT_FILTER, belowRarity: 'rare' as const };
  expect(pinnedHashes((items) => items, lootFilter)).not.toEqual(BEFORE_EFFECTS);
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

it('the Void check can fail: the same kit as Void Legendaries changes the settlement (ticket 3.5)', () => {
  const run = (variant: 'void' | null) =>
    hash(
      settleFarming({
        character: { classId: 'warrior', level: 19, xp: 0 },
        equipment: plainKit('warrior', 18, 'legendary').map((i) => ({ ...i, variant })),
        areaId: 'sunkenAbbey',
        seed: 'fp:warrior',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      }),
    );
  expect(run('void')).not.toBe(run(null));
});

it('the Prismatic check can fail: the same kit as Prismatic Legendaries changes the settlement (ticket 6.4)', () => {
  const run = (variant: 'prismatic' | 'void' | null) =>
    hash(
      settleFarming({
        character: { classId: 'warrior', level: 19, xp: 0 },
        equipment: plainKit('warrior', 18, 'legendary').map((i) => ({ ...i, variant })),
        areaId: 'sunkenAbbey',
        seed: 'fp:warrior',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      }),
    );
  expect(run('prismatic')).not.toBe(run(null));
  // A different shape from Void's, not the same numbers.
  expect(run('prismatic')).not.toBe(run('void'));
});

it('the crypt check can fail: tier I’s enrage window changes the runs (ticket 3.6)', () => {
  const runs = CLASS_IDS.flatMap((c) =>
    Array.from({ length: 8 }, (_, i) => {
      const input = {
        dungeonId: 'namelessCrypt' as const,
        character: { classId: c, level: 13, xp: 0 },
        equipment: plainKit(c, 12, 'common'),
        seed: `fp-crypt-36:${c}:${i}`,
        bossLootEligible: false,
        inventoryCount: 0,
      };
      return [
        cryptHash(withPre36Enrage(() => simulateDungeonRun(input))),
        cryptHash(simulateDungeonRun(input)),
      ];
    }),
  );
  expect(runs.some(([before, after]) => before !== after)).toBe(true);
});

describe('the late-game loot tables (ticket B.2)', () => {
  it('changed only the Sunken Abbey and crypt hashes, nothing else', () => {
    const now = pinnedHashesNow((items) => items);
    const moved = Object.keys(BEFORE_EFFECTS).filter((k) => now[k] !== BEFORE_EFFECTS[k]);
    expect(moved.length).toBeGreaterThan(0);
    for (const k of moved) expect(k).toMatch(/sunkenAbbey|crypt/);
  });
});

/**
 * Ticket 6.5: Item Awakening is switched off. The pinned kits above hold no Legendary, so this
 * also checks a late-game kit the prototype would accept (+10 Void Legendaries with effects and
 * four Drowned Vigil pieces at item level 37): offered to it with the default settings, every
 * piece is refused and the Depths settlement, a Forge Tyrant run and Character Power are exactly
 * those of the untouched kit; with the switch on (the evaluation only) each option changes them.
 */
describe('Item Awakening switched off (ticket 6.5)', () => {
  const c: ClassId = 'warrior';
  const slots = buildSlots(c);
  const vigil = chassis(c, [['drowned-vigil', 4]]);
  const build: Build = {
    classId: c,
    chassis: vigil.name,
    picks: vigil.fixed.map(
      (f, i) => f ?? { kind: 'legendary', effectId: effectPool(c, slots[i]!, 37)[i % 2] ?? null },
    ),
    pkg: 'crit',
    upgradeLevel: 10,
    void: true,
  };
  const kit = buildItems(build, 37);
  const results = (equipment: EquippedItem[]) => ({
    settle: hash(
      settleFarming({
        character: { classId: c, level: 38, xp: 0 },
        equipment,
        areaId: 'cinderDepths',
        seed: 'awakening-off',
        firstCycle: 0,
        durationMs: 3_600_000,
        inventoryCount: 0,
      }),
    ),
    tyrant: cryptHash(
      simulateDungeonRun({
        dungeonId: 'tyrantsForge',
        character: { classId: c, level: 38, xp: 0 },
        equipment,
        seed: 'awakening-off',
        bossLootEligible: true,
        inventoryCount: 0,
      }),
    ),
    power: characterPower({ classId: c, level: 38, equipment }).power,
  });
  const before = results(kit);

  it('refuses every piece, and the kit fights exactly as before', () => {
    const offered = kit.map((item) => {
      const r = awakenItem(item);
      expect(r.ok).toBe(false);
      return r.ok ? r.item : item;
    });
    expect(results(offered)).toEqual(before);
    expect(results(kit.map((i) => ({ ...i, awakening: null })))).toEqual(before);
  });

  it('the check can fail: with the switch on, either option changes the results', () => {
    const on = (option: 'effect' | 'affixSlot') =>
      kit.map((item) => {
        const r = awakenItem(item, evaluationSettings({ option, affixValueShare: 0.5 }), {
          affixId: 'health',
          roll: 0.5,
          classId: c,
        });
        return r.ok ? r.item : item;
      });
    const effect = results(on('effect'));
    const slot = results(on('affixSlot'));
    expect(effect.settle).not.toBe(before.settle);
    expect(effect.tyrant).not.toBe(before.tyrant);
    expect(slot.settle).not.toBe(before.settle);
    expect(slot.settle).not.toBe(effect.settle);
  });
});
