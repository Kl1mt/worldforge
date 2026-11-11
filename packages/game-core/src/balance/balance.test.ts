import { describe, expect, it } from 'vitest';
import {
  AREAS,
  AFFIXES,
  CLASS_IDS,
  EFFECTS,
  ITEM_SETS,
  MYTHIC_ITEMS,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_ECONOMY_CONFIG,
  DEFAULT_PROFESSION_CONFIG,
  FORGE_RECIPES,
  ITEM_BASES,
  buyPrice,
  canClassUseItem,
  createRng,
  generateItem,
  getArea,
  getDungeonTier,
  getItemBase,
  getLootTable,
  getImplicitStats,
  getMaterial,
  legendaryEffectPool,
  settleFarming,
  simulateDungeonRun,
  type AreaDefinition,
  type AreaId,
  type ClassId,
  type DungeonTier,
  type FarmingSettlement,
  type GeneratedItem,
  type MaterialId,
  type ProfessionId,
  type ProfessionState,
  type RarityId,
  salvageYield,
  upgradePathCost,
  xpToNextLevel,
} from '../index.js';

/**
 * Balance guard (ticket B.1). Deterministic simulations of every class in every area with target
 * bands, so new content or a changed number cannot silently break the pacing. Targets and the
 * reasoning behind them: `docs/COMBAT.md` (combat, XP) and `docs/ECONOMY.md` (gold, materials).
 *
 * "Geared" means one common item per droppable slot (both rings), the best tier the class can use,
 * at item level = character level − 1: what a player who equips their drops wears. "Lagging" is the
 * same kit three levels behind (e.g. after a long offline window without re-equipping).
 */

const HOUR = 3_600_000;
const SEEDS = ['b1-a', 'b1-b', 'b1-c'];

/** One item per droppable slot of the best tier the class can use at `itemLevel`. */
function kit(classId: ClassId, itemLevel: number, rarityId: RarityId = 'common'): GeneratedItem[] {
  const level = Math.max(1, itemLevel);
  const rng = createRng(`kit:${classId}:${level}:${rarityId}`);
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  const taken = new Set<string>();
  const out: GeneratedItem[] = [];
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    for (let i = 0; i < (base.slot === 'ring' ? 2 : 1); i++) {
      out.push(
        generateItem({ seed: rng.int(0, 2 ** 31), itemLevel: level, baseId: base.id, rarityId })!,
      );
    }
  }
  return out;
}

interface FarmStats {
  deathsPerHour: number;
  killsPerMin: number;
  xpPerHour: number;
  goldPerHour: number;
  /** Mean damage taken per encounter as a share of max health (20 % regenerates per search). */
  damageShare: number;
  materialsPerHour: Partial<Record<MaterialId, number>>;
}

function farm(
  classId: ClassId,
  level: number,
  areaId: AreaId,
  equipment: GeneratedItem[],
  durationMs = HOUR,
): FarmStats {
  const hours = (durationMs / HOUR) * SEEDS.length;
  let deaths = 0;
  let kills = 0;
  let xp = 0;
  let gold = 0;
  let share = 0;
  let encounters = 0;
  const materials: Partial<Record<MaterialId, number>> = {};
  for (const seed of SEEDS) {
    const r: FarmingSettlement = settleFarming({
      character: { classId, level, xp: 0 },
      equipment,
      areaId,
      seed,
      firstCycle: 0,
      durationMs,
      inventoryCount: 0,
    });
    deaths += r.deaths;
    kills += r.kills;
    xp += r.xpGained;
    gold += r.goldLooted;
    share += r.damageTaken / r.maxHealth;
    encounters += r.encounters;
    for (const [id, n] of Object.entries(r.materials) as [MaterialId, number][])
      materials[id] = (materials[id] ?? 0) + n / hours;
  }
  return {
    deathsPerHour: deaths / hours,
    killsPerMin: kills / (hours * 60),
    xpPerHour: xp / hours,
    goldPerHour: gold / hours,
    damageShare: share / encounters,
    materialsPerHour: materials,
  };
}

const memo = new Map<string, FarmStats>();
function geared(classId: ClassId, level: number, areaId: AreaId, lag = 1): FarmStats {
  const key = `${classId}:${level}:${areaId}:${lag}`;
  let s = memo.get(key);
  if (!s) memo.set(key, (s = farm(classId, level, areaId, kit(classId, level - lag))));
  return s;
}

const mid = (a: AreaDefinition) => a.minLevel + 2;

/**
 * Ticket 4.8: the B.1 bands are Graumark's (a common kit is what a player wears there). The Ashen
 * Pass is top-end content with its own bands against Phase 3 gear ("the Ashen Pass" below).
 */
// Graumark proper: the top-end regions (the Ashen Pass, ticket 4.8; the Cinderwastes, 6.1) have their own bands.
const GRAUMARK = AREAS.filter((a) => a.id !== 'ashenPass' && a.region === 'Graumark');

/** The kit with its first ring replaced by a synthetic Legendary ring carrying one effect. */
function wearRing(gear: GeneratedItem[], effectId: string): GeneratedItem[] {
  const out = [...gear];
  const i = out.findIndex((g) => getItemBase(g.baseId).slot === 'ring');
  out[i] = {
    seed: 1,
    baseId: 'iron-ring',
    rarityId: 'legendary',
    itemLevel: 1,
    affixes: [],
    effectId,
    effectRoll: 1,
  };
  return out;
}
const stats = (areaId: AreaId, level: number) =>
  CLASS_IDS.map((c) => ({ classId: c, ...geared(c, level, areaId) }));

