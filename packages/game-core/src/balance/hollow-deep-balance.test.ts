import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  awakenItem,
  createRng,
  generateItem,
  getArea,
  getDungeonTier,
  getItemBase,
  getLootTable,
  merchantStock,
  settleFarming,
  simulateDungeonRun,
  xpToNextLevel,
  type AreaId,
  type BossModifierId,
  type ClassId,
  type EquippedItem,
  type GeneratedItem,
  type MaterialId,
} from '../index.js';
import { legendaryKit, legendarySample, upgraded } from './kits.js';

/**
 * Ticket 8.2: the Hollow Deep (the Hollow Reach, levels 46–52) and the Hollow Sovereign against
 * **the best Pale Marches gear**: the Marches' tier-5 Legendaries (item level 47, its top, and 45),
 * +5 and +10, plain and awakened. A level-46 hero moves on without new drops, farms with no deaths
 * and earns more than in the Marches; the Sovereign is beatable from about 48 in good Marches gear
 * but not trivially, and the Deep's own drops win it outright. Game-core only, fixed seeds: each
 * number is the same in every run. Numbers and the dev tool: docs/COMBAT.md "The Hollow Deep",
 * docs/DUNGEONS.md "The Hollow Throne", tools/balance/hollow-deep.ts.
 */
const HOUR = 3_600_000;
const SEEDS = ['hd-a', 'hd-b', 'hd-c'];
const SLOW = { timeout: 180_000 };

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

/** The best Marches gear: tier-5 Legendaries with effects at the Marches' top item level. */
const MARCHES_BEST: Record<string, (c: ClassId) => EquippedItem[]> = {
  'Marches Legendaries +10': (c) => upgraded(legendaryKit(c, 47), 10),
  'Marches Legendaries +10, awakened': (c) => awaken(upgraded(legendaryKit(c, 47), 10)),
};

const deep = getArea('hollowDeep');
const LEVELS = [deep.minLevel, deep.minLevel + 3, deep.maxLevel];

/** Boss gear by tier, as kit samples (a single kit's luck with its effects can outweigh a step). */
const KITS = 4;
const RUNS = 12;
const BOSS_GEAR: Record<string, (c: ClassId, k: number) => EquippedItem[]> = {
  'Depths +10': (c, k) => upgraded(legendarySample(c, 39, k), 10),
  'Marches +0': (c, k) => legendarySample(c, 47, k),
  'Marches +5': (c, k) => upgraded(legendarySample(c, 47, k), 5),
  'Marches 45 +5': (c, k) => upgraded(legendarySample(c, 45, k), 5),
  'Marches +10': (c, k) => upgraded(legendarySample(c, 47, k), 10),
  'Deep +10': (c, k) => upgraded(legendarySample(c, 53, k), 10),
};
const bossMemo = new Map<string, number>();
/** Win rate over the classes, kit samples and fixed run seeds (one tier, no hoard). */
function sovereign(
  gear: string,
  level: number,
  mod: BossModifierId | null = null,
  classes: readonly ClassId[] = CLASS_IDS,
): number {
  const key = `${gear}:${level}:${mod}:${classes.join()}`;
  const hit = bossMemo.get(key);
  if (hit !== undefined) return hit;
  let wins = 0,
    n = 0;
  for (const c of classes) {
    for (let k = 0; k < KITS; k++) {
      const equipment = BOSS_GEAR[gear]!(c, k);
      for (let i = 0; i < RUNS; i++) {
        const r = simulateDungeonRun({
          dungeonId: 'hollowThrone',
          tier: 1,
          character: { classId: c, level, xp: 0 },
          equipment,
          seed: `sov:${c}:${level}:${i}`,
          bossLootEligible: false,
          inventoryCount: 0,
          bossModifier: mod,
        });
        n++;
        if (r.bossDefeated) wins++;
      }
    }
  }
  bossMemo.set(key, wins / n);
  return wins / n;
}

