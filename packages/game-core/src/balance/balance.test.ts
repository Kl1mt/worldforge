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
  getDungeon,
  getItemBase,
  getMaterial,
  legendaryEffectPool,
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
  upgradePathCost,
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
      const crypt = getDungeon('namelessCrypt');
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
          // Still most of the pre-enrage window (geared without modifiers: ~1.0–1.2×).
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs * 0.6);
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
      const crypt = getDungeon('namelessCrypt');
      const unique = [...legendaries, ...EFFECTS.filter((e) => e.kind === 'mythic')];
      for (const c of CLASS_IDS) {
        for (const e of unique.filter((x) => !x.classId || x.classId === c)) {
          // A naked hero still never wins, whatever it wears in one slot.
          expect(
            cryptRuns(c, crypt.maxLevel, [effectRing(e.id)], 4).some((r) => r.bossDefeated),
            `${c} ${e.id} naked`,
          ).toBe(false);
          // Geared at 15 it still wins, and the boss still takes most of the pre-enrage window.
          for (const r of cryptRuns(c, 15, [...kit(c, 14), effectRing(e.id)], 6)) {
            expect(r.bossDefeated, `${c} ${e.id}`).toBe(true);
            const boss = r.encounters.at(-1)!;
            expect(boss.endMs - boss.startMs, `${c} ${e.id}`).toBeGreaterThan(
              crypt.bossEnrage.atMs * 0.6,
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
          expect(bossWithSet / legendary.boss, label).toBeLessThan(1.35);
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
        const best = (key: 'kills' | 'safety' | 'boss') =>
          scores.reduce((a, b) => (b[key] > a[key] ? b : a)).id;
        const winners = new Set([best('kills'), best('safety'), best('boss')]);
        expect(winners.size, `${c}: ${JSON.stringify(scores)}`).toBeGreaterThan(1);
      }
    });

    it('full set bonuses move the crypt but do not trivialise the Gravewarden', () => {
      const crypt = getDungeon('namelessCrypt');
      for (const c of CLASS_IDS) {
        for (const set of ITEM_SETS) {
          const bonus = set.bonuses.map((b) => bonusRing(b.effectId));
          const label = `${c} ${set.id}`;
          // A naked hero never wins, whatever bonuses it has.
          expect(
            bossRuns(c, bonus, 4).some((r) => r.bossDefeated),
            `${label} naked`,
          ).toBe(false);
          // Geared at 15 it still wins, and the boss still takes 45 % of the pre-enrage window
          // (three bonuses at once; a single effect keeps 60 %, see above).
          for (const r of bossRuns(c, [...kit(c, 14), ...bonus])) {
            expect(r.bossDefeated, label).toBe(true);
            const boss = r.encounters.at(-1)!;
            expect(boss.endMs - boss.startMs, label).toBeGreaterThan(crypt.bossEnrage.atMs * 0.45);
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
          // At most a tenth faster than the same Legendary kit, fight by fight.
          expect(t / plain[i]!, c).toBeGreaterThan(0.9);
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
    const crypt = getDungeon('namelessCrypt');
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
      for (const a of AREAS) {
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
        // The 3.1 cliff, not retuned: +0 commons at level 12 never win (docs/ECONOMY.md reports
        // how upgrades move it: +7 commons win most entries).
        expect(winRate(cryptRuns(c, 12, kit(c, 11))), `${c} +0 entry`).toBe(0);
        expect(winRate(cryptRuns(c, 12, upgraded(kit(c, 11), 3))), `${c} +3 entry`).toBeLessThan(
          0.25,
        );
        // A geared +10 hero at 15 always wins, but the boss still takes most of the window.
        for (const r of cryptRuns(c, 15, upgraded(kit(c, 14), 10), 8)) {
          expect(r.bossDefeated, c).toBe(true);
          const boss = r.encounters.at(-1)!;
          expect(boss.endMs - boss.startMs, c).toBeGreaterThan(crypt.bossEnrage.atMs * 0.7);
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
        for (const b of AREAS) {
          const s = geared('warrior', mid(b), b.id);
          for (const [id, n] of Object.entries(s.materialsPerHour) as [MaterialId, number][])
            best[id] = Math.max(best[id] ?? 0, n);
        }
        return best;
      };

      it('the first steps are cheap, the last ones a real project', () => {
        for (const a of AREAS) {
          const { item, goldPerHour } = sample(a);
          const hours = (from: number, to: number) =>
            upgradePathCost(item, from, to).expected.gold / goldPerHour;
          expect(hours(0, 1) * 60, `${a.id} first attempt (min)`).toBeLessThan(10);
          expect(hours(0, 5), `${a.id} +0 → +5`).toBeGreaterThan(0.5);
          expect(hours(0, 5), `${a.id} +0 → +5`).toBeLessThan(3);
          expect(hours(5, 10), `${a.id} +5 → +10`).toBeGreaterThan(8);
          expect(hours(5, 10), `${a.id} +5 → +10`).toBeLessThan(30);
        }
      });

      it('a whole kit to +10 is a long-term sink that a full purse cannot buy outright', () => {
        for (const a of AREAS) {
          const { gear, goldPerHour } = sample(a);
          const kitTo = (to: number) =>
            gear.reduce((s, g) => s + upgradePathCost(g, 0, to).expected.gold, 0);
          expect(kitTo(5) / goldPerHour, `${a.id} kit +5 (h)`).toBeLessThan(20);
          expect(kitTo(10) / goldPerHour, `${a.id} kit +10 (h)`).toBeGreaterThan(100);
        }
        // The Phase 2 purse (25–30k gold by level 17) buys a kit to +5 and a few items to +10.
        const gear17 = kit('warrior', 16);
        const kit5 = gear17.reduce((s, g) => s + upgradePathCost(g, 0, 5).expected.gold, 0);
        const item10 = upgradePathCost(gear17[0]!, 0, 10).expected.gold;
        expect(kit5).toBeLessThan(10_000);
        expect(kit5 + item10).toBeLessThan(25_000);
        expect(kit5 + 3 * item10).toBeGreaterThan(30_000);
      });

      it('failure is never punishing: pity caps the bad luck of a whole track at about twice the mean', () => {
        for (const a of AREAS) {
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
        for (const a of AREAS) {
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
  const open = AREAS.filter((a) => a.id !== 'sunkenAbbey' && a.unlock.level <= level);
  return open[open.length - 1]!.id;
}
