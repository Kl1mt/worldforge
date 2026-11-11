import { describe, expect, it } from 'vitest';
import {
  AFFIXES,
  CLASS_IDS,
  awakenItem,
  createRng,
  generateItem,
  getArea,
  getItemBase,
  getLootTable,
  merchantStock,
  salvageYield,
  settleFarming,
  upgradePathCost,
  xpToNextLevel,
  type AreaId,
  type ClassId,
  type EquippedItem,
  type GeneratedItem,
  type MaterialId,
} from '../index.js';
import { kit, legendaryKit, upgraded } from './kits.js';

/**
 * Ticket 8.1: the Pale Marches (the Hollow Reach, levels 40–46) against **today's best gear**: the
 * Cinder Depths' Legendaries (item level 39, tier 4) and the Heroic crypt's (37), +10, plain and
 * awakened. A level-40 hero who slew the Forge Tyrant moves on without new drops, farms with no
 * deaths and earns more than in the Depths; the Marches' own tier-5 drops are worth chasing; older
 * drops keep their salvage and Forge value. Game-core only, fixed seeds: each number is the same in
 * every run. Numbers and the dev tool: docs/COMBAT.md "The Hollow Reach", tools/balance/pale-marches.ts.
 */
const HOUR = 3_600_000;
const SEEDS = ['pm-a', 'pm-b', 'pm-c'];
const SLOW = { timeout: 120_000 };

interface FarmStats {
  deathsPerHour: number;
  killsPerMin: number;
  xpPerHour: number;
  goldPerHour: number;
  damageShare: number;
  materialsPerHour: Partial<Record<MaterialId, number>>;
}

const memo = new Map<string, FarmStats>();
function farm(
  c: ClassId,
  level: number,
  areaId: AreaId,
  name: string,
  items: EquippedItem[],
): FarmStats {
  const key = `${c}:${level}:${areaId}:${name}`;
  const hit = memo.get(key);
  if (hit) return hit;
  let deaths = 0,
    kills = 0,
    xp = 0,
    gold = 0,
    share = 0,
    encounters = 0;
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const seed of SEEDS) {
    const r = settleFarming({
      character: { classId: c, level, xp: 0 },
      equipment: items,
      areaId,
      seed,
      firstCycle: 0,
      durationMs: HOUR,
      inventoryCount: 0,
    });
    deaths += r.deaths;
    kills += r.kills;
    xp += r.xpGained;
    gold += r.goldLooted;
    share += r.damageTaken / r.maxHealth;
    encounters += r.encounters;
    for (const [id, n] of Object.entries(r.materials) as [MaterialId, number][])
      materials[id] = (materials[id] ?? 0) + n / SEEDS.length;
  }
  const s = {
    deathsPerHour: deaths / SEEDS.length,
    killsPerMin: kills / (SEEDS.length * 60),
    xpPerHour: xp / SEEDS.length,
    goldPerHour: gold / SEEDS.length,
    damageShare: share / encounters,
    materialsPerHour: materials,
  };
  memo.set(key, s);
  return s;
}

const awaken = (items: GeneratedItem[]): EquippedItem[] =>
  items.map((item) => {
    const r = awakenItem(item);
    return r.ok ? r.item : item;
  });

/** Today's best gear (before 8.1): tier-4 Legendaries with effects, +10. */
const TODAY: Record<string, (c: ClassId) => EquippedItem[]> = {
  'Depths Legendaries +10': (c) => upgraded(legendaryKit(c, 39), 10),
  'Depths Legendaries +10, awakened': (c) => awaken(upgraded(legendaryKit(c, 39), 10)),
  'Heroic Legendaries +10': (c) => upgraded(legendaryKit(c, 37), 10),
};
const KIT_SAMPLES = 4;
/**
 * A plain Legendary kit (no effect) of the best tier at `itemLevel`, one of several samples: a
 * single kit's affix rolls (attack speed above all) can outweigh a tier step, so kits are compared
 * as a mean over samples.
 */
function sampleKit(c: ClassId, itemLevel: number, sample: number): GeneratedItem[] {
  const rng = createRng(`pm-sample:${c}:${itemLevel}:${sample}`);
  return kit(c, itemLevel, 'legendary').map((item) =>
    generateItem({
      seed: rng.int(0, 2 ** 31),
      itemLevel,
      baseId: item.baseId,
      rarityId: 'legendary',
    })!,
  );
}