describe('the Hollow Deep (ticket 8.2)', () => {
  it('the best Marches gear farms it at every level: no deaths, idle-paced kills', SLOW, () => {
    for (const [name, make] of Object.entries(MARCHES_BEST)) {
      for (const c of CLASS_IDS) {
        const items = make(c);
        for (const level of LEVELS) {
          const s = farm(c, level, 'hollowDeep', name, items);
          const label = `${name} ${c} L${level}`;
          // Measured 0 deaths at 46, 49 and 52 (docs/COMBAT.md).
          expect(s.deathsPerHour, label).toBe(0);
          expect(s.damageShare, label).toBeLessThan(0.2);
          expect(s.killsPerMin, label).toBeGreaterThan(6);
          expect(s.killsPerMin, label).toBeLessThan(11);
          expect(s.materialsPerHour.ironOre ?? 0, label).toBeLessThanOrEqual(100);
          expect(s.materialsPerHour.soulShard ?? 0, label).toBeLessThanOrEqual(45);
        }
      }
    }
  });

  it('pays more XP and gold an hour than the Marches’ top with the same gear', SLOW, () => {
    for (const [name, make] of Object.entries(MARCHES_BEST)) {
      for (const c of CLASS_IDS) {
        const items = make(c);
        const marches = farm(c, 46, 'paleMarches', name, items);
        const entry = farm(c, 46, 'hollowDeep', name, items);
        const label = `${name} ${c}`;
        // Measured: XP × 1.06–1.11, gold × 1.09–1.13, pace 0.90–0.95.
        expect(entry.xpPerHour / marches.xpPerHour, label).toBeGreaterThan(1.03);
        expect(entry.goldPerHour / marches.goldPerHour, label).toBeGreaterThan(1.05);
        expect(entry.goldPerHour, label).toBeLessThan(9_000);
        const pace = entry.killsPerMin / marches.killsPerMin;
        expect(pace, label).toBeGreaterThan(0.8);
        expect(pace, label).toBeLessThan(0.98);
        expect(entry.damageShare, label).toBeGreaterThan(marches.damageShare);
      }
    }
  });

  it('drops tier-5 bases at item levels 47–53, the hoard at 51–53', () => {
    const table = getLootTable(deep.lootTableId);
    expect(table.itemLevel).toEqual({ min: 47, max: 53 });
    expect(table.entries).toHaveLength(10);
    for (const e of table.entries) expect(getItemBase(e.baseId).tier, e.baseId).toBe(5);
    expect(table.entries).toEqual(getLootTable('paleMarches').entries);
    const hoard = getLootTable(getDungeonTier('hollowThrone', 1).bossLoot.lootTableId);
    expect(hoard.itemLevel).toEqual({ min: 51, max: 53 });
    expect(hoard.focus?.slots).toEqual(['weapon', 'ring', 'neck']);
    // No new affix tier: tier 6 is still the top at the Deep's top item level.
    const rng = createRng('hd-affix');
    let best = 0;
    for (let i = 0; i < 300; i++) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 31),
        itemLevel: 53,
        lootTable: table,
        rarityId: 'mythic',
        classId: 'warlock',
      })!;
      for (const a of item.affixes) best = Math.max(best, a.tier);
    }
    expect(best).toBe(6);
  });

  it('the merchant always stocks its offers here, at item levels a base exists for (F.7)', () => {
    for (const c of CLASS_IDS) {
      for (let d = 1; d <= 30; d++) {
        const day = `2026-12-${String(d).padStart(2, '0')}`;
        const stock = merchantStock({
          characterId: `hd-merchant-${c}-${d}`,
          classId: c,
          day,
          areaIds: ['hollowDeep'],
        });
        expect(stock, `${c} ${day}`).toHaveLength(2);
        for (const offer of stock) {
          expect(getItemBase(offer.item.baseId).tier).toBe(5);
          expect(offer.item.itemLevel).toBeGreaterThanOrEqual(deep.minLevel);
          expect(offer.item.itemLevel).toBeLessThanOrEqual(deep.maxLevel);
        }
      }
    }
    // Every level the merchant can roll here has a base (tier 5 starts at 41).
    for (let level = deep.minLevel; level <= deep.maxLevel; level++) {
      expect(
        getLootTable(deep.lootTableId).entries.some(
          (e) => getItemBase(e.baseId).minItemLevel <= level,
        ),
        `${level}`,
      ).toBe(true);
    }
  });

  it('moves the XP soft cap to about 57: no constant changed, the content moved it', SLOW, () => {
    for (const c of CLASS_IDS) {
      const items = upgraded(legendaryKit(c, 47), 10);
      const hours = (level: number, areas: AreaId[]) =>
        xpToNextLevel(level) /
        Math.max(...areas.map((a) => farm(c, level, a, 'xp', items).xpPerHour));
      // Measured (Marches Legendaries +10): before the Deep 7–8 h at 50 and 47–64 h from 54;
      // with it 4–5 h at 50, 5–6 h at 54, 12–16 h from 58.
      expect(hours(54, ['paleMarches']), c).toBeGreaterThan(40);
      expect(hours(54, ['paleMarches', 'hollowDeep']), c).toBeLessThan(8);
      expect(hours(56, ['paleMarches', 'hollowDeep']), c).toBeLessThan(10);
      expect(hours(58, ['paleMarches', 'hollowDeep']), c).toBeGreaterThan(
        1.8 * hours(54, ['paleMarches', 'hollowDeep']),
      );
    }
  });
});

