import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVITY_CONFIG,
  EMPTY_LOOT_FILTER,
  createDropPlacer,
  filteredTotals,
  isValuableDrop,
  generateItem,
  isLootFilterActive,
  lootFilterCategories,
  lootFilterHandles,
  lootFilterYield,
  parseLootFilter,
  salvageYield,
  sellPrice,
  settleFarming,
  simulateDungeonRun,
  type GeneratedItem,
  type LootFilterRules,
  type SettleFarmingInput,
} from '../index.js';

const HOUR = 60 * 60 * 1000;

const rules = (r: Partial<LootFilterRules>): LootFilterRules => ({ ...EMPTY_LOOT_FILTER, ...r });

const item = (over: Partial<GeneratedItem>): GeneratedItem => ({
  seed: 1,
  baseId: 'iron-ring',
  rarityId: 'rare',
  itemLevel: 10,
  affixes: [{ affixId: 'gold-find', tier: 1, value: 0.05 }],
  ...over,
});

/** Everything a filter can name, so a protected item would match every rule. */
const harshest = rules({
  action: 'sell',
  belowRarity: 'mythic',
  wantedAffixes: ['crit-damage'],
});

describe('lootFilterHandles', () => {
  it('handles drops below the chosen rarity, keeps the rest', () => {
    const r = rules({ belowRarity: 'rare' });
    expect(lootFilterHandles(item({ rarityId: 'common', affixes: [] }), r)).toBe(true);
    expect(lootFilterHandles(item({ rarityId: 'uncommon' }), r)).toBe(true);
    expect(lootFilterHandles(item({ rarityId: 'rare' }), r)).toBe(false);
    expect(lootFilterHandles(item({ rarityId: 'epic' }), r)).toBe(false);
  });

  it('handles drops without any wanted affix or effect', () => {
    const r = rules({ wantedAffixes: ['gold-find', 'crit-chance'] });
    expect(lootFilterHandles(item({}), r)).toBe(false);
    expect(lootFilterHandles(item({ affixes: [] }), r)).toBe(true);
    expect(lootFilterHandles(item({ affixes: [{ affixId: 'armor', tier: 1, value: 4 }] }), r)).toBe(
      true,
    );
    // An effect alone satisfies the wanted list (once Legendaries are opted in).
    const leg = item({ rarityId: 'legendary', affixes: [], effectId: 'emberbrand' });
    const withEffect = rules({ wantedEffects: ['emberbrand'], include: ['legendary'] });
    expect(lootFilterHandles(leg, withEffect)).toBe(false);
    expect(lootFilterHandles({ ...leg, effectId: 'headsmans-due' }, withEffect)).toBe(true);
  });

  it('either rule is enough (below the rarity, or none of the wanted)', () => {
    const r = rules({ belowRarity: 'rare', wantedAffixes: ['gold-find'] });
    expect(lootFilterHandles(item({ rarityId: 'uncommon' }), r)).toBe(true);
    expect(lootFilterHandles(item({ rarityId: 'epic', affixes: [] }), r)).toBe(true);
    expect(lootFilterHandles(item({ rarityId: 'epic' }), r)).toBe(false);
  });

  it('never handles anything with empty rules', () => {
    for (const rarityId of ['common', 'epic', 'mythic'] as const) {
      expect(lootFilterHandles(item({ rarityId }), EMPTY_LOOT_FILTER)).toBe(false);
    }
    expect(isLootFilterActive(EMPTY_LOOT_FILTER)).toBe(false);
    expect(isLootFilterActive(rules({ belowRarity: 'common' }))).toBe(false);
    expect(isLootFilterActive(null)).toBe(false);
    expect(isLootFilterActive(rules({ belowRarity: 'uncommon' }))).toBe(true);
    expect(isLootFilterActive(rules({ wantedEffects: ['emberbrand'] }))).toBe(true);
  });

  describe('protected categories', () => {
    const legendary = item({ rarityId: 'legendary', effectId: 'emberbrand', effectRoll: 0.5 });
    const mythic = item({ rarityId: 'mythic', mythicId: 'x', effectId: 'y' });
    const setPiece = item({ rarityId: 'legendary', setId: 'drowned-vigil' });
    const voidLegendary = { ...legendary, variant: 'void' as const };
    const voidSet = { ...setPiece, variant: 'void' as const };

    it('classifies items', () => {
      expect(lootFilterCategories(item({}))).toEqual([]);
      expect(lootFilterCategories(legendary)).toEqual(['legendary']);
      expect(lootFilterCategories(mythic)).toEqual(['mythic']);
      expect(lootFilterCategories(setPiece)).toEqual(['set']);
      expect(lootFilterCategories(voidLegendary)).toEqual(['legendary', 'void']);
      expect(lootFilterCategories(voidSet)).toEqual(['set', 'void']);
    });

    it('keeps Legendary, Mythic, set and Void items by default under any rule', () => {
      for (const it of [legendary, mythic, setPiece, voidLegendary, voidSet]) {
        expect(lootFilterHandles(it, harshest)).toBe(false);
      }
    });

    it('handles a category only when the player opted it in, every category of the item', () => {
      expect(lootFilterHandles(legendary, { ...harshest, include: ['legendary'] })).toBe(true);
      expect(lootFilterHandles(mythic, { ...harshest, include: ['mythic'] })).toBe(true);
      expect(lootFilterHandles(setPiece, { ...harshest, include: ['set'] })).toBe(true);
      expect(lootFilterHandles(setPiece, { ...harshest, include: ['legendary'] })).toBe(false);
      expect(lootFilterHandles(voidLegendary, { ...harshest, include: ['legendary'] })).toBe(false);
      expect(lootFilterHandles(voidSet, { ...harshest, include: ['set'] })).toBe(false);
      expect(lootFilterHandles(voidSet, { ...harshest, include: ['set', 'void'] })).toBe(true);
    });

    it('protects Prismatic as its own category; a filter saved before 6.4 keeps it', () => {
      const prism = { ...legendary, variant: 'prismatic' as const };
      expect(lootFilterCategories(prism)).toEqual(['legendary', 'prismatic']);
      expect(lootFilterHandles(prism, harshest)).toBe(false);
      // Opting in Legendary and Void (all a pre-6.4 filter could) still keeps it.
      expect(
        lootFilterHandles(prism, { ...harshest, include: ['legendary', 'mythic', 'set', 'void'] }),
      ).toBe(false);
      expect(lootFilterHandles(prism, { ...harshest, include: ['legendary', 'prismatic'] })).toBe(
        true,
      );
    });
  });
});