const marches = getArea('paleMarches');
const LEVELS = [marches.minLevel, marches.minLevel + 3, marches.maxLevel];

describe('the Pale Marches (ticket 8.1)', () => {
  it('today’s best gear farms it at every level: no deaths, idle-paced kills', SLOW, () => {
    for (const [name, make] of Object.entries(TODAY)) {
      for (const c of CLASS_IDS) {
        const items = make(c);
        for (const level of LEVELS) {
          const s = farm(c, level, 'paleMarches', name, items);
          const label = `${name} ${c} L${level}`;
          // Measured 0 deaths at 40 and 43, at most 0.3 an hour at 46 (docs/COMBAT.md).
          expect(s.deathsPerHour, label).toBeLessThanOrEqual(level === 40 ? 0 : 1);
          expect(s.damageShare, label).toBeLessThan(0.21);
          expect(s.killsPerMin, label).toBeGreaterThan(6);
          expect(s.killsPerMin, label).toBeLessThan(13);
          expect(s.materialsPerHour.ironOre ?? 0, label).toBeLessThanOrEqual(100);
          expect(s.materialsPerHour.soulShard ?? 0, label).toBeLessThanOrEqual(45);
        }
      }
    }
  });

  it(
    'pays more XP and gold an hour than the Depths’ top with the same gear: a step up',
    SLOW,
    () => {
      for (const [name, make] of Object.entries(TODAY)) {
        for (const c of CLASS_IDS) {
          const items = make(c);
          const depths = farm(c, 40, 'cinderDepths', name, items);
          const entry = farm(c, 40, 'paleMarches', name, items);
          const label = `${name} ${c}`;
          // Measured: XP × 1.07–1.14, gold × 1.12–1.22, pace 0.86–0.92, damage share × 1.19–1.34.
          expect(entry.xpPerHour / depths.xpPerHour, label).toBeGreaterThan(1.03);
          expect(entry.goldPerHour / depths.goldPerHour, label).toBeGreaterThan(1.05);
          expect(entry.goldPerHour, label).toBeLessThan(7_000);
          const pace = entry.killsPerMin / depths.killsPerMin;
          expect(pace, label).toBeGreaterThan(0.75);
          expect(pace, label).toBeLessThan(0.96);
          expect(entry.damageShare, label).toBeGreaterThan(depths.damageShare * 1.1);
        }
      }
    },
  );

  it('its own tier-5 drops are worth chasing; the Depths’ rares fall here', SLOW, () => {
    for (const c of CLASS_IDS) {
      let own = 0,
        depths = 0;
      for (let k = 0; k < KIT_SAMPLES; k++) {
        const o = farm(c, 46, 'paleMarches', `own45+5:${k}`, upgraded(sampleKit(c, 45, k), 5));
        expect(o.deathsPerHour, `${c} own kit ${k}`).toBeLessThanOrEqual(1);
        own += o.killsPerMin / KIT_SAMPLES;
        depths +=
          farm(c, 46, 'paleMarches', `depths39+5:${k}`, upgraded(sampleKit(c, 39, k), 5))
            .killsPerMin / KIT_SAMPLES;
      }
      // Measured 1.10–1.32 (a mean over four kits; one kit's affix luck can outweigh the step).
      expect(own / depths, c).toBeGreaterThan(1.04);
      expect(own / depths, c).toBeLessThan(1.45);
      const rares = farm(c, 40, 'paleMarches', 'rares39+5', upgraded(kit(c, 39, 'rare'), 5));
      expect(rares.deathsPerHour, c).toBeGreaterThan(20);
    }
  });

  it('drops tier-5 bases at item levels 41–47 and tier-6 affixes only from 42', () => {
    const table = getLootTable(marches.lootTableId);
    expect(table.itemLevel).toEqual({ min: 41, max: 47 });
    expect(table.entries).toHaveLength(10);
    for (const e of table.entries) expect(getItemBase(e.baseId).tier, e.baseId).toBe(5);
    const maxTier = (itemLevel: number) => {
      const rng = createRng(`tier6:${itemLevel}`);
      let best = 0;
      for (let i = 0; i < 400; i++) {
        const item = generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel,
          lootTable: table,
          rarityId: 'mythic',
          classId: 'warlock',
        })!;
        for (const a of item.affixes) best = Math.max(best, a.tier);
      }
      return best;
    };
    expect(maxTier(41)).toBe(5);
    expect(maxTier(43)).toBe(6);
    // Every tier-5 base beats its tier-4 counterpart at the same item level by about a tenth.
    const t4 = ['cinderforged-blade', 'emberheart-scepter', 'slagbone-bow', 'obsidian-bulwark'];
    const t5 = [
      'hollowsteel-greatblade',
      'pale-choir-stave',
      'reachstalker-longbow',
      'hollow-aegis',
    ];
    for (const [i, id] of t5.entries()) {
      const a = getItemBase(id).stats[0]!;
      const b = getItemBase(t4[i]!).stats[0]!;
      const at = (x: typeof a) => x.base + x.perLevel * 40;
      expect(at(a) / at(b), id).toBeGreaterThan(1.07);
      expect(at(a) / at(b), id).toBeLessThan(1.15);
    }
    expect(AFFIXES.some((a) => a.tiers.some((t) => t.tier === 6))).toBe(true);
  });

  it('older drops keep their salvage and Forge value', () => {
    // The Pass's, the Verge's and the Depths' drops salvage to the ore the Marches yield, and
    // their whole +10 Forge path prices in materials the Marches drop (no new material).
    for (const c of CLASS_IDS) {
      for (const item of [
        ...kit(c, 27, 'legendary'),
        ...kit(c, 33, 'legendary'),
        ...kit(c, 39, 'legendary'),
      ]) {
        const y = salvageYield(item);
        expect(y.gold, item.baseId).toBeGreaterThan(0);
        expect(y.materials.ironOre ?? 0, item.baseId).toBeGreaterThan(0);
        const path = upgradePathCost(item, 0, 10);
        for (const m of Object.keys(path.worst.materials))
          expect(marches.materials as readonly string[], `${item.baseId} ${m}`).toContain(m);
      }
      // Tier 5 asks for more of the same ore: its salvage yields more than tier 4's.
      const t5 = kit(c, 45, 'legendary').find((i) => getItemBase(i.baseId).slot === 'chest')!;
      const t4 = kit(c, 39, 'legendary').find((i) => getItemBase(i.baseId).slot === 'chest')!;
      expect(salvageYield(t5).materials.ironOre!).toBeGreaterThan(
        salvageYield(t4).materials.ironOre!,
      );
    }
  });

  it('the merchant always stocks its offers here, at item levels a base exists for (F.7)', () => {
    for (const c of CLASS_IDS) {
      for (let d = 1; d <= 30; d++) {
        const day = `2026-12-${String(d).padStart(2, '0')}`;
        const stock = merchantStock({
          characterId: `pm-merchant-${c}-${d}`,
          classId: c,
          day,
          areaIds: ['paleMarches'],
        });
        expect(stock, `${c} ${day}`).toHaveLength(2);
        for (const offer of stock) {
          expect(getItemBase(offer.item.baseId).tier).toBe(5);
          expect(offer.item.itemLevel).toBeGreaterThanOrEqual(41);
          expect(offer.item.itemLevel).toBeLessThanOrEqual(marches.maxLevel);
        }
      }
    }
  });

  it('moves the XP soft cap to about 54: no constant changed, the content moved it', SLOW, () => {
    for (const c of CLASS_IDS) {
      const items = upgraded(legendaryKit(c, 39), 10);
      const hours = (level: number) =>
        xpToNextLevel(level) /
        Math.max(
          farm(c, level, 'cinderDepths', 'xp', items).xpPerHour,
          farm(c, level, 'paleMarches', 'xp', items).xpPerHour,
        );
      // Measured (Depths Legendaries +10): 3–4 h a level at 40, 4–6 h at 48, 50–68 h from 54.
      expect(hours(46), c).toBeLessThan(8);
      expect(hours(48), c).toBeLessThan(8);
      expect(hours(54), c).toBeGreaterThan(2.2 * hours(50));
      expect(hours(54), c).toBeGreaterThan(40);
    }
  });
});