describe('the Hollow Sovereign (ticket 8.2)', () => {
  it('is beatable around 48–50 in good Marches gear, but not trivially', SLOW, () => {
    const table = Object.keys(BOSS_GEAR)
      .map((g) => `${g}: 48 ${sovereign(g, 48).toFixed(2)} · 50 ${sovereign(g, 50).toFixed(2)}`)
      .join('\n');
    for (const level of [48, 50]) {
      // Measured (4 classes × 4 kits × 12 runs): +0 ≈ 0.10, +5 ≈ 0.40, at item level 45 +5 ≈ 0.55,
      // +10 ≈ 0.85, the Deep's own Legendaries +10 ≈ 1.0, the Depths' +10 ≈ 0.40.
      expect(sovereign('Marches +0', level), table).toBeLessThan(0.25);
      expect(sovereign('Marches +5', level), table).toBeGreaterThan(0.25);
      expect(sovereign('Marches +5', level), table).toBeLessThan(0.65);
      expect(sovereign('Marches 45 +5', level), table).toBeGreaterThan(0.35);
      expect(sovereign('Marches 45 +5', level), table).toBeLessThan(0.75);
      expect(sovereign('Marches +10', level), table).toBeGreaterThan(0.7);
      expect(sovereign('Marches +10', level), table).toBeLessThan(0.95);
      expect(sovereign('Deep +10', level), table).toBeGreaterThan(0.95);
      // The Depths' best stays a long shot: the region's own gear is the way.
      expect(sovereign('Depths +10', level), table).toBeLessThan(sovereign('Marches +10', level));
      // More upgrades, better odds.
      expect(sovereign('Marches +10', level), table).toBeGreaterThan(
        sovereign('Marches +5', level),
      );
      expect(sovereign('Marches +5', level), table).toBeGreaterThan(sovereign('Marches +0', level));
    }
    // Every class can win him in Marches +10 (no class shut out).
    for (const c of CLASS_IDS) {
      expect(sovereign('Marches +10', 50, null, [c]), `${c}\n${table}`).toBeGreaterThan(0.5);
    }
  });

  it('every weekly modifier costs something, none walls the Marches’ +10 (6.3)', SLOW, () => {
    const base = sovereign('Marches +10', 50);
    const mods: BossModifierId[] = ['burning', 'warded', 'frenzied', 'unyielding', 'relentless'];
    for (const m of mods) {
      const r = sovereign('Marches +10', 50, m);
      // Measured 0.77–0.81 against 0.84 without.
      expect(r, m).toBeLessThanOrEqual(base);
      expect(r, m).toBeGreaterThan(0.6);
    }
  });
});
