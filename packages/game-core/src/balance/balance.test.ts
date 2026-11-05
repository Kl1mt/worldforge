import { describe, expect, it } from 'vitest';
import {
  AREAS,
  CLASS_IDS,
  DEFAULT_ECONOMY_CONFIG,
  DEFAULT_PROFESSION_CONFIG,
  FORGE_RECIPES,
  ITEM_BASES,
  buyPrice,
  canClassUseItem,
  createRng,
  generateItem,
  getArea,
  getDungeon,
  getMaterial,
  settleFarming,
  simulateDungeonRun,
  type AreaDefinition,
  type AreaId,
  type ClassId,
  type FarmingSettlement,
  type GeneratedItem,
  type MaterialId,
  type ProfessionId,
  type ProfessionState,
  type RarityId,
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
      for (const a of AREAS) {
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
      for (const a of AREAS) {
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
      for (const a of AREAS) {
        for (const c of CLASS_IDS) {
          const s = geared(c, mid(a), a.id, 3);
          expect(s.deathsPerHour, `${c} ${a.id}`).toBeLessThanOrEqual(10);
        }
      }
    });

    it('each later area is a step up: its entry hits harder than the previous area at its top', () => {
      for (let i = 1; i < AREAS.length; i++) {
        const prev = AREAS[i - 1]!;
        const next = AREAS[i]!;
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
      for (const a of AREAS) {
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
      for (const a of AREAS) {
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
      for (const a of AREAS) {
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
      for (const a of AREAS) {
        for (const s of stats(a.id, mid(a))) {
          expect(s.goldPerHour, `${s.classId} ${a.id}`).toBeGreaterThan(80);
          expect(s.goldPerHour, `${s.classId} ${a.id}`).toBeLessThan(1_000);
        }
      }
    });

    it('a Forge recipe takes about an hour of farming in the areas that yield its materials', () => {
      // Best hourly yield of each material across the areas at their middle level (warrior).
      const best: Partial<Record<MaterialId, number>> = {};
      for (const a of AREAS) {
        const s = geared('warrior', mid(a), a.id);
        for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][])
          best[id] = Math.max(best[id] ?? 0, n);
      }
      for (const r of FORGE_RECIPES) {
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
      for (const a of AREAS) {
        const s = geared('warrior', mid(a), a.id);
        for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][]) {
          const cap = getMaterial(id).rarity === 'common' ? 60 : 45;
          expect(n, `${a.id} ${id}`).toBeLessThan(cap);
        }
      }
      expect(DEFAULT_PROFESSION_CONFIG.maxLevel).toBe(50);
    });
  });

  describe('the Nameless Crypt', () => {
    const crypt = getDungeon('namelessCrypt');
    const RUNS = 16;
    const runs = (classId: ClassId, level: number, equipment: GeneratedItem[]) =>
      Array.from({ length: RUNS }, (_, i) =>
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          character: { classId, level, xp: 0 },
          equipment,
          seed: `crypt-balance:${i}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
      );
    const winRate = (rs: ReturnType<typeof runs>) =>
      rs.filter((r) => r.bossDefeated).length / rs.length;

    it('the Gravewarden is beatable by a geared hero at the crypt’s level, but not trivially', () => {
      for (const c of CLASS_IDS) {
        expect(winRate(runs(c, crypt.maxLevel, [])), `${c} naked`).toBe(0);
        expect(winRate(runs(c, crypt.minLevel, kit(c, crypt.minLevel - 1))), `${c} entry`).toBe(0);
        const geared = runs(c, 15, kit(c, 14));
        expect(winRate(geared), `${c} geared 15`).toBeGreaterThanOrEqual(0.9);
        expect(winRate(runs(c, 14, kit(c, 14, 'uncommon'))), `${c} uncommon 14`).toBe(1);
        // Not trivial: the boss takes most of the pre-enrage window and a third of the hero's health.
        for (const r of geared) {
          const boss = r.encounters.at(-1)!;
          expect(boss.room).toBeNull();
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs * 0.8);
          const spawn = r.events.findLast((e) => e.type === 'spawn')!;
          const hit = r.events.findLast((e) => e.type === 'enemyAttack')!;
          if (spawn.type !== 'spawn' || hit.type !== 'enemyAttack')
            throw new Error('no boss fight');
          expect(1 - hit.health / spawn.health, c).toBeGreaterThan(0.3);
        }
      }
    });

    it('a run pays at most about twice the XP of farming for the same time', () => {
      for (const c of CLASS_IDS) {
        const rs = runs(c, 15, kit(c, 14));
        const xpPerHour = rs.reduce((s, r) => s + r.xpGained / (r.durationMs / HOUR), 0) / RUNS;
        const farming = geared(c, 15, 'blackwater').xpPerHour;
        expect(xpPerHour / farming, c).toBeGreaterThan(1);
        expect(xpPerHour / farming, c).toBeLessThan(2.2);
      }
    });
  });
});

/** The highest unlocked area below the abbey for a character level. */
function farmingAreaFor(level: number): AreaId {
  const open = AREAS.filter((a) => a.id !== 'sunkenAbbey' && a.unlock.level <= level);
  return open[open.length - 1]!.id;
}