describe('lootFilterYield', () => {
  it('pays the merchant price or the forge salvage, exactly as by hand', () => {
    const i = item({ baseId: 'iron-ring', rarityId: 'epic', itemLevel: 14 });
    expect(lootFilterYield(i, 'sell')).toEqual({ gold: sellPrice(i), materials: {} });
    expect(lootFilterYield(i, 'salvage')).toEqual(salvageYield(i));
  });
});

describe('parseLootFilter', () => {
  it('accepts and normalises valid rules (content order, no duplicates)', () => {
    const r = parseLootFilter({
      action: 'sell',
      belowRarity: 'rare',
      wantedAffixes: ['gold-find', 'armor', 'gold-find'],
      wantedEffects: [],
      include: ['void', 'set'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules.wantedAffixes).toEqual(['armor', 'gold-find']);
    expect(r.rules.include).toEqual(['set', 'void']);
  });

  it('refuses unknown values', () => {
    const bad = parseLootFilter({
      action: 'burn',
      belowRarity: 'shiny',
      wantedAffixes: ['nope'],
      wantedEffects: ['also-nope'],
      include: ['common'],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((p) => p.field).sort()).toEqual([
      'action',
      'belowRarity',
      'include',
      'wantedAffixes',
      'wantedEffects',
    ]);
    expect(parseLootFilter({ action: 'sell', wantedAffixes: Array(17).fill('armor') }).ok).toBe(
      false,
    );
  });
});

describe('createDropPlacer', () => {
  const drops = Array.from({ length: 12 }, (_, i) =>
    generateItem({ seed: 1000 + i, itemLevel: 12 })!,
  );

  it('without a filter is the old capacity rule', () => {
    const p = createDropPlacer(57, DEFAULT_ACTIVITY_CONFIG.inventory, null);
    for (const d of drops) p.place(d);
    const r = p.result();
    expect(drops.some(isValuableDrop)).toBe(false);
    expect(r.items).toEqual(drops.slice(0, 3));
    expect(r.overCapacity).toEqual([]);
    expect(r.salvaged).toEqual(drops.slice(3));
    expect(r.filtered).toBeUndefined();
  });

  describe('valuable drops survive a full pack (ticket B.2)', () => {
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    const legendary = item({ seed: 11, rarityId: 'legendary', effectId: 'emberbrand' });
    const mythic = item({ seed: 12, rarityId: 'mythic', mythicId: 'widowmaker' });
    const setPiece = item({ seed: 13, rarityId: 'legendary', setId: 'drownedVigil' });
    const voidLeg = item({ seed: 14, rarityId: 'legendary', effectId: 'ambush', variant: 'void' });
    const epic = item({ seed: 15, rarityId: 'epic' });
    const common = item({ seed: 16, rarityId: 'common', affixes: [] });
    const mixed = [common, legendary, epic, mythic, setPiece, common, voidLeg, epic];

    it('Legendary, Mythic, set and Void are valuable; nothing else is', () => {
      expect([legendary, mythic, setPiece, voidLeg].map(isValuableDrop)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect([epic, common].map(isValuableDrop)).toEqual([false, false]);
    });

    it('keeps valuable drops beyond the capacity and salvages only ordinary ones', () => {
      for (const held of [cap, cap + 5]) {
        const p = createDropPlacer(held, DEFAULT_ACTIVITY_CONFIG.inventory, null);
        for (const d of mixed) p.place(d);
        const r = p.result();
        expect(r.items).toEqual([legendary, mythic, setPiece, voidLeg]);
        expect(r.overCapacity).toEqual(r.items);
        expect(r.salvaged).toEqual([common, epic, common, epic]);
      }
    });

    it('fills free slots in drop order first; only drops after that go over', () => {
      const p = createDropPlacer(cap - 2, DEFAULT_ACTIVITY_CONFIG.inventory, null);
      for (const d of mixed) p.place(d);
      const r = p.result();
      expect(r.items).toEqual([common, legendary, mythic, setPiece, voidLeg]);
      expect(r.overCapacity).toEqual([mythic, setPiece, voidLeg]);
      expect(r.salvaged).toEqual([epic, common, epic]);
    });

    it("the loot filter's opt-in categories still apply first", () => {
      const all = rules({
        belowRarity: 'mythic',
        include: ['legendary', 'mythic', 'set', 'void'],
      });
      const p = createDropPlacer(cap, DEFAULT_ACTIVITY_CONFIG.inventory, all);
      for (const d of mixed) p.place(d);
      const r = p.result();
      // The Mythic is not below Mythic, so the rarity rule keeps it (over the capacity).
      expect(r.items).toEqual([mythic]);
      expect(r.filtered!.map((f) => f.item)).toEqual(mixed.filter((d) => d.rarityId !== 'mythic'));
      expect(r.salvaged).toEqual([]);
      // Only Legendaries opted in: the rest stays protected and goes over the capacity.
      const some = rules({ belowRarity: 'mythic', include: ['legendary'] });
      const q = createDropPlacer(cap, DEFAULT_ACTIVITY_CONFIG.inventory, some);
      for (const d of mixed) q.place(d);
      expect(q.result().items).toEqual([mythic, setPiece, voidLeg]);
      expect(q.result().overCapacity).toEqual([mythic, setPiece, voidLeg]);
    });
  });

  it('filtered drops take no pack space; kept drops still overflow in order', () => {
    const r0 = rules({ belowRarity: 'rare', action: 'sell' });
    const p = createDropPlacer(57, DEFAULT_ACTIVITY_CONFIG.inventory, r0);
    for (const d of drops) p.place(d);
    const r = p.result();
    const kept = drops.filter((d) => !lootFilterHandles(d, r0));
    expect(r.filtered!.map((f) => f.item)).toEqual(drops.filter((d) => lootFilterHandles(d, r0)));
    expect(r.items).toEqual(kept.slice(0, 3));
    expect(r.salvaged).toEqual(kept.slice(3));
    const totals = filteredTotals(r.filtered);
    expect(totals.sold).toBe(r.filtered!.length);
    expect(totals.gold).toBe(r.filtered!.reduce((s, f) => s + sellPrice(f.item), 0));
  });
});

const farm = (over: Partial<SettleFarmingInput> = {}): SettleFarmingInput => ({
  character: { classId: 'hunter', level: 12, xp: 0 },
  areaId: 'oldBurialGrounds',
  seed: 'filter-test',
  durationMs: 2 * HOUR,
  inventoryCount: 0,
  firstCycle: 0,
  ...over,
});

describe('settleFarming with a loot filter (ticket 3.7)', () => {
  const filter = rules({ action: 'salvage', belowRarity: 'rare', wantedAffixes: ['crit-chance'] });

  it('never changes what drops: same seeds, same items, only their fate differs', () => {
    const plain = settleFarming(farm());
    const filtered = settleFarming(farm({ lootFilter: filter }));
    expect(plain.filtered).toBeUndefined();
    expect(filtered.filtered!.length).toBeGreaterThan(5);
    expect(filtered.items.length).toBeGreaterThan(0);
    // The union, in drop order (seeds are distinct per drop), is the plain drop list.
    const union = [...filtered.items, ...filtered.filtered!.map((f) => f.item)].sort(
      (a, b) => plain.items.indexOf(a) - plain.items.indexOf(b),
    );
    expect(new Set(union.map((i) => i.seed))).toEqual(new Set(plain.items.map((i) => i.seed)));
    expect(union.length).toBe(plain.items.length);
    for (const f of filtered.filtered!) {
      expect(plain.items.some((i) => JSON.stringify(i) === JSON.stringify(f.item))).toBe(true);
    }
    // Everything else is untouched; filter value is reported apart (it feeds no quest).
    expect({ ...filtered, items: [], filtered: undefined }).toEqual({ ...plain, items: [] });
  });

  it('with no rules, or rules that match nothing, gives exactly the plain settlement', () => {
    const plain = settleFarming(farm());
    expect(settleFarming(farm({ lootFilter: null }))).toEqual(plain);
    const inert = settleFarming(farm({ lootFilter: EMPTY_LOOT_FILTER }));
    expect(inert.filtered).toEqual([]);
    expect({ ...inert, filtered: undefined }).toEqual(plain);
  });

  it('is split-invariant: settling every few seconds gives the one-window result', () => {
    const run = (stepMs: number, held: number) => {
      const total = HOUR;
      let character: SettleFarmingInput['character'] = farm().character;
      let carry = 0;
      let firstCycle = 0;
      let inventoryCount = held;
      let professions: SettleFarmingInput['professions'] = undefined;
      const out = { items: [] as number[], filtered: [] as number[], salvaged: [] as number[] };
      let gold = 0;
      for (let t = 0; t < total; t += stepMs) {
        const s = settleFarming(
          farm({
            character,
            firstCycle,
            inventoryCount,
            durationMs: carry + Math.min(stepMs, total - t),
            lootFilter: filter,
            ...(professions ? { professions } : {}),
          }),
        );
        carry = s.unusedMs;
        firstCycle += s.encounters;
        inventoryCount += s.items.length;
        professions = s.professions;
        character = { classId: 'hunter', level: s.level, xp: s.xp, health: s.health };
        out.items.push(...s.items.map((i) => i.seed));
        out.filtered.push(...s.filtered!.map((f) => f.item.seed));
        out.salvaged.push(...s.salvaged.map((i) => i.seed));
        gold += s.goldLooted + s.goldSalvaged + filteredTotals(s.filtered).gold;
      }
      return { ...out, gold, firstCycle, carry };
    };
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    for (const held of [0, cap - 4, cap + 3]) {
      const once = run(HOUR, held);
      expect(once.filtered.length).toBeGreaterThan(0);
      for (const step of [3_000, 60_000]) expect(run(step, held)).toEqual(once);
    }
  });

  it('keeps valuable drops over capacity, split-invariantly (ticket B.2)', () => {
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    const base = (seed: string): SettleFarmingInput =>
      farm({
        character: { classId: 'warrior', level: 20, xp: 0 },
        areaId: 'sunkenAbbey',
        seed,
        durationMs: 6 * HOUR,
        inventoryCount: cap - 1,
      });
    let seed = '';
    let once: ReturnType<typeof settleFarming> | undefined;
    for (let i = 0; i < 20; i++) {
      const s = settleFarming(base(`over-cap:${i}`));
      if (s.overCapacity.length > 0) {
        seed = `over-cap:${i}`;
        once = s;
        break;
      }
    }
    expect(once).toBeDefined();
    expect(once!.overCapacity.every(isValuableDrop)).toBe(true);
    expect(once!.salvaged.some(isValuableDrop)).toBe(false);
    expect(once!.items.length).toBe(1 + once!.overCapacity.length);
    // Settling every 20 minutes (the pack goes over capacity mid-way) gives the same fates.
    let character: SettleFarmingInput['character'] = base(seed).character;
    let carry = 0;
    let firstCycle = 0;
    let inventoryCount = cap - 1;
    let professions: SettleFarmingInput['professions'] = undefined;
    const kept: number[] = [];
    const over: number[] = [];
    const salvaged: number[] = [];
    for (let t = 0; t < 6 * HOUR; t += HOUR / 3) {
      const s = settleFarming({
        ...base(seed),
        character,
        firstCycle,
        inventoryCount,
        durationMs: carry + HOUR / 3,
        ...(professions ? { professions } : {}),
      });
      carry = s.unusedMs;
      firstCycle += s.encounters;
      inventoryCount += s.items.length;
      professions = s.professions;
      character = { classId: 'warrior', level: s.level, xp: s.xp, health: s.health };
      kept.push(...s.items.map((i) => i.seed));
      over.push(...s.overCapacity.map((i) => i.seed));
      salvaged.push(...s.salvaged.map((i) => i.seed));
    }
    expect(kept).toEqual(once!.items.map((i) => i.seed));
    expect(over).toEqual(once!.overCapacity.map((i) => i.seed));
    expect(salvaged).toEqual(once!.salvaged.map((i) => i.seed));
  });

  it('keeps protected drops even under the harshest rules', () => {
    // A late-game window long enough to drop a Legendary or better.
    let found = 0;
    for (let i = 0; i < 6 && found === 0; i++) {
      const s = settleFarming(
        farm({
          character: { classId: 'warrior', level: 20, xp: 0 },
          areaId: 'sunkenAbbey',
          seed: `filter-protect:${i}`,
          durationMs: 3 * HOUR,
          lootFilter: harshest,
        }),
      );
      for (const f of s.filtered!) expect(lootFilterCategories(f.item)).toEqual([]);
      found += s.items.filter((x) => lootFilterCategories(x).length > 0).length;
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('crypt runs with a loot filter (ticket 3.7)', () => {
  it('handles drops at the claim without changing the run', () => {
    const base = {
      dungeonId: 'namelessCrypt' as const,
      character: { classId: 'warrior' as const, level: 16, xp: 0 },
      seed: 'filter-crypt',
      bossLootEligible: true,
      inventoryCount: 0,
    };
    for (const tier of [1, 2, 3] as const) {
      const plain = simulateDungeonRun({ ...base, tier });
      const r = simulateDungeonRun({ ...base, tier, lootFilter: rules({ belowRarity: 'epic' }) });
      expect(plain.filtered).toBeUndefined();
      const { items, filtered, ...rest } = r;
      const { items: plainItems, ...plainRest } = plain;
      expect(rest).toEqual(plainRest);
      expect(items.length + filtered!.length).toBe(plainItems.length);
      expect(simulateDungeonRun({ ...base, tier, lootFilter: null })).toEqual(plain);
    }
  });
});