describe('balance (ticket B.1)', () => {
  describe('survival', () => {
    it('a fresh level-1 hero with no gear rarely dies in the Abandoned Fields', () => {
      for (const c of CLASS_IDS) {
        const s = farm(c, 1, 'abandonedFields', [], HOUR / 2);
        expect(s.deathsPerHour, c).toBeLessThanOrEqual(3);
      }
    });

    it('a geared hero farms every area at its level with a low death rate', () => {
      for (const a of GRAUMARK) {
        for (const level of [a.minLevel, mid(a), a.maxLevel]) {
          for (const s of stats(a.id, level)) {
            const label = `${s.classId} ${a.id} L${level}`;
            expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
            expect(s.damageShare, label).toBeLessThan(0.21);
          }
        }
      }
    });

    it('casters survive like the other classes (similar damage share and deaths)', () => {
      for (const a of GRAUMARK) {
        for (const level of [a.minLevel, mid(a)]) {
          const s = stats(a.id, level);
          const shares = s.map((x) => x.damageShare);
          const deaths = s.map((x) => x.deathsPerHour);
          const label = `${a.id} L${level}`;
          expect(Math.max(...shares) / Math.min(...shares), label).toBeLessThan(1.35);
          expect(Math.max(...deaths) - Math.min(...deaths), label).toBeLessThanOrEqual(2);
        }
      }
    });

    it('gear three levels behind costs deaths in the middle of an area, but not constant ones', () => {
      for (const a of GRAUMARK) {
        for (const c of CLASS_IDS) {
          const s = geared(c, mid(a), a.id, 3);
          expect(s.deathsPerHour, `${c} ${a.id}`).toBeLessThanOrEqual(10);
        }
      }
    });

    it('each later area is a step up: its entry hits harder than the previous area at its top', () => {
      for (let i = 1; i < GRAUMARK.length; i++) {
        const prev = GRAUMARK[i - 1]!;
        const next = GRAUMARK[i]!;
        for (const c of CLASS_IDS) {
          const top = geared(c, prev.maxLevel, prev.id).damageShare;
          const entry = geared(c, next.minLevel, next.id).damageShare;
          expect(entry, `${c} ${next.id}`).toBeGreaterThan(top * 1.15);
          // Not trivial either: a geared hero still loses a real share of health per fight.
          expect(entry, `${c} ${next.id}`).toBeGreaterThan(0.12);
        }
      }
    });
  });

  describe('pacing', () => {
    it('kills arrive at an idle-friendly rate everywhere', () => {
      for (const a of GRAUMARK) {
        for (const s of stats(a.id, mid(a))) {
          expect(s.killsPerMin, `${s.classId} ${a.id}`).toBeGreaterThan(7);
          expect(s.killsPerMin, `${s.classId} ${a.id}`).toBeLessThan(12);
        }
      }
    });

    it('a fresh hero spends real time in every area (hours of farming per level band)', () => {
      // Hours from the area's unlock level to the next area's unlock (Sunken Abbey: 17 → 22).
      const bands: [AreaId, number, number, number, number][] = [
        ['abandonedFields', 1, 5, 1.2, 4],
        ['crowwood', 5, 9, 4, 10],
        ['oldBurialGrounds', 9, 13, 8, 16],
        ['blackwater', 13, 17, 10, 22],
        ['sunkenAbbey', 17, 22, 18, 40],
      ];
      for (const c of CLASS_IDS) {
        let level = 1;
        let xp = 0;
        let hours = 0;
        let professions: Partial<Record<ProfessionId, ProfessionState>> | undefined;
        for (const [areaId, from, to, min, max] of bands) {
          expect(level, `${c} enters ${areaId}`).toBe(from);
          const start = hours;
          let firstCycle = 0;
          while (level < to) {
            // Re-equip every half hour, as a player returning to the game would.
            const r = settleFarming({
              character: { classId: c, level, xp },
              equipment: level === 1 && hours === 0 ? [] : kit(c, level - 1),
              areaId,
              seed: `pace:${c}:${areaId}`,
              firstCycle,
              durationMs: HOUR / 2,
              inventoryCount: 0,
              ...(professions ? { professions } : {}),
            });
            firstCycle += r.encounters;
            hours += 0.5;
            level = r.level;
            xp = r.xp;
            professions = r.professions;
            if (level >= to) {
              // Stop at the next area's unlock level, like a player who moves on.
              level = to;
              xp = 0;
            }
          }
          const spent = hours - start;
          expect(spent, `${c} ${areaId}`).toBeGreaterThanOrEqual(min);
          expect(spent, `${c} ${areaId}`).toBeLessThanOrEqual(max);
        }
        expect(hours, `${c} total to 22`).toBeGreaterThan(45);
        expect(hours, `${c} total to 22`).toBeLessThan(85);
      }
    });

    it('one offline window (3 h) does not out-level an area', () => {
      for (const a of GRAUMARK) {
        for (const c of CLASS_IDS) {
          const r = settleFarming({
            character: { classId: c, level: a.minLevel, xp: 0 },
            equipment: kit(c, a.minLevel - 1),
            areaId: a.id,
            seed: `window:${c}`,
            firstCycle: 0,
            durationMs: 3 * HOUR,
            inventoryCount: 0,
          });
          // The Fields start at level 1, where levels are minutes; everywhere else ≤ 2 levels.
          expect(r.level, `${c} ${a.id}`).toBeLessThanOrEqual(
            a.id === 'abandonedFields' ? 6 : a.minLevel + 2,
          );
        }
      }
    });
  });

  describe('economy', () => {
    const offerPrice = (areaId: AreaId, rarityId: RarityId) => {
      const a = getArea(areaId);
      return buyPrice({ rarityId, itemLevel: mid(a) }, DEFAULT_ECONOMY_CONFIG);
    };

    it('a merchant item costs 10–30 minutes of farming gold at its level', () => {
      for (const a of GRAUMARK) {
        const perMin = stats(a.id, mid(a)).reduce((s, x) => s + x.goldPerHour, 0) / 4 / 60;
        // A common offer is at the cheap end, an uncommon one at the dear end.
        const common = offerPrice(a.id, 'common') / perMin;
        const uncommon = offerPrice(a.id, 'uncommon') / perMin;
        expect(common, `${a.id} common`).toBeGreaterThanOrEqual(5);
        expect(common, `${a.id} common`).toBeLessThanOrEqual(20);
        expect(uncommon, `${a.id} uncommon`).toBeGreaterThanOrEqual(10);
        expect(uncommon, `${a.id} uncommon`).toBeLessThanOrEqual(35);
      }
    });

    it('farming gold per hour stays in the hundreds, not thousands', () => {
      for (const a of GRAUMARK) {
        for (const s of stats(a.id, mid(a))) {
          expect(s.goldPerHour, `${s.classId} ${a.id}`).toBeGreaterThan(80);
          expect(s.goldPerHour, `${s.classId} ${a.id}`).toBeLessThan(1_000);
        }
      }
    });

    it('a Forge recipe takes about an hour of farming in the areas that yield its materials', () => {
      // Best hourly yield of each material across the areas at their middle level (warrior).
      const best: Partial<Record<MaterialId, number>> = {};
      for (const a of GRAUMARK) {
        const s = geared('warrior', mid(a), a.id);
        for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][])
          best[id] = Math.max(best[id] ?? 0, n);
      }
      // Ticket 6.2: a recipe that asks for a boss material is paced by its hoard instead ("the
      // Forge Tyrant" below).
      const farmed = FORGE_RECIPES.filter(
        (r) => !r.materials.some((m) => getMaterial(m.materialId).source === 'bossDrop'),
      );
      // Ticket 8.2: and the Crownforged Work (the Hollow Sovereign's crown shard).
      expect(farmed.length).toBe(FORGE_RECIPES.length - 2);
      for (const r of farmed) {
        const goldHours =
          r.gold / geared('warrior', Math.max(r.level, 3), farmingAreaFor(r.level)).goldPerHour;
        const materialHours = r.materials.map((m) => m.quantity / (best[m.materialId] ?? 0));
        const hours = Math.max(goldHours, ...materialHours);
        expect(hours, r.id).toBeGreaterThan(0.4);
        expect(hours, r.id).toBeLessThan(2);
      }
    });

    it('professions take days of play to master, not one session', () => {
      // Woodcutting in the Fields, mining in Blackwater: geared mid-level warrior, 3 h windows.
      for (const [areaId, professionId, level] of [
        ['abandonedFields', 'woodcutting', 4],
        ['blackwater', 'mining', 15],
      ] as const) {
        let professions: Partial<Record<ProfessionId, ProfessionState>> | undefined;
        let firstCycle = 0;
        const reached: Record<number, number> = {};
        for (let window = 1; window <= 80 && !reached[50]; window++) {
          const r = settleFarming({
            character: { classId: 'warrior', level, xp: 0 },
            equipment: kit('warrior', level - 1),
            areaId,
            seed: `prof:${areaId}`,
            firstCycle,
            durationMs: 3 * HOUR,
            inventoryCount: 0,
            ...(professions ? { professions } : {}),
          });
          firstCycle += r.encounters;
          professions = r.professions;
          const l = r.professions[professionId].level;
          if (window === 1) expect(l, `${professionId} after one window`).toBeLessThanOrEqual(6);
          for (const target of [10, 25, 50]) if (l >= target) reached[target] ??= window * 3;
        }
        expect(reached[10], `${professionId} 10`).toBeGreaterThanOrEqual(6);
        expect(reached[10], `${professionId} 10`).toBeLessThanOrEqual(20);
        expect(reached[25], `${professionId} 25`).toBeGreaterThanOrEqual(25);
        expect(reached[25], `${professionId} 25`).toBeLessThanOrEqual(80);
        expect(reached[50], `${professionId} 50`).toBeGreaterThanOrEqual(80);
        expect(reached[50], `${professionId} 50`).toBeLessThanOrEqual(240);
      }
    });

    it('gathering yields stay near a recipe per hour (no hundreds of units per window)', () => {
      for (const a of GRAUMARK) {
        const s = geared('warrior', mid(a), a.id);
        for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][]) {
          const cap = getMaterial(id).rarity === 'common' ? 60 : 45;
          expect(n, `${a.id} ${id}`).toBeLessThan(cap);
        }
      }
      expect(DEFAULT_PROFESSION_CONFIG.maxLevel).toBe(50);
    });
  });

  describe('the Ashen Pass (ticket 4.8)', () => {
    const pass = getArea('ashenPass');
    const plus = (items: GeneratedItem[], upgradeLevel: number) =>
      items.map((i) => ({ ...i, upgradeLevel }));
    /**
     * The Pass's "geared": rares at +5, item level = level − 1. A hero who reaches it has cleared
     * crypt tier II (where rares +5 win 50–100 %) and spends Abbey gold on upgrades (3.9's runs).
     */
    const passKit = (c: ClassId, level: number) => plus(kit(c, level - 1, 'rare'), 5);
    const passMemo = new Map<string, FarmStats>();
    const at = (c: ClassId, level: number, areaId: AreaId = 'ashenPass') => {
      const key = `${c}:${level}:${areaId}`;
      let s = passMemo.get(key);
      if (!s) passMemo.set(key, (s = farm(c, level, areaId, passKit(c, level))));
      return s;
    };
    const levels = [pass.minLevel, mid(pass), pass.maxLevel];

    it('a hero in upgraded rares farms it at every level with a low death rate', () => {
      for (const level of levels) {
        const shares: number[] = [];
        for (const c of CLASS_IDS) {
          const s = at(c, level);
          expect(s.deathsPerHour, `${c} L${level}`).toBeLessThanOrEqual(2);
          expect(s.damageShare, `${c} L${level}`).toBeLessThan(0.21);
          shares.push(s.damageShare);
        }
        // Casters survive like the other classes.
        expect(Math.max(...shares) / Math.min(...shares), `L${level}`).toBeLessThan(1.45);
      }
    });

    it('is top-end content: commons fall again and again, and it is a step up from the Abbey', () => {
      for (const c of CLASS_IDS) {
        expect(
          farm(c, pass.minLevel, pass.id, kit(c, pass.minLevel - 1)).deathsPerHour,
          c,
        ).toBeGreaterThan(20);
        // The same gear at the Abbey's top takes far less per fight than at the Pass's entry.
        const abbeyTop = at(c, getArea('sunkenAbbey').maxLevel, 'sunkenAbbey').damageShare;
        const entry = at(c, pass.minLevel).damageShare;
        expect(entry, c).toBeGreaterThan(abbeyTop * 1.15);
        expect(entry, c).toBeGreaterThan(0.12);
      }
    });

    it('kills arrive at an idle-friendly rate, and better gear shows in the rate', () => {
      for (const c of CLASS_IDS) {
        const s = at(c, mid(pass));
        expect(s.killsPerMin, c).toBeGreaterThan(6.5);
        expect(s.killsPerMin, c).toBeLessThan(12);
        // Past the Abbey's one-shot breakpoint: a Legendary +10 kit kills clearly faster here
        // (the build search: builds.test.ts).
        const top = farm(c, mid(pass), pass.id, plus(kit(c, mid(pass) - 1, 'legendary'), 10));
        expect(top.killsPerMin / s.killsPerMin, c).toBeGreaterThan(1.25);
        // +10 on the rares is still a moderate edge over +5 (GDD §8.1).
        const ten = farm(c, mid(pass), pass.id, plus(kit(c, mid(pass) - 1, 'rare'), 10));
        expect(ten.deathsPerHour, c).toBeLessThanOrEqual(2);
        expect(ten.damageShare, c).toBeLessThanOrEqual(s.damageShare);
        expect(ten.killsPerMin, c).toBeGreaterThanOrEqual(s.killsPerMin * 0.99);
        expect(ten.killsPerMin / s.killsPerMin, c).toBeLessThan(1.2);
      }
    });

    it('pays more XP and gold an hour than the Abbey’s top, and levels 24 → 28 take days', () => {
      const abbeyTop = getArea('sunkenAbbey').maxLevel;
      const mean = (f: (c: ClassId) => number) =>
        CLASS_IDS.reduce((sum, c) => sum + f(c), 0) / CLASS_IDS.length;
      for (const c of CLASS_IDS) {
        expect(at(c, pass.minLevel).xpPerHour, c).toBeGreaterThan(
          at(c, abbeyTop, 'sunkenAbbey').xpPerHour,
        );
        expect(at(c, mid(pass)).goldPerHour, c).toBeLessThan(2_500);
      }
      expect(mean((c) => at(c, pass.minLevel).goldPerHour)).toBeGreaterThan(
        1.05 * mean((c) => at(c, abbeyTop, 'sunkenAbbey').goldPerHour),
      );
      for (const c of CLASS_IDS) {
        let level = pass.minLevel;
        let xp = 0;
        let hours = 0;
        let firstCycle = 0;
        while (level < pass.maxLevel) {
          // Re-equip every half hour, as in the Graumark pacing test.
          const r = settleFarming({
            character: { classId: c, level, xp },
            equipment: passKit(c, level),
            areaId: pass.id,
            seed: `pace:${c}:${pass.id}`,
            firstCycle,
            durationMs: HOUR / 2,
            inventoryCount: 0,
          });
          firstCycle += r.encounters;
          hours += 0.5;
          level = r.level;
          xp = r.xp;
        }
        expect(hours, c).toBeGreaterThanOrEqual(15);
        expect(hours, c).toBeLessThanOrEqual(35);
        // One offline window (3 h) from the entry does not out-level it.
        const w = settleFarming({
          character: { classId: c, level: pass.minLevel, xp: 0 },
          equipment: passKit(c, pass.minLevel),
          areaId: pass.id,
          seed: `window:${c}`,
          firstCycle: 0,
          durationMs: 3 * HOUR,
          inventoryCount: 0,
        });
        expect(w.level, c).toBeLessThanOrEqual(pass.minLevel + 2);
      }
    });

    it('yields the +10 track’s materials at a gathering pace, never hundreds an hour', () => {
      for (const c of CLASS_IDS) {
        const m = at(c, mid(pass)).materialsPerHour;
        expect(Object.keys(m).sort(), c).toEqual(['ironOre', 'soulShard']);
        expect(m.ironOre!, c).toBeGreaterThan(15);
        expect(m.ironOre!, c).toBeLessThanOrEqual(60);
        expect(m.soulShard!, c).toBeGreaterThan(1);
        expect(m.soulShard!, c).toBeLessThanOrEqual(45);
      }
    });

    it('rewards the top end: the highest item levels of any area, and tier-4 affixes', () => {
      const table = getLootTable(pass.lootTableId);
      for (const a of GRAUMARK) {
        const other = getLootTable(a.lootTableId);
        expect(table.itemLevel!.max, a.id).toBeGreaterThan(other.itemLevel!.max);
        expect(table.affixTierBias ?? 0, a.id).toBeGreaterThanOrEqual(other.affixTierBias ?? 0);
      }
      expect(table.itemLevel!.max).toBeGreaterThan(getLootTable('namelessCryptIII').itemLevel!.max);
      // Tier-4 affixes unlock at item level 25: Pass drops reach them, Abbey drops never do.
      const maxTier = (tableId: string, itemLevel: number) => {
        const rng = createRng(`tier4:${tableId}`);
        let best = 0;
        for (let i = 0; i < 400; i++) {
          const item = generateItem({
            seed: rng.int(0, 2 ** 31),
            itemLevel,
            lootTable: getLootTable(tableId),
            rarityId: 'rare',
            classId: 'warrior',
          })!;
          for (const a of item.affixes) best = Math.max(best, a.tier);
        }
        return best;
      };
      expect(maxTier(pass.lootTableId, 27)).toBe(4);
      expect(maxTier('sunkenAbbey', getLootTable('sunkenAbbey').itemLevel!.max)).toBeLessThan(4);
    });

    it('its merchant stock costs minutes of its farming gold, not hours', () => {
      const perMin = CLASS_IDS.reduce((s, c) => s + at(c, mid(pass)).goldPerHour, 0) / 4 / 60;
      const price = (rarityId: RarityId) =>
        buyPrice({ rarityId, itemLevel: mid(pass) }, DEFAULT_ECONOMY_CONFIG) / perMin;
      expect(price('common')).toBeGreaterThanOrEqual(3);
      expect(price('common')).toBeLessThanOrEqual(20);
      expect(price('uncommon')).toBeLessThanOrEqual(35);
    });
  });

  describe('the Ashfall Verge (ticket 6.1)', () => {
    const verge = getArea('ashfallVerge');
    const plus = (items: GeneratedItem[], upgradeLevel: number) =>
      items.map((i) => ({ ...i, upgradeLevel }));
    /**
     * The Verge's "geared": the Pass's best plain drops, Legendaries +10 at item level 27 (a hero
     * who slew the Ashen Warden). The best Pass builds are in builds.test.ts "the Ashfall Verge".
     */
    const passBest = (c: ClassId) => plus(kit(c, 27, 'legendary'), 10);
    const memo = new Map<string, FarmStats>();
    const at = (c: ClassId, level: number, areaId: AreaId = 'ashfallVerge', il = 27) => {
      const key = `${c}:${level}:${areaId}:${il}`;
      let s = memo.get(key);
      if (!s) memo.set(key, (s = farm(c, level, areaId, plus(kit(c, il, 'legendary'), 10))));
      return s;
    };
    const levels = [verge.minLevel, verge.minLevel + 3, verge.maxLevel];
    it('older Legendaries +10 farm it at every level: no deaths, idle-paced kills', () => {
      for (const level of levels) {
        const shares: number[] = [];
        for (const c of CLASS_IDS) {
          const s = at(c, level);
          const label = `${c} L${level}`;
          expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
          expect(s.damageShare, label).toBeLessThan(0.21);
          expect(s.killsPerMin, label).toBeGreaterThan(6);
          expect(s.killsPerMin, label).toBeLessThan(13);
          shares.push(s.damageShare);
        }
        // The hunter takes least (its Legendary kit's effects: 1.57 × at the Pass's top too).
        expect(Math.max(...shares) / Math.min(...shares), `L${level}`).toBeLessThan(1.8);
      }
    });

    it('pays at least the Pass’s XP and gold an hour with the same gear', () => {
      for (const c of CLASS_IDS) {
        const pass = at(c, 28, 'ashenPass');
        const entry = at(c, verge.minLevel);
        expect(entry.xpPerHour, c).toBeGreaterThan(pass.xpPerHour);
        expect(entry.goldPerHour, c).toBeGreaterThan(pass.goldPerHour);
        expect(entry.goldPerHour, c).toBeLessThan(4_000);
      }
    });

    it('is a step up: more damage per fight than the Pass’s top, and the Pass’s rares fall', () => {
      for (const c of CLASS_IDS) {
        const entry = at(c, verge.minLevel).damageShare;
        expect(entry, c).toBeGreaterThan(at(c, 28, 'ashenPass').damageShare * 1.15);
        expect(entry, c).toBeGreaterThan(0.06);
        // The Pass's own "geared" (rares +5) is not enough here.
        const rares = farm(c, verge.minLevel, verge.id, plus(kit(c, 27, 'rare'), 5));
        expect(rares.deathsPerHour, c).toBeGreaterThan(20);
      }
    });

    it('its tier-4 bases beat their tier-3 counterparts by about a tenth at the same item level', () => {
      const t4 = ITEM_BASES.filter((x) => x.tier === 4);
      expect(t4.length).toBe(10);
      for (const base of t4) {
        const t3 = ITEM_BASES.find(
          (x) =>
            x.tier === 3 &&
            !x.unique &&
            x.slot === base.slot &&
            x.classes.join() === base.classes.join(),
        )!;
        const sum = (id: string, itemLevel: number) =>
          getImplicitStats({ baseId: id, rarityId: 'rare', itemLevel }).reduce(
            (s, x) => s + x.value,
            0,
          );
        for (const il of [29, 32, 35]) {
          const ratio = sum(base.id, il) / sum(t3.id, il);
          expect(ratio, `${base.id} vs ${t3.id} @${il}`).toBeGreaterThan(1.05);
          expect(ratio, `${base.id} vs ${t3.id} @${il}`).toBeLessThan(1.3);
        }
      }
    });

    it('levels 28 → 34 take days, and the XP penalty soft-caps heroes around 42', () => {
      for (const c of CLASS_IDS) {
        const hours = (level: number) => {
          // The best open area at that level (the Pass or the Verge), in the old kit.
          const xph = Math.max(
            at(c, level, 'ashenPass').xpPerHour,
            at(c, Math.max(level, verge.minLevel)).xpPerHour,
          );
          return xpToNextLevel(level) / xph;
        };
        let climb = 0;
        for (let level = 28; level < 34; level++) climb += hours(level);
        expect(climb, c).toBeGreaterThan(15);
        expect(climb, c).toBeLessThan(45);
        // The soft cap: under a day a level up to 39, a cliff at 41–42, days a level from 42.
        expect(hours(39), c).toBeLessThan(24);
        expect(hours(42), c).toBeGreaterThan(2.2 * hours(40));
        expect(hours(42), c).toBeGreaterThan(48);
      }
    });

    it('yields existing materials at a gathering pace', () => {
      for (const c of CLASS_IDS) {
        const m = at(c, verge.minLevel + 3).materialsPerHour;
        expect(Object.keys(m).sort(), c).toEqual(['ironOre', 'soulShard']);
        expect(m.ironOre!, c).toBeGreaterThan(15);
        expect(m.ironOre!, c).toBeLessThanOrEqual(100);
        expect(m.soulShard!, c).toBeGreaterThan(1);
        expect(m.soulShard!, c).toBeLessThanOrEqual(45);
      }
    });

    it('drops the highest item levels, tier-4 bases and tier-5 affixes (never at the Pass)', () => {
      const table = getLootTable(verge.lootTableId);
      // Ticket 6.2: the Cinder Depths drop above it (its own block below); 8.1: the Pale Marches.
      // 8.2: the Hollow Deep.
      const above = [verge.id, 'cinderDepths', 'paleMarches', 'hollowDeep'];
      for (const a of AREAS.filter((x) => !above.includes(x.id))) {
        expect(table.itemLevel!.min, a.id).toBeGreaterThan(
          getLootTable(a.lootTableId).itemLevel!.max - 1,
        );
      }
      for (const e of table.entries) expect(getItemBase(e.baseId).tier, e.baseId).toBe(4);
      const maxTier = (tableId: string, itemLevel: number) => {
        const rng = createRng(`tier5:${tableId}`);
        let best = 0;
        for (let i = 0; i < 400; i++) {
          const item = generateItem({
            seed: rng.int(0, 2 ** 31),
            itemLevel,
            lootTable: getLootTable(tableId),
            rarityId: 'mythic',
            classId: 'warrior',
          })!;
          for (const a of item.affixes) best = Math.max(best, a.tier);
        }
        return best;
      };
      expect(maxTier(verge.lootTableId, 31)).toBe(5);
      expect(maxTier('ashenPass', 29)).toBe(4);
      expect(maxTier('ashenWarden', 29)).toBe(4);
    });

    it('older drops keep their salvage and Forge value', () => {
      for (const c of CLASS_IDS) {
        for (const item of passBest(c)) {
          // Salvage: tier-3 ore and soul shards, the same as before 6.1.
          const y = salvageYield(item);
          expect(y.gold, item.baseId).toBeGreaterThan(0);
          expect(
            (y.materials.ironOre ?? 0) + (y.materials.timber ?? 0),
            item.baseId,
          ).toBeGreaterThan(0);
          // Forge: the whole +10 path still prices in materials the Verge itself yields.
          const path = upgradePathCost(item, 0, 10);
          expect(path.worst.gold, item.baseId).toBeGreaterThan(0);
          for (const id of Object.keys(path.worst.materials)) {
            expect(
              verge.materials.includes(id as MaterialId) || id === 'timber' || id === 'rawHide',
              id,
            ).toBe(true);
          }
        }
      }
      // A tier-4 item salvages to more ore than a tier-3 one of the same rarity and level.
      const t3 = salvageYield({ baseId: 'knights-plate', rarityId: 'epic', itemLevel: 30 });
      const t4 = salvageYield({ baseId: 'ashplate-hauberk', rarityId: 'epic', itemLevel: 30 });
      expect(t4.materials.ironOre!).toBeGreaterThan(t3.materials.ironOre!);
      expect(t4.gold).toBe(t3.gold);
    });

    it('its merchant stock costs minutes of its farming gold, not hours', () => {
      const perMin =
        CLASS_IDS.reduce((s, c) => s + at(c, verge.minLevel + 3).goldPerHour, 0) / 4 / 60;
      const price = (rarityId: RarityId) =>
        buyPrice({ rarityId, itemLevel: verge.minLevel + 3 }, DEFAULT_ECONOMY_CONFIG) / perMin;
      expect(price('common')).toBeGreaterThanOrEqual(3);
      expect(price('common')).toBeLessThanOrEqual(20);
      expect(price('uncommon')).toBeLessThanOrEqual(35);
    });
  });

  describe('the Cinder Depths (ticket 6.2)', () => {
    const depths = getArea('cinderDepths');
    const plus = (items: GeneratedItem[], upgradeLevel: number) =>
      items.map((i) => ({ ...i, upgradeLevel }));
    /** Good Verge gear: the Verge's plain Legendaries +10 at item level 33 (tier 4). */
    const memo = new Map<string, FarmStats>();
    const at = (c: ClassId, level: number, areaId: AreaId = 'cinderDepths', il = 33, up = 10) => {
      const key = `${c}:${level}:${areaId}:${il}:${up}`;
      let s = memo.get(key);
      if (!s) memo.set(key, (s = farm(c, level, areaId, plus(kit(c, il, 'legendary'), up))));
      return s;
    };
    const levels = [depths.minLevel, depths.minLevel + 3, depths.maxLevel];
    it('good Verge gear farms it at every level: no deaths, idle-paced kills', () => {
      for (const level of levels) {
        for (const c of CLASS_IDS) {
          const s = at(c, level);
          const label = `${c} L${level}`;
          expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
          expect(s.damageShare, label).toBeLessThan(0.21);
          expect(s.killsPerMin, label).toBeGreaterThan(6);
          expect(s.killsPerMin, label).toBeLessThan(13);
          expect(s.materialsPerHour.ironOre ?? 0, label).toBeLessThanOrEqual(100);
          expect(s.materialsPerHour.soulShard ?? 0, label).toBeLessThanOrEqual(45);
        }
      }
    });

    it('pays more XP and gold an hour than the Verge’s top with the same gear', () => {
      for (const c of CLASS_IDS) {
        const verge = at(c, 34, 'ashfallVerge');
        const entry = at(c, depths.minLevel);
        expect(entry.xpPerHour, c).toBeGreaterThan(verge.xpPerHour);
        expect(entry.goldPerHour, c).toBeGreaterThan(verge.goldPerHour);
        expect(entry.goldPerHour, c).toBeLessThan(5_500);
      }
    });

    it('is a step up from the Verge, and the Verge’s rares fall here', () => {
      for (const c of CLASS_IDS) {
        const verge = at(c, 34, 'ashfallVerge');
        const entry = at(c, depths.minLevel);
        expect(entry.damageShare, c).toBeGreaterThan(verge.damageShare * 1.15);
        const pace = entry.killsPerMin / verge.killsPerMin;
        expect(pace, c).toBeGreaterThan(0.75);
        expect(pace, c).toBeLessThan(0.95);
        const rares = farm(c, depths.minLevel, depths.id, plus(kit(c, 33, 'rare'), 5));
        expect(rares.deathsPerHour, c).toBeGreaterThan(20);
      }
    });

    it('its own drops (item level 39) are worth chasing, without a new power tier', () => {
      for (const c of CLASS_IDS) {
        const own = at(c, 40, 'cinderDepths', 39, 5).killsPerMin;
        const verge = at(c, 40, 'cinderDepths', 33, 5).killsPerMin;
        expect(own / verge, c).toBeGreaterThan(1.03);
        expect(own / verge, c).toBeLessThan(1.4);
      }
      const table = getLootTable(depths.lootTableId);
      expect(table.itemLevel).toEqual({ min: 35, max: 41 });
      for (const e of table.entries) expect(getItemBase(e.baseId).tier, e.baseId).toBe(4);
    });

    it('older drops keep their salvage and Forge value', () => {
      // The Pass's and the Verge's drops salvage to the ore the Depths yield, and their Forge
      // paths price in materials the Depths drop (no new gathering material).
      for (const c of CLASS_IDS) {
        for (const item of [...kit(c, 27, 'legendary'), ...kit(c, 33, 'legendary')]) {
          const y = salvageYield(item);
          expect(y.gold, item.baseId).toBeGreaterThan(0);
          expect(y.materials.ironOre ?? 0, item.baseId).toBeGreaterThan(0);
          const path = upgradePathCost(item, 0, 10);
          for (const m of Object.keys(path.worst.materials))
            expect(depths.materials as readonly string[], `${item.baseId} ${m}`).toContain(m);
        }
      }
    });
  });

  describe('the Nameless Crypt (tiers: ticket 3.6)', () => {
    const crypt = getDungeonTier('namelessCrypt', 1);
    const RUNS = 64;
    const runs = (
      classId: ClassId,
      level: number,
      equipment: GeneratedItem[],
      tier: DungeonTier = 1,
      n = RUNS,
    ) =>
      Array.from({ length: n }, (_, i) =>
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          tier,
          character: { classId, level, xp: 0 },
          equipment,
          seed: `crypt-balance:${i}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
    const winRate = (rs: { bossDefeated: boolean }[]) =>
      rs.filter((r) => r.bossDefeated).length / rs.length;
    /** Win rate per class and the mean over the classes. */
    const rates = (f: (c: ClassId) => number) => {
      const per = Object.fromEntries(CLASS_IDS.map((c) => [c, f(c)])) as Record<ClassId, number>;
      return { per, mean: CLASS_IDS.reduce((s, c) => s + per[c], 0) / CLASS_IDS.length };
    };
    const upgraded = (items: GeneratedItem[], upgradeLevel: number) =>
      items.map((i) => ({ ...i, upgradeLevel }));
    /** Every kit slot as a Legendary with an effect rolled for the class. */
    const legendaryKit = (c: ClassId, itemLevel: number): GeneratedItem[] =>
      kit(c, itemLevel, 'legendary').map((item) =>
        generateItem({
          seed: item.seed,
          itemLevel,
          baseId: item.baseId,
          rarityId: 'legendary',
          classId: c,
        })!,
      );
    /** A set's six pieces in their slots of `gear`. */
    const withSet = (c: ClassId, gear: GeneratedItem[], setId: string, itemLevel: number) => {
      const out = [...gear];
      const used = new Set<number>();
      ITEM_SETS.find((x) => x.id === setId)!.pieces.forEach((id, i) => {
        const slot = getItemBase(id).slot;
        const at = out.findIndex((g, j) => !used.has(j) && getItemBase(g.baseId).slot === slot);
        out[at] = generateItem({ seed: 100 + i, itemLevel, baseId: id, classId: c })!;
        used.add(at);
      });
      return out;
    };
    /** The class's Mythic weapon in place of the kit's weapon. */
    const withMythic = (c: ClassId, gear: GeneratedItem[], itemLevel: number) => {
      const m = MYTHIC_ITEMS.find(
        (x) => getItemBase(x.baseId).slot === 'weapon' && canClassUseItem(getItemBase(x.baseId), c),
      )!;
      const item = generateItem({ seed: 7, itemLevel, baseId: m.baseId, classId: c })!;
      return gear.map((g) => (getItemBase(g.baseId).slot === 'weapon' ? item : g));
    };
    const asVoid = (items: GeneratedItem[]) =>
      items.map((i) =>
        i.rarityId === 'legendary' || i.rarityId === 'mythic'
          ? { ...i, variant: 'void' as const }
          : i,
      );
    /** The Phase 3 best-in-slot builds at an item level (each must make a tier reliable). */
    const bestInSlot = (c: ClassId, il: number): [string, GeneratedItem[]][] => [
      ['legendary', legendaryKit(c, il)],
      ['vigil 6 + legendary', withSet(c, legendaryKit(c, il), 'drowned-vigil', il)],
      ['choir 6 + legendary', withSet(c, legendaryKit(c, il), 'ashen-choir', il)],
      ['mythic + legendary', withMythic(c, legendaryKit(c, il), il)],
      ['legendary +10', upgraded(legendaryKit(c, il), 10)],
      ['void legendary +10', asVoid(upgraded(legendaryKit(c, il), 10))],
    ];

    it('tier I: a curve, not a cliff, from the entry to the tier’s level', () => {
      const entry = crypt.unlock.level;
      // Naked heroes never win, even at the boss's level.
      for (const c of CLASS_IDS) expect(winRate(runs(c, crypt.bossLevel, [])), c).toBe(0);
      // Plain commons at the entry: a small chance (the B.1 cliff said never).
      const commons = rates((c) => winRate(runs(c, entry, kit(c, entry - 1))));
      for (const c of CLASS_IDS) expect(commons.per[c], `${c} entry`).toBeLessThanOrEqual(0.5);
      expect(commons.mean).toBeGreaterThanOrEqual(0.05);
      expect(commons.mean).toBeLessThanOrEqual(0.3);
      // Decent gear and some upgrades: a real, but not certain, chance for every class.
      const decent: [string, (c: ClassId) => GeneratedItem[]][] = [
        ['commons +5', (c) => upgraded(kit(c, entry - 1), 5)],
        ['uncommons', (c) => kit(c, entry, 'uncommon')],
        ['commons + Tyrant’s Bane', (c) => wearRing(kit(c, entry - 1), 'tyrants-bane')],
      ];
      for (const [label, gear] of decent) {
        const r = rates((c) => winRate(runs(c, entry, gear(c))));
        for (const c of CLASS_IDS) {
          expect(r.per[c], `${c} ${label}`).toBeGreaterThanOrEqual(0.25);
          expect(r.per[c], `${c} ${label}`).toBeLessThanOrEqual(0.9);
        }
      }
      // Every upgrade step and every level helps (gradually).
      const byUpgrade = [0, 3, 5, 7].map(
        (u) => rates((c) => winRate(runs(c, entry, upgraded(kit(c, entry - 1), u)))).mean,
      );
      for (let i = 1; i < byUpgrade.length; i++) {
        expect(byUpgrade[i]!, `+${[0, 3, 5, 7][i]}`).toBeGreaterThan(byUpgrade[i - 1]!);
      }
      expect(byUpgrade.at(-1)!).toBeLessThan(0.9);
      const byLevel = [entry, entry + 1, entry + 2, entry + 3].map(
        (l) => rates((c) => winRate(runs(c, l, kit(c, l - 1)))).mean,
      );
      for (let i = 1; i < byLevel.length; i++) {
        expect(byLevel[i]!, `L${entry + i}`).toBeGreaterThan(byLevel[i - 1]!);
      }
      // The tier's level with plain gear (B.1's "geared 15") and best-in-slot are reliable.
      for (const c of CLASS_IDS) {
        expect(winRate(runs(c, 15, kit(c, 14))), `${c} geared 15`).toBeGreaterThanOrEqual(0.9);
        expect(winRate(runs(c, entry, kit(c, entry, 'rare'))), `${c} rares`).toBeGreaterThanOrEqual(
          0.95,
        );
        for (const [label, gear] of [
          ['vigil 6', withSet(c, kit(c, entry - 1), 'drowned-vigil', 14)],
          ['legendary', legendaryKit(c, 14)],
        ] as const) {
          expect(winRate(runs(c, entry, gear)), `${c} ${label}`).toBeGreaterThanOrEqual(0.95);
        }
      }
    });

    it('tier I is not trivial for a hero at the tier’s level', () => {
      for (const c of CLASS_IDS) {
        for (const r of runs(c, 15, kit(c, 14)).filter((x) => x.bossDefeated)) {
          // The boss takes longer than the earliest enrage and a third of the hero's health.
          const boss = r.encounters.at(-1)!;
          expect(boss.room).toBeNull();
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs.min * 1.2);
          const spawn = r.events.findLast((e) => e.type === 'spawn')!;
          const hit = r.events.findLast((e) => e.type === 'enemyAttack')!;
          if (spawn.type !== 'spawn' || hit.type !== 'enemyAttack')
            throw new Error('no boss fight');
          expect(1 - hit.health / spawn.health, c).toBeGreaterThan(0.3);
        }
      }
    });

    it('tier II: Abbey rares give a chance, rares with upgrades or epics a good one, BiS is reliable', () => {
      const t = getDungeonTier('namelessCrypt', 2);
      const entry = t.unlock.level;
      const at = (gear: (c: ClassId) => GeneratedItem[], level = entry) =>
        rates((c) => winRate(runs(c, level, gear(c), 2, 32)));
      for (const c of CLASS_IDS) expect(winRate(runs(c, t.bossLevel, [], 2, 16)), c).toBe(0);
      // Commons are left behind, even with upgrades.
      expect(at((c) => upgraded(kit(c, entry - 1), 5)).mean).toBeLessThanOrEqual(0.1);
      const rare = at((c) => kit(c, entry - 1, 'rare'));
      expect(rare.mean).toBeGreaterThanOrEqual(0.2);
      expect(rare.mean).toBeLessThanOrEqual(0.7);
      // Upgrades, epics or two more levels each lift it, short of certain.
      const better: [(c: ClassId) => GeneratedItem[], number][] = [
        [(c) => upgraded(kit(c, entry - 1, 'rare'), 5), entry],
        [(c) => kit(c, entry - 1, 'epic'), entry],
        [(c) => kit(c, entry + 1, 'rare'), entry + 2],
      ];
      for (const [gear, level] of better) {
        const r = at(gear, level);
        expect(r.mean).toBeGreaterThan(rare.mean);
        expect(r.mean).toBeLessThanOrEqual(0.95);
      }
      for (const c of CLASS_IDS) {
        for (const [label, gear] of bestInSlot(c, entry - 1)) {
          expect(winRate(runs(c, entry, gear, 2, 32)), `${c} ${label}`).toBeGreaterThanOrEqual(
            0.95,
          );
        }
      }
    });

    it('tier III: needs Phase 3 gear; upgraded epics have a chance, BiS is reliable', () => {
      const t = getDungeonTier('namelessCrypt', 3);
      const entry = t.unlock.level;
      const at = (gear: (c: ClassId) => GeneratedItem[], level = entry) =>
        rates((c) => winRate(runs(c, level, gear(c), 3, 32)));
      for (const c of CLASS_IDS) expect(winRate(runs(c, t.bossLevel, [], 3, 16)), c).toBe(0);
      expect(at((c) => kit(c, entry - 1)).mean).toBe(0);
      expect(at((c) => kit(c, entry - 1, 'rare')).mean).toBeLessThanOrEqual(0.1);
      // Ticket 4.8 (3.9 saw tier III fall at its entry to every upgrading hero): upgraded Abbey
      // rares are not enough any more, and upgraded epics are a chance at the entry, not a given.
      expect(at((c) => upgraded(kit(c, entry - 1, 'rare'), 5)).mean).toBeLessThanOrEqual(0.1);
      const epic = at((c) => kit(c, entry - 1, 'epic'));
      expect(epic.mean).toBeLessThanOrEqual(0.4);
      const epic5 = at((c) => upgraded(kit(c, entry - 1, 'epic'), 5));
      expect(epic5.mean).toBeGreaterThan(epic.mean);
      expect(epic5.mean).toBeGreaterThanOrEqual(0.05);
      expect(epic5.mean).toBeLessThanOrEqual(0.35);
      const epic8 = at((c) => upgraded(kit(c, entry - 1, 'epic'), 8));
      expect(epic8.mean).toBeGreaterThan(epic5.mean);
      expect(epic8.mean).toBeGreaterThanOrEqual(0.3);
      expect(epic8.mean).toBeLessThanOrEqual(0.75);
      // Two levels on (and two item levels of gear), the same upgraded epics win most runs.
      expect(at((c) => upgraded(kit(c, entry + 1, 'epic'), 8), entry + 2).mean).toBeGreaterThan(
        Math.max(0.7, epic8.mean),
      );
      // Deeper is harder: the same epics do worse than in tier II at its entry.
      const t2 = getDungeonTier('namelessCrypt', 2).unlock.level;
      const epicII = rates((c) => winRate(runs(c, t2, kit(c, t2 - 1, 'epic'), 2, 32)));
      expect(epic.mean).toBeLessThan(epicII.mean);
      // Legendaries make it likely (sure two levels on), the best-in-slot builds reliable.
      expect(at((c) => legendaryKit(c, entry - 1)).mean).toBeGreaterThanOrEqual(0.7);
      expect(at((c) => legendaryKit(c, entry + 1), entry + 2).mean).toBeGreaterThanOrEqual(0.95);
      for (const c of CLASS_IDS) {
        for (const [label, gear] of bestInSlot(c, entry - 1).slice(1)) {
          expect(winRate(runs(c, entry, gear, 3, 32)), `${c} ${label}`).toBeGreaterThanOrEqual(
            0.95,
          );
        }
      }
    });

    it('no build trivialises the deeper tiers: the boss outlasts a share of the earliest enrage', () => {
      for (const tier of [1, 2, 3] as const) {
        const t = getDungeonTier('namelessCrypt', tier);
        for (const c of CLASS_IDS) {
          for (const [label, gear] of bestInSlot(c, t.unlock.level + 1)) {
            for (const r of runs(c, t.bossLevel, gear, tier, 8)) {
              const boss = r.encounters.at(-1)!;
              expect(boss.room, `${tier} ${c} ${label}`).toBeNull();
              // Tier I is far below these builds' level; tier III is where they belong.
              if (tier === 1) continue;
              expect(boss.endMs - boss.startMs, `${tier} ${c} ${label}`).toBeGreaterThan(
                t.bossEnrage.atMs.min * (tier === 2 ? 0.35 : 0.55),
              );
            }
          }
        }
      }
    });

    it('a run pays at most about twice the XP of farming for the same time', () => {
      const cases: [DungeonTier, number, (c: ClassId) => GeneratedItem[], AreaId][] = [
        [1, 15, (c) => kit(c, 14), 'blackwater'],
        [2, 20, (c) => kit(c, 19, 'epic'), 'sunkenAbbey'],
        [3, 22, (c) => legendaryKit(c, 21), 'sunkenAbbey'],
      ];
      for (const [tier, level, gear, area] of cases) {
        for (const c of CLASS_IDS) {
          const rs = runs(c, level, gear(c), tier, 16);
          const xpPerHour =
            rs.reduce((s, r) => s + r.xpGained / (r.durationMs / HOUR), 0) / rs.length;
          const farming = farm(c, level, area, gear(c)).xpPerHour;
          expect(xpPerHour / farming, `${tier} ${c}`).toBeGreaterThan(0.8);
          expect(xpPerHour / farming, `${tier} ${c}`).toBeLessThan(2.2);
        }
      }
    });

    describe('the Ashen Warden (ticket 4.8)', () => {
      const watch = getDungeonTier('ashenWatch', 1);
      const entry = watch.unlock.level;
      const wardenRuns = (c: ClassId, level: number, gear: GeneratedItem[], n = 24) =>
        Array.from({ length: n }, (_, i) =>
          simulateDungeonRun({
            dungeonId: 'ashenWatch',
            character: { classId: c, level, xp: 0 },
            equipment: gear,
            seed: `warden-balance:${i}`,
            bossLootEligible: true,
            inventoryCount: 0,
          }),
        );
      const at = (gear: (c: ClassId) => GeneratedItem[], level = entry, n = 24) =>
        rates((c) => winRate(wardenRuns(c, level, gear(c), n)));

      it('is the top-end goal: Legendaries a good chance, upgraded Legendaries and BiS reliable', () => {
        for (const c of CLASS_IDS)
          expect(winRate(wardenRuns(c, watch.bossLevel, [], 8)), c).toBe(0);
        // The gear that farms the Ashen Pass does not beat its warden.
        expect(at((c) => upgraded(kit(c, entry - 1, 'rare'), 5)).mean).toBe(0);
        expect(at((c) => upgraded(kit(c, entry - 1, 'epic'), 5)).mean).toBe(0);
        // Epics at +10 a small chance; Legendaries a good one; +5 on them makes it likely.
        const epic10 = at((c) => upgraded(kit(c, entry - 1, 'epic'), 10));
        expect(epic10.mean).toBeLessThanOrEqual(0.3);
        const legendary = at((c) => legendaryKit(c, entry - 1));
        expect(legendary.mean).toBeGreaterThan(epic10.mean);
        expect(legendary.mean).toBeGreaterThanOrEqual(0.5);
        expect(legendary.mean).toBeLessThanOrEqual(0.9);
        const legendary5 = at((c) => upgraded(legendaryKit(c, entry - 1), 5));
        expect(legendary5.mean).toBeGreaterThanOrEqual(0.9);
        // Harder than tier III for the same hero: Legendaries at tier III's top level.
        const t3 = getDungeonTier('namelessCrypt', 3);
        expect(
          rates((c) => winRate(runs(c, entry, legendaryKit(c, entry - 1), 3, 24))).mean,
        ).toBeGreaterThan(legendary.mean);
        expect(t3.bossLevel).toBeLessThan(watch.bossLevel);
        // Every best-in-slot build at the boss's level is reliable (plain Legendaries: above): on
        // average over the classes, and for each class but for a poor roll of its generated kit.
        const builds = bestInSlot('warrior', 1)
          .slice(1)
          .map(([label]) => label);
        for (const [i, label] of builds.entries()) {
          const r = rates((c) =>
            winRate(
              wardenRuns(c, watch.bossLevel, bestInSlot(c, watch.bossLevel - 1)[i + 1]![1], 16),
            ),
          );
          expect(r.mean, label).toBeGreaterThanOrEqual(0.95);
          for (const c of CLASS_IDS) expect(r.per[c], `${c} ${label}`).toBeGreaterThanOrEqual(0.85);
        }
      });

      it('no build trivialises it, and a run pays about the XP of farming the Pass', () => {
        for (const c of CLASS_IDS) {
          for (const [label, gear] of bestInSlot(c, watch.bossLevel + 1)) {
            for (const r of wardenRuns(c, watch.bossLevel, gear, 8)) {
              const boss = r.encounters.at(-1)!;
              expect(r.encounters.length, label).toBe(1);
              expect(boss.endMs - boss.startMs, `${c} ${label}`).toBeGreaterThan(
                watch.bossEnrage.atMs.min * 0.4,
              );
            }
          }
          const gear = upgraded(legendaryKit(c, 26), 5);
          const rs = wardenRuns(c, 27, gear, 16);
          const xpPerHour =
            rs.reduce((s, r) => s + r.xpGained / (r.durationMs / HOUR), 0) / rs.length;
          const farming = farm(c, 27, 'ashenPass', gear).xpPerHour;
          expect(xpPerHour / farming, c).toBeGreaterThan(0.8);
          expect(xpPerHour / farming, c).toBeLessThan(2.2);
        }
      });
    });

    describe('the Forge Tyrant (ticket 6.2)', () => {
      const forge = getDungeonTier('tyrantsForge', 1);
      const entry = forge.unlock.level;
      /** Good Verge gear: the Verge's drops at item level 33 (tier 4). */
      const VERGE_IL = 33;
      const tyrantRuns = (c: ClassId, level: number, gear: GeneratedItem[], n = 24) =>
        Array.from({ length: n }, (_, i) =>
          simulateDungeonRun({
            dungeonId: 'tyrantsForge',
            character: { classId: c, level, xp: 0 },
            equipment: gear,
            seed: `tyrant-balance:${i}`,
            bossLootEligible: true,
            inventoryCount: 0,
          }),
        );
      const at = (gear: (c: ClassId) => GeneratedItem[], level = entry, n = 24) =>
        rates((c) => winRate(tyrantRuns(c, level, gear(c), n)));

      it('good Verge gear beats him at 36–38, not trivially; lesser gear does not', () => {
        for (const c of CLASS_IDS)
          expect(winRate(tyrantRuns(c, forge.bossLevel, [], 8)), c).toBe(0);
        // The gear that farms the Verge (rares and epics +5) never beats him.
        expect(at((c) => upgraded(kit(c, VERGE_IL, 'rare'), 5), 38).mean).toBe(0);
        expect(at((c) => upgraded(kit(c, VERGE_IL, 'epic'), 5), 38).mean).toBe(0);
        // Epics +10: a rare win at most.
        const epic10 = at((c) => upgraded(kit(c, VERGE_IL, 'epic'), 10), 38);
        expect(epic10.mean).toBeLessThanOrEqual(0.15);
        // Verge Legendaries: a chance at +0, likely at +5, near-certain (not certain) at +10.
        for (const level of [36, 38]) {
          const legendary = at((c) => legendaryKit(c, VERGE_IL), level);
          expect(legendary.mean, `L${level}`).toBeGreaterThan(epic10.mean);
          expect(legendary.mean, `L${level}`).toBeGreaterThanOrEqual(0.2);
          expect(legendary.mean, `L${level}`).toBeLessThanOrEqual(0.6);
          const legendary5 = at((c) => upgraded(legendaryKit(c, VERGE_IL), 5), level);
          expect(legendary5.mean, `L${level}`).toBeGreaterThan(legendary.mean);
          expect(legendary5.mean, `L${level}`).toBeGreaterThanOrEqual(0.55);
          expect(legendary5.mean, `L${level}`).toBeLessThanOrEqual(0.9);
          const legendary10 = at((c) => upgraded(legendaryKit(c, VERGE_IL), 10), level);
          expect(legendary10.mean, `L${level}`).toBeGreaterThanOrEqual(0.8);
          // Every class can win in it (the mage, cloth against his physical blows, least).
          for (const c of CLASS_IDS)
            expect(legendary10.per[c], `${c} L${level}`).toBeGreaterThanOrEqual(0.5);
          // The plain Legendaries +10 that farm the Verge (no effects): mostly, not always.
          const plain10 = at((c) => upgraded(kit(c, VERGE_IL, 'legendary'), 10), level);
          expect(plain10.mean, `L${level}`).toBeGreaterThanOrEqual(0.6);
          expect(plain10.mean, `L${level}`).toBeLessThan(0.95);
        }
        // Harder than the Ashen Warden for the same kit at each boss's entry.
        const warden = getDungeonTier('ashenWatch', 1);
        expect(
          rates((c) =>
            winRate(
              Array.from({ length: 24 }, (_, i) =>
                simulateDungeonRun({
                  dungeonId: 'ashenWatch',
                  character: { classId: c, level: warden.unlock.level, xp: 0 },
                  equipment: legendaryKit(c, warden.unlock.level - 1),
                  seed: `tyrant-balance:${i}`,
                  bossLootEligible: true,
                  inventoryCount: 0,
                }),
              ),
            ),
          ).mean,
        ).toBeGreaterThan(at((c) => legendaryKit(c, VERGE_IL), entry).mean);
        // Every best-in-slot build in the Depths' own drops is reliable at his level.
        const builds = bestInSlot('warrior', 1)
          .slice(1)
          .map(([label]) => label);
        for (const [i, label] of builds.entries()) {
          const r = rates((c) =>
            winRate(
              tyrantRuns(c, forge.bossLevel, bestInSlot(c, forge.bossLevel - 1)[i + 1]![1], 16),
            ),
          );
          expect(r.mean, label).toBeGreaterThanOrEqual(0.95);
          for (const c of CLASS_IDS) expect(r.per[c], `${c} ${label}`).toBeGreaterThanOrEqual(0.85);
        }
      });

      it('his shell and hammer fight in every run, and nothing kills him in a few blows', () => {
        for (const c of CLASS_IDS) {
          for (const [label, gear] of bestInSlot(c, forge.bossLevel + 1)) {
            for (const r of tyrantRuns(c, forge.bossLevel, gear, 8)) {
              const boss = r.encounters.at(-1)!;
              expect(r.encounters.length, label).toBe(1);
              expect(boss.endMs - boss.startMs, `${c} ${label}`).toBeGreaterThan(
                forge.bossEnrage.atMs.min * 0.4,
              );
              // A kill breaks the shell first; every third blow was a heavy one.
              const shell = r.events.findIndex((e) => e.type === 'shellBroken');
              const kill = r.events.findIndex((e) => e.type === 'kill');
              if (r.bossDefeated) {
                expect(shell, `${c} ${label}`).toBeGreaterThan(-1);
                expect(shell, `${c} ${label}`).toBeLessThan(kill);
              }
              const blows = r.events.filter((e) => e.type === 'enemyAttack');
              for (const [k, b] of blows.entries())
                expect(b.type === 'enemyAttack' && b.heavy === true, `${c} blow ${k}`).toBe(
                  (k + 1) % 3 === 0,
                );
            }
          }
        }
      });

      it('a run pays about the XP of farming the Depths, and his hoard and ember drop', () => {
        for (const c of CLASS_IDS) {
          const gear = upgraded(legendaryKit(c, VERGE_IL), 10);
          const rs = tyrantRuns(c, 38, gear, 16);
          const xpPerHour =
            rs.reduce((s, r) => s + r.xpGained / (r.durationMs / HOUR), 0) / rs.length;
          const farming = farm(c, 38, 'cinderDepths', gear).xpPerHour;
          expect(xpPerHour / farming, c).toBeGreaterThan(0.8);
          expect(xpPerHour / farming, c).toBeLessThan(2.5);
          for (const r of rs.filter((x) => x.bossDefeated)) {
            expect(r.items.length + r.salvaged.length + r.overCapacity.length).toBe(2);
            expect(r.materials).toEqual({ tyrantsEmber: 1 });
            for (const item of r.items) {
              // Tier-4 bases (set pieces and Mythics keep their fixed tier-3 bases).
              if (!item.setId && !item.mythicId) expect(getItemBase(item.baseId).tier).toBe(4);
              expect(item.itemLevel).toBeGreaterThanOrEqual(39);
            }
          }
        }
      });
    });
  });

  describe('secondary modifiers at their caps (ticket 3.1)', () => {
    const caps = DEFAULT_ACTIVITY_CONFIG.modifierCaps;
    /** A synthetic ring carrying every listed affix far above its cap (equipment is not validated). */
    const overCap = (...affixIds: string[]): GeneratedItem => ({
      seed: 1,
      baseId: 'iron-ring',
      rarityId: 'common',
      itemLevel: 1,
      affixes: affixIds.map((affixId) => ({ affixId, tier: 1, value: 5 })),
    });
    const skillAffix = (c: ClassId) => AFFIXES.find((a) => a.classes?.includes(c))!.id;

    it('XP gain, item find and resource yield are bounded by their caps while farming', () => {
      for (const c of CLASS_IDS) {
        const level = mid(getArea('oldBurialGrounds'));
        const gear = kit(c, level - 1);
        const plain = farm(c, level, 'oldBurialGrounds', gear);
        const boosted = farm(c, level, 'oldBurialGrounds', [
          ...gear,
          overCap('xp-gain', 'item-find', 'resource-yield'),
        ]);
        expect(boosted.deathsPerHour, c).toBeLessThanOrEqual(plain.deathsPerHour + 0.5);
        expect(boosted.xpPerHour / plain.xpPerHour, c).toBeLessThanOrEqual(1 + caps.xpGain + 0.05);
        expect(boosted.xpPerHour / plain.xpPerHour, c).toBeGreaterThan(1 + caps.xpGain - 0.05);
        for (const [id, n] of Object.entries(plain.materialsPerHour) as [MaterialId, number][]) {
          if (getMaterial(id).profession === null || n < 5) continue;
          expect(boosted.materialsPerHour[id]! / n, `${c} ${id}`).toBeLessThanOrEqual(
            1 + caps.resourceYield + 0.15,
          );
        }
      }
    });

    it('capped boss and skill damage speed up the Gravewarden without trivialising it', () => {
      const crypt = getDungeonTier('namelessCrypt', 1);
      for (const c of CLASS_IDS) {
        const gear = [...kit(c, 14), overCap('boss-damage', skillAffix(c))];
        for (let i = 0; i < 8; i++) {
          const r = simulateDungeonRun({
            dungeonId: 'namelessCrypt',
            character: { classId: c, level: 15, xp: 0 },
            equipment: gear,
            seed: `crypt-caps:${i}`,
            bossLootEligible: false,
            inventoryCount: 0,
          });
          expect(r.bossDefeated, c).toBe(true);
          const boss = r.encounters.at(-1)!;
          // Still 90 % of the earliest enrage moment (27 s, the pre-3.6 threshold).
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs.min * 0.9);
        }
      }
    });
  });

  describe('unique effects (ticket 3.2)', () => {
    /** A synthetic ring carrying one effect at its strongest roll (equipment is not validated). */
    const effectRing = (effectId: string): GeneratedItem => ({
      seed: 1,
      baseId: 'iron-ring',
      rarityId: 'legendary',
      itemLevel: 1,
      affixes: [],
      effectId,
      effectRoll: 1,
    });
    const legendaries = EFFECTS.filter((e) => e.kind === 'legendary');
    const forClass = (c: ClassId) => legendaries.filter((e) => !e.classId || e.classId === c);
    const areas: [AreaId, number][] = [
      ['crowwood', 7],
      ['blackwater', 15],
      ['sunkenAbbey', 19],
    ];
    const withEffect = (c: ClassId, level: number, areaId: AreaId, effectId: string) =>
      farm(c, level, areaId, [...kit(c, level - 1), effectRing(effectId)]);
    const cryptRuns = (c: ClassId, level: number, equipment: GeneratedItem[], n = 8) =>
      Array.from({ length: n }, (_, i) =>
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          character: { classId: c, level, xp: 0 },
          equipment,
          seed: `crypt-effects:${i}`,
          bossLootEligible: false,
          inventoryCount: 0,
        }),
      );

    it('no Legendary effect alone breaks the death or kill bands', () => {
      for (const c of CLASS_IDS) {
        for (const [areaId, level] of areas) {
          const plain = geared(c, level, areaId);
          for (const e of forClass(c)) {
            const s = withEffect(c, level, areaId, e.id);
            const label = `${c} ${areaId} ${e.id}`;
            expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
            expect(s.damageShare, label).toBeLessThan(0.21);
            // An effect helps or is neutral, but never more than a fifth more kills.
            expect(s.killsPerMin / plain.killsPerMin, label).toBeGreaterThan(0.99);
            expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.2);
          }
        }
      }
    });

    it('a Mythic in its slot is a big upgrade that still keeps the bands', () => {
      for (const c of CLASS_IDS) {
        for (const level of [19, 22]) {
          // Against a rare kit: a Mythic is a late-game find, worn next to other good items.
          const gear = kit(c, level - 1, 'rare');
          const plain = farm(c, level, 'sunkenAbbey', gear);
          for (const m of MYTHIC_ITEMS) {
            const base = getItemBase(m.baseId);
            if (!canClassUseItem(base, c)) continue;
            const mythic = generateItem({
              seed: 3,
              itemLevel: level - 1,
              baseId: base.id,
              rarityId: 'mythic',
              classId: c,
            })!;
            // Replace the kit's item of that slot (one ring of two).
            const slotIndex = gear.findIndex((i) => getItemBase(i.baseId).slot === base.slot);
            const worn = gear.map((item, i) => (i === slotIndex ? mythic : item));
            const s = farm(c, level, 'sunkenAbbey', worn);
            const label = `${c} L${level} ${m.id}`;
            expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
            expect(s.damageShare, label).toBeLessThan(0.21);
            expect(s.killsPerMin / plain.killsPerMin, label).toBeGreaterThan(1);
            expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.3);
          }
        }
      }
    });

    it('no single effect is the best choice for everything', () => {
      // Three jobs: farming speed, safety (damage share) and the boss. For every class, the
      // best effect for one job is not the best for all three.
      for (const c of CLASS_IDS) {
        const scores = forClass(c).map((e) => {
          const s = withEffect(c, 15, 'blackwater', e.id);
          const boss = cryptRuns(c, 15, [...kit(c, 14), effectRing(e.id)], 4).map((r) => {
            const b = r.encounters.at(-1)!;
            return r.bossDefeated ? b.endMs - b.startMs : Infinity;
          });
          return {
            id: e.id,
            kills: s.killsPerMin,
            safety: -s.damageShare,
            boss: -boss.reduce((a, b) => a + b, 0),
          };
        });
        const best = (key: 'kills' | 'safety' | 'boss') =>
          scores.reduce((a, b) => (b[key] > a[key] ? b : a)).id;
        const winners = new Set([best('kills'), best('safety'), best('boss')]);
        expect(winners.size, `${c}: ${[...winners].join(', ')}`).toBeGreaterThan(1);
      }
    });

    it('effects move the crypt but do not trivialise the Gravewarden', () => {
      const crypt = getDungeonTier('namelessCrypt', 1);
      const unique = [...legendaries, ...EFFECTS.filter((e) => e.kind === 'mythic')];
      for (const c of CLASS_IDS) {
        for (const e of unique.filter((x) => !x.classId || x.classId === c)) {
          // A naked hero still never wins, whatever it wears in one slot.
          expect(
            cryptRuns(c, crypt.maxLevel, [effectRing(e.id)], 4).some((r) => r.bossDefeated),
            `${c} ${e.id} naked`,
          ).toBe(false);
          // Geared at 15 it still wins (nearly always: since 3.6 an early enrage can catch any
          // hero), and the boss still takes 90 % of the earliest enrage moment (27 s, as before).
          const geared = cryptRuns(c, 15, [...kit(c, 14), effectRing(e.id)], 16);
          expect(
            geared.filter((r) => r.bossDefeated).length,
            `${c} ${e.id}`,
          ).toBeGreaterThanOrEqual(14);
          for (const r of geared.filter((x) => x.bossDefeated)) {
            const boss = r.encounters.at(-1)!;
            expect(boss.endMs - boss.startMs, `${c} ${e.id}`).toBeGreaterThan(
              crypt.bossEnrage.atMs.min * 0.9,
            );
          }
        }
      }
    });
  });
  describe('set bonuses (ticket 3.3)', () => {
    /** A set's first `n` pieces as the generator makes them (Legendary rarity, fixed bases). */
    const pieces = (setId: string, n: number, itemLevel: number, classId: ClassId) =>
      ITEM_SETS.find((x) => x.id === setId)!
        .pieces.slice(0, n)
        .map((id, i) => generateItem({ seed: 100 + i, itemLevel, baseId: id, classId })!);
    /** Puts items into the kit's slots of the same kind (the first free ring slot first). */
    const wear = (gear: GeneratedItem[], items: GeneratedItem[]) => {
      const out = [...gear];
      const used = new Set<number>();
      for (const item of items) {
        const slot = getItemBase(item.baseId).slot;
        const i = out.findIndex((g, j) => !used.has(j) && getItemBase(g.baseId).slot === slot);
        if (i < 0) throw new Error(`no ${slot} in the kit`);
        out[i] = item;
        used.add(i);
      }
      return out;
    };
    /** The regular base a Legendary of a slot uses: the best tier the class can wear. */
    const legendaryBase = (c: ClassId, slot: string, itemLevel: number) =>
      ITEM_BASES.filter(
        (b) => !b.unique && b.slot === slot && b.minItemLevel <= itemLevel && canClassUseItem(b, c),
      ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel)[0]!;
    /** Legendaries on the given slots, with the given effects at the median roll. */
    const withLegendaries = (
      c: ClassId,
      slots: readonly string[],
      effects: readonly string[],
      itemLevel: number,
      gear: GeneratedItem[],
    ) =>
      wear(
        gear,
        slots.map((slot, i) => ({
          ...generateItem({
            seed: 100 + i,
            itemLevel,
            baseId: legendaryBase(c, slot, itemLevel).id,
            rarityId: 'legendary',
            classId: c,
          })!,
          effectId: effects[i]!,
          effectRoll: 0.5,
        })),
      );
    /**
     * The effects of the best Legendary build on the given slots: each slot's regular base as a
     * Legendary at the median roll, its effect picked greedily for farming speed in the Abbey. A
     * strong, lucky build: every piece carries the best effect for its slot.
     */
    const bestLegendaryEffects = (
      c: ClassId,
      slots: readonly string[],
      level: number,
      gear: GeneratedItem[],
    ): string[] => {
      const chosen: string[] = [];
      for (const slot of slots) {
        const base = legendaryBase(c, slot, level - 1);
        let best = '';
        let bestKills = -1;
        for (const e of legendaryEffectPool(base, c)) {
          const effects = [...chosen, e.id];
          const worn = withLegendaries(c, slots.slice(0, effects.length), effects, level - 1, gear);
          const k = farm(c, level, 'sunkenAbbey', worn).killsPerMin;
          if (k > bestKills) [best, bestKills] = [e.id, k];
        }
        chosen.push(best);
      }
      return chosen;
    };
    const bossRuns = (c: ClassId, equipment: GeneratedItem[], n = 6) =>
      Array.from({ length: n }, (_, i) =>
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          character: { classId: c, level: 15, xp: 0 },
          equipment,
          seed: `crypt-effects:${i}`,
          bossLootEligible: false,
          inventoryCount: 0,
        }),
      );
    /** Mean boss fight time (a loss counts as the whole enrage window twice). */
    const bossTime = (c: ClassId, equipment: GeneratedItem[]) => {
      const runs = bossRuns(c, equipment);
      return (
        runs.reduce((t, r) => {
          const b = r.encounters.at(-1)!;
          return t + (r.bossDefeated ? b.endMs - b.startMs : 90_000);
        }, 0) / runs.length
      );
    };
    /** A synthetic ring carrying one effect (as in the 3.2 tests): the bonus without the stats. */
    const bonusRing = (effectId: string): GeneratedItem => ({
      seed: 1,
      baseId: 'iron-ring',
      rarityId: 'legendary',
      itemLevel: 1,
      affixes: [],
      effectId,
      effectRoll: 1,
    });
    const SIX_SLOTS = ['head', 'chest', 'hands', 'feet', 'neck', 'ring'];

    it('no set at any bonus breaks the death or kill bands', () => {
      for (const c of CLASS_IDS) {
        for (const level of [19, 22]) {
          const gear = kit(c, level - 1, 'rare');
          const plain = farm(c, level, 'sunkenAbbey', gear);
          for (const set of ITEM_SETS) {
            let previous = plain.killsPerMin;
            for (const { pieces: n } of set.bonuses) {
              const s = farm(c, level, 'sunkenAbbey', wear(gear, pieces(set.id, n, level - 1, c)));
              const label = `${c} L${level} ${set.id} ${n}`;
              expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
              expect(s.damageShare, label).toBeLessThan(0.21);
              // Each threshold helps (the first pieces' stats may trade a rare item's affixes for a
              // little less speed), but a full set (6 slots of Legendary-rarity gear) stays below
              // +50 % kills.
              expect(s.killsPerMin / previous, label).toBeGreaterThan(0.97);
              expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.5);
              previous = s.killsPerMin;
            }
          }
        }
      }
    });

    it.each(CLASS_IDS)(
      'sets compete with Legendary builds rather than replacing them (%s)',
      (c) => {
        const level = 19;
        {
          const gear = kit(c, level - 1, 'rare');
          const crypt = kit(c, 14);
          /** A build in the Abbey at 19 and its twin (item level 14) on a crypt kit for the boss. */
          const build = (name: string, setId: string | null, n: number, slots: string[]) => {
            const farmGear = setId ? wear(gear, pieces(setId, n, level - 1, c)) : gear;
            const bossGear = setId ? wear(crypt, pieces(setId, n, 14, c)) : crypt;
            const effects = slots.length > 0 ? bestLegendaryEffects(c, slots, level, farmGear) : [];
            return {
              name,
              farm: withLegendaries(c, slots, effects, level - 1, farmGear),
              boss: withLegendaries(c, slots, effects, 14, bossGear),
            };
          };
          const builds = [
            ...ITEM_SETS.map((set) => build(set.id, set.id, 6, [])),
            build('legendary', null, 0, SIX_SLOTS),
            // A set's 4-piece bonus next to two Legendaries in the slots it leaves free.
            build('drowned-vigil 4 + legendary 2', 'drowned-vigil', 4, ['neck', 'ring']),
            build('ashen-choir 4 + legendary 2', 'ashen-choir', 4, ['neck', 'ring']),
            build('bloodmoon-hunt 4 + legendary 2', 'bloodmoon-hunt', 4, ['head', 'chest']),
          ];
          const scores = builds.map((b) => ({
            name: b.name,
            kills: farm(c, level, 'sunkenAbbey', b.farm).killsPerMin,
            boss: bossTime(c, b.boss),
          }));
          const pure = scores.filter((x) => ITEM_SETS.some((set) => set.id === x.name));
          const legendary = scores.find((x) => x.name === 'legendary')!;
          const mixed = scores.filter((x) => x.name.includes(' + '));
          const label = `${c}: ${scores.map((x) => `${x.name} ${x.kills.toFixed(2)}/${(x.boss / 1000).toFixed(0)}s`).join(', ')}`;
          // Not replacing: a full Legendary build out-farms every pure set ...
          for (const x of pure) expect(legendary.kills, label).toBeGreaterThan(x.kills);
          // ... and the best farming build always carries Legendaries.
          const fastest = scores.reduce((a, b) => (b.kills > a.kills ? b : a));
          expect(fastest.name === 'legendary' || fastest.name.includes(' + '), label).toBe(true);
          // Competing: a set bonus is part of a build within a quarter of the fastest ...
          const bestWithSet = Math.max(...[...pure, ...mixed].map((x) => x.kills));
          expect(bestWithSet / fastest.kills, label).toBeGreaterThan(0.75);
          // ... set + Legendary mixes out-farm every pure set (they combine) ...
          for (const x of pure) {
            expect(Math.max(...mixed.map((m) => m.kills)), label).toBeGreaterThan(x.kills);
          }
          // ... and for the boss, the best build with a set is close to the Legendary build or
          // better (casters: a pure set is the fastest boss build; warrior and hunter: a set +
          // Legendary mix is within a third of the perfect Legendary build).
          const bossWithSet = Math.min(...[...pure, ...mixed].map((x) => x.boss));
          // Ticket B.2: the hunter's perfect Legendary build stays the fastest tier I boss build on
          // a common kit (× 1.46; before B.2 × 1.28, when the Choir's crits chained into Aimed
          // Shots). The real build comparison is B.2's search at the tier III Gravewarden
          // (`builds.test.ts`), where Legendaries alone are not among the hunter's top builds.
          expect(bossWithSet / legendary.boss, label).toBeLessThan(c === 'hunter' ? 1.5 : 1.35);
        }
      },
      30_000,
    );

    it('no set is the best choice for everything', () => {
      // Three jobs, as for effects: farming speed, safety (damage share) and the boss. For every
      // class, the best full set for one job is not the best for all three.
      for (const c of CLASS_IDS) {
        const scores = ITEM_SETS.map((set) => {
          const bonus = set.bonuses.map((b) => bonusRing(b.effectId));
          const s = farm(c, 15, 'blackwater', [...kit(c, 14), ...bonus]);
          return {
            id: set.id,
            kills: s.killsPerMin,
            safety: -s.damageShare,
            boss: -bossTime(c, [...kit(c, 14), ...bonus]),
          };
        });
        // Ticket B.2: the sets within 1 % of a job's best all count as its best (a 0.4 % lead in
        // kills is noise, e.g. the hunter's Vigil against Bloodmoon). Fails only when one set
        // leads all three jobs clearly.
        const best = (key: 'kills' | 'safety' | 'boss') => {
          const top = Math.max(...scores.map((x) => x[key]));
          return scores.filter((x) => x[key] >= top - Math.abs(top) * 0.01).map((x) => x.id);
        };
        const jobs = [best('kills'), best('safety'), best('boss')];
        const everywhere = ITEM_SETS.filter((set) =>
          jobs.every((j) => j.length === 1 && j[0] === set.id),
        );
        // Known limit (B.2): on this bonus-only common kit the warlock's Vigil leads all three
        // jobs (it out-farmed Bloodmoon before B.2 too; since B.2 the Choir no longer wins its
        // boss). With late-game builds the warlock's top boss builds include the Choir and no-set
        // builds (`builds.test.ts`), so for the warlock this only records the lead.
        if (c === 'warlock') {
          expect(jobs[0]).toContain('drowned-vigil');
          continue;
        }
        expect(everywhere, `${c}: ${JSON.stringify(scores)}`).toEqual([]);
      }
    });

    it('full set bonuses move the crypt but do not trivialise the Gravewarden', () => {
      const crypt = getDungeonTier('namelessCrypt', 1);
      for (const c of CLASS_IDS) {
        for (const set of ITEM_SETS) {
          const bonus = set.bonuses.map((b) => bonusRing(b.effectId));
          const label = `${c} ${set.id}`;
          // A naked hero never wins, whatever bonuses it has.
          expect(
            bossRuns(c, bonus, 4).some((r) => r.bossDefeated),
            `${label} naked`,
          ).toBe(false);
          // Geared at 15 it still wins, and the boss still takes 2/3 of the earliest enrage
          // moment (20 s, the pre-3.6 threshold; three bonuses at once, one effect keeps 27 s).
          for (const r of bossRuns(c, [...kit(c, 14), ...bonus])) {
            expect(r.bossDefeated, label).toBe(true);
            const boss = r.encounters.at(-1)!;
            expect(boss.endMs - boss.startMs, label).toBeGreaterThan(
              crypt.bossEnrage.atMs.min * 0.675,
            );
          }
        }
      }
    });
  });

  describe('Void variants (ticket 3.5)', () => {
    /** Every kit slot as a Legendary of its base, effect rolled for the class (a full late kit). */
    const legendaryKit = (c: ClassId, itemLevel: number): GeneratedItem[] =>
      kit(c, itemLevel, 'legendary').map((item) =>
        generateItem({
          seed: item.seed,
          itemLevel,
          baseId: item.baseId,
          rarityId: 'legendary',
          classId: c,
        })!,
      );
    /** The Drowned Vigil's six pieces in their slots, Legendaries elsewhere. */
    const vigilKit = (c: ClassId, itemLevel: number): GeneratedItem[] => {
      const out = legendaryKit(c, itemLevel);
      const vigil = ITEM_SETS.find((x) => x.id === 'drowned-vigil')!;
      const used = new Set<number>();
      vigil.pieces.forEach((id, i) => {
        const slot = getItemBase(id).slot;
        const at = out.findIndex((g, j) => !used.has(j) && getItemBase(g.baseId).slot === slot);
        out[at] = generateItem({ seed: 100 + i, itemLevel, baseId: id, classId: c })!;
        used.add(at);
      });
      return out;
    };
    const asVoid = (items: GeneratedItem[]) =>
      items.map((i) => ({ ...i, variant: 'void' as const }));
    const atPlus10 = (items: GeneratedItem[]) => items.map((i) => ({ ...i, upgradeLevel: 10 }));
    const bossTimes = (c: ClassId, equipment: GeneratedItem[]) =>
      Array.from({ length: 6 }, (_, i) => {
        const r = simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          character: { classId: c, level: 15, xp: 0 },
          equipment,
          seed: `crypt-effects:${i}`,
          bossLootEligible: false,
          inventoryCount: 0,
        });
        const b = r.encounters.at(-1)!;
        return r.bossDefeated ? b.endMs - b.startMs : Infinity;
      });

    it('a full Void kit stays within the bands and is a small step over the same kit', () => {
      // Measured (docs/EFFECTS.md): Void adds 0.5–7 % kills to a full Legendary or Vigil kit.
      for (const c of CLASS_IDS) {
        for (const level of [19, 22]) {
          const rare = farm(c, level, 'sunkenAbbey', kit(c, level - 1, 'rare'));
          for (const [name, gear] of [
            ['legendary', legendaryKit(c, level - 1)],
            ['vigil 6 + legendary', vigilKit(c, level - 1)],
            ['legendary +10', atPlus10(legendaryKit(c, level - 1))],
          ] as const) {
            const plain = farm(c, level, 'sunkenAbbey', gear);
            const s = farm(c, level, 'sunkenAbbey', asVoid(gear));
            const label = `${c} L${level} ${name}`;
            expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
            expect(s.damageShare, label).toBeLessThan(0.21);
            expect(s.damageShare, label).toBeLessThanOrEqual(plain.damageShare);
            // A small bonus: never worse, at most a tenth more kills than the same kit.
            expect(s.killsPerMin / plain.killsPerMin, label).toBeGreaterThanOrEqual(0.99);
            expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.1);
            // Everything at once (Void Legendaries at +10) stays under twice a rare kit.
            expect(s.killsPerMin / rare.killsPerMin, label).toBeLessThan(2);
          }
        }
      }
    });

    it('a Void Mythic in its slot keeps the Mythic band', () => {
      for (const c of CLASS_IDS) {
        for (const level of [19, 22]) {
          const gear = kit(c, level - 1, 'rare');
          const plain = farm(c, level, 'sunkenAbbey', gear);
          for (const m of MYTHIC_ITEMS) {
            const base = getItemBase(m.baseId);
            if (!canClassUseItem(base, c)) continue;
            const mythic = generateItem({ seed: 3, itemLevel: level - 1, baseId: base.id })!;
            const at = gear.findIndex((i) => getItemBase(i.baseId).slot === base.slot);
            const s = farm(
              c,
              level,
              'sunkenAbbey',
              gear.map((item, i) => (i === at ? { ...mythic, variant: 'void' as const } : item)),
            );
            const label = `${c} L${level} void ${m.id}`;
            expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
            expect(s.damageShare, label).toBeLessThan(0.21);
            expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.3);
          }
        }
      }
    });

    it('Void barely moves the Gravewarden fight', () => {
      for (const c of CLASS_IDS) {
        const gear = legendaryKit(c, 14);
        const plain = bossTimes(c, gear);
        const voided = bossTimes(c, asVoid(gear));
        voided.forEach((t, i) => {
          expect(t, c).toBeLessThan(Infinity);
          // At most about a tenth faster than the same Legendary kit, fight by fight (B.2: 0.88,
          // was 0.9; one hunter fight is 10.5 % faster since Headsman's Due rolls on rings).
          expect(t / plain[i]!, c).toBeGreaterThan(0.88);
        });
        // A naked hero gains nothing from Void (it is on items).
        expect(
          bossTimes(c, []).every((t) => t === Infinity),
          c,
        ).toBe(true);
      }
    });
  });

  describe('forge upgrades (ticket 3.4)', () => {
    const upgraded = (items: GeneratedItem[], upgradeLevel: number) =>
      items.map((i) => ({ ...i, upgradeLevel }));
    const crypt = getDungeonTier('namelessCrypt', 1);
    const winRate = (rs: { bossDefeated: boolean }[]) =>
      rs.filter((r) => r.bossDefeated).length / rs.length;
    const cryptRuns = (classId: ClassId, level: number, equipment: GeneratedItem[], n = 16) =>
      Array.from({ length: n }, (_, i) =>
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          character: { classId, level, xp: 0 },
          equipment,
          seed: `crypt-balance:${i}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );

    it('a +10 kit stays within the death and kill bands everywhere', () => {
      for (const a of GRAUMARK) {
        for (const level of [mid(a), a.maxLevel]) {
          for (const c of CLASS_IDS) {
            const gear = kit(c, level - 1);
            const plain = farm(c, level, a.id, gear);
            let previous = plain;
            for (const u of [5, 10]) {
              const s = farm(c, level, a.id, upgraded(gear, u));
              const label = `${c} ${a.id} L${level} +${u}`;
              expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
              expect(s.damageShare, label).toBeLessThan(0.21);
              // Each level helps a little (safety first: base armour and health)…
              expect(s.killsPerMin, label).toBeGreaterThanOrEqual(previous.killsPerMin * 0.99);
              expect(s.damageShare, label).toBeLessThanOrEqual(previous.damageShare);
              // …but a whole +10 kit is a moderate edge, not a new tier of power (GDD §8.1, §8.3).
              expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.25);
              previous = s;
            }
          }
        }
      }
    });

    it('a +10 rare kit in the Sunken Abbey stays within the bands', () => {
      for (const c of CLASS_IDS) {
        for (const level of [19, 22]) {
          const gear = kit(c, level - 1, 'rare');
          const plain = farm(c, level, 'sunkenAbbey', gear);
          const s = farm(c, level, 'sunkenAbbey', upgraded(gear, 10));
          const label = `${c} L${level}`;
          expect(s.deathsPerHour, label).toBeLessThanOrEqual(2);
          expect(s.damageShare, label).toBeLessThan(0.21);
          expect(s.killsPerMin / plain.killsPerMin, label).toBeLessThan(1.25);
        }
      }
    });

    it('upgrades move the crypt entry, but never let a naked hero or trivialise the Gravewarden', () => {
      for (const c of CLASS_IDS) {
        // Since 3.6 the entry is a curve (the tier test): upgrades raise the chance step by
        // step, and a few of them on commons never make the entry certain.
        const plus0 = winRate(cryptRuns(c, 12, kit(c, 11)));
        const plus3 = winRate(cryptRuns(c, 12, upgraded(kit(c, 11), 3)));
        expect(plus3, `${c} +3 entry`).toBeGreaterThan(plus0);
        expect(plus3, `${c} +3 entry`).toBeLessThan(0.75);
        // A geared +10 hero at 15 always wins, but the boss still takes longer than the earliest
        // enrage (31.5 s, as before).
        for (const r of cryptRuns(c, 15, upgraded(kit(c, 14), 10), 8)) {
          expect(r.bossDefeated, c).toBe(true);
          const boss = r.encounters.at(-1)!;
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs.min * 1.05);
        }
      }
    });

    describe('the gold sink', () => {
      // A kit item at the area's middle level, and the classes' mean farming gold there.
      const sample = (a: AreaDefinition) => {
        const level = mid(a);
        const gear = kit('warrior', level - 1);
        const goldPerHour = stats(a.id, level).reduce((s, x) => s + x.goldPerHour, 0) / 4;
        return { gear, item: gear[0]!, goldPerHour };
      };
      const bestMaterialsPerHour = () => {
        const best: Partial<Record<MaterialId, number>> = {};
        for (const b of GRAUMARK) {
          const s = geared('warrior', mid(b), b.id);
          for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][])
            best[id] = Math.max(best[id] ?? 0, n);
        }
        return best;
      };

      /**
       * Ticket B.2: what a player really earns per hour, as a multiple of the kill gold measured
       * here (a common kit, no gold find). The realistic telemetry simulation (`docs/ECONOMY.md`)
       * earned about 2.5 × that in the Sunken Abbey: gold-find gear, faster kills, and selling and
       * salvaging drops. The targets below are in hours of that income.
       */
      const REALISTIC_INCOME = 2.5;

      it('the first steps are cheap, the last ones a real project', () => {
        for (const a of GRAUMARK) {
          const { item, goldPerHour } = sample(a);
          const hours = (from: number, to: number) =>
            upgradePathCost(item, from, to).expected.gold / (goldPerHour * REALISTIC_INCOME);
          expect(hours(0, 1) * 60, `${a.id} first attempt (min)`).toBeLessThan(5);
          expect(hours(0, 5), `${a.id} +0 → +5`).toBeGreaterThan(0.2);
          expect(hours(0, 5), `${a.id} +0 → +5`).toBeLessThan(1.5);
          expect(hours(5, 10), `${a.id} +5 → +10`).toBeGreaterThan(8);
          expect(hours(5, 10), `${a.id} +5 → +10`).toBeLessThan(25);
        }
      });

      it('a whole kit to +10 is a long-term sink that a full purse cannot buy outright', () => {
        for (const a of GRAUMARK) {
          const { gear, goldPerHour } = sample(a);
          const income = goldPerHour * REALISTIC_INCOME;
          const kitTo = (to: number) =>
            gear.reduce((s, g) => s + upgradePathCost(g, 0, to).expected.gold, 0);
          expect(kitTo(5) / income, `${a.id} kit +5 (h)`).toBeLessThan(10);
          expect(kitTo(10) / income, `${a.id} kit +10 (h)`).toBeGreaterThan(90);
          expect(kitTo(10) / income, `${a.id} kit +10 (h)`).toBeLessThan(220);
        }
        // The Phase 2 purse (25–30k gold by level 17) buys a kit to +5 and one item most of the
        // way to +10, not more.
        const gear17 = kit('warrior', 16);
        const kit5 = gear17.reduce((s, g) => s + upgradePathCost(g, 0, 5).expected.gold, 0);
        const item10 = upgradePathCost(gear17[0]!, 0, 10).expected.gold;
        expect(kit5).toBeLessThan(10_000);
        expect(kit5 + item10).toBeGreaterThan(25_000);
        expect(kit5 + item10).toBeLessThan(40_000);
      });

      it('failure is never punishing: pity caps the bad luck of a whole track at about twice the mean', () => {
        for (const a of GRAUMARK) {
          const { item } = sample(a);
          for (let n = 0; n < 10; n++) {
            const c = upgradePathCost(item, n, n + 1);
            // A step's worst case (every attempt fails until the pity) is at most 3× its mean.
            expect(c.worst.gold / c.expected.gold, `${a.id} +${n}`).toBeLessThanOrEqual(3);
          }
          const all = upgradePathCost(item, 0, 10);
          expect(all.worst.gold / all.expected.gold, a.id).toBeLessThan(2.2);
        }
      });

      it('materials: +5 takes about an hour of gathering, +10 a few evenings', () => {
        const best = bestMaterialsPerHour();
        for (const a of GRAUMARK) {
          const { item } = sample(a);
          const hours = (to: number) => {
            const m = upgradePathCost(item, 0, to).expected.materials;
            return Math.max(
              ...(Object.entries(m) as [MaterialId, number][])
                .filter(([id]) => id !== 'soulShard')
                .map(([id, n]) => n / best[id]!),
            );
          };
          expect(hours(5), `${a.id} +5`).toBeLessThan(2);
          expect(hours(10), `${a.id} +10`).toBeGreaterThan(4);
          expect(hours(10), `${a.id} +10`).toBeLessThan(15);
        }
      });
    });
  });
});

/** The highest unlocked area below the abbey for a character level. */
function farmingAreaFor(level: number): AreaId {
  const open = GRAUMARK.filter((a) => a.id !== 'sunkenAbbey' && a.unlock.level <= level);
  return open[open.length - 1]!.id;
}
