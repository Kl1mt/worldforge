import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  ENEMIES,
  attackIntervalMs,
  buildEncounter,
  createRng,
  deriveCharacterStats,
  enemyStatsAtLevel,
  getArea,
  mitigation,
  rollEncounter,
  xpLevelFactor,
} from '../index.js';

describe('mitigation', () => {
  it('is 0 without defense, grows with defense and respects the cap', () => {
    expect(mitigation(0, 1)).toBe(0);
    expect(mitigation(-5, 1)).toBe(0);
    expect(mitigation(20, 1)).toBeGreaterThan(mitigation(10, 1));
    expect(mitigation(20, 10)).toBeLessThan(mitigation(20, 1));
    expect(mitigation(1e9, 1)).toBe(DEFAULT_COMBAT_CONFIG.mitigation.cap);
  });
});

describe('xpLevelFactor', () => {
  it('only penalises characters well above the enemy level', () => {
    expect(xpLevelFactor(1, 3)).toBe(1);
    expect(xpLevelFactor(5, 3)).toBe(1);
    expect(xpLevelFactor(6, 3)).toBeCloseTo(0.85);
    expect(xpLevelFactor(60, 1)).toBe(DEFAULT_COMBAT_CONFIG.xpLevelPenalty.min);
  });
});

describe('encounters', () => {
  it('produce positive integer hits and intervals for every class, enemy and level', () => {
    for (const classId of CLASS_IDS) {
      for (const level of [1, 3, 6, 20, 60]) {
        const stats = deriveCharacterStats(classId, level);
        for (const enemy of ENEMIES) {
          for (const enemyLevel of [1, 6]) {
            const s = buildEncounter(
              enemy,
              enemyLevel,
              classId,
              level,
              stats,
              DEFAULT_COMBAT_CONFIG,
            );
            for (const v of [
              s.enemyHealth,
              s.enemyHit,
              s.enemyIntervalMs,
              s.playerIntervalMs,
              s.auto.normal,
              s.auto.crit,
              s.skill.normal,
              s.skill.crit,
            ]) {
              expect(Number.isInteger(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(1);
            }
            expect(s.auto.crit).toBeGreaterThanOrEqual(s.auto.normal);
            expect(s.skill.normal).toBeGreaterThan(s.auto.normal);
            expect(s.auto.critChance).toBeGreaterThanOrEqual(0);
            expect(s.skill.critChance).toBeLessThanOrEqual(1);
            expect(s.xpReward).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });

  it('uses armor against physical and resistance against magic attackers', () => {
    const wolf = ENEMIES.find((e) => e.id === 'carrionWolf')!;
    const scarecrow = ENEMIES.find((e) => e.id === 'boneScarecrow')!;
    const base = deriveCharacterStats('warrior', 3);
    const armored = deriveCharacterStats('warrior', 3, [{ armor: 200 }]);
    const warded = deriveCharacterStats('warrior', 3, [{ resistance: 200 }]);
    const hit = (enemy: typeof wolf, stats: typeof base) =>
      buildEncounter(enemy, 3, 'warrior', 3, stats, DEFAULT_COMBAT_CONFIG).enemyHit;
    expect(hit(wolf, armored)).toBeLessThan(hit(wolf, base));
    expect(hit(wolf, warded)).toBe(hit(wolf, base));
    expect(hit(scarecrow, warded)).toBeLessThan(hit(scarecrow, base));
    expect(hit(scarecrow, armored)).toBe(hit(scarecrow, base));
  });

  it('scales enemies with level', () => {
    for (const enemy of ENEMIES) {
      const lo = enemyStatsAtLevel(enemy, 1);
      const hi = enemyStatsAtLevel(enemy, 6);
      expect(hi.health).toBeGreaterThan(lo.health);
      expect(hi.damage).toBeGreaterThan(lo.damage);
      expect(hi.xp).toBeGreaterThan(lo.xp);
    }
  });

  it('rolls enemies inside the area level range with the configured weights', () => {
    const area = getArea('abandonedFields');
    const rng = createRng('encounters');
    const counts: Record<string, number> = {};
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const level = 1 + (i % 10);
      const s = rollEncounter(
        rng,
        area,
        'mage',
        level,
        deriveCharacterStats('mage', level),
        DEFAULT_COMBAT_CONFIG,
      );
      expect(s.enemyLevel).toBeGreaterThanOrEqual(area.minLevel);
      expect(s.enemyLevel).toBeLessThanOrEqual(area.maxLevel);
      expect(Math.abs(s.enemyLevel - Math.min(level, area.maxLevel))).toBeLessThanOrEqual(1);
      counts[s.enemyId] = (counts[s.enemyId] ?? 0) + 1;
    }
    const total = area.enemies.reduce((sum, e) => sum + e.weight, 0);
    for (const e of area.enemies) {
      expect((counts[e.enemyId] ?? 0) / n).toBeCloseTo(e.weight / total, 1);
    }
  });

  it('converts attack speed to whole-millisecond intervals', () => {
    expect(attackIntervalMs(1)).toBe(1000);
    expect(attackIntervalMs(1.3)).toBe(769);
    expect(attackIntervalMs(4)).toBe(250);
  });
});

describe('fight traits (ticket 8.1)', () => {
  const stats = {
    ...deriveCharacterStats('warrior', 43),
    armor: 1200,
    resistance: 600,
    critChance: 0.3,
    critDamage: 1.8,
  };
  const withTraits = (id: 'hollowKnight' | 'reachStalker' | 'paleChoir' | 'huskTitan') => {
    const enemy = ENEMIES.find((e) => e.id === id)!;
    const plain = { ...enemy };
    delete plain.traits;
    return {
      enemy,
      traited: buildEncounter(enemy, 43, 'warrior', 43, stats, DEFAULT_COMBAT_CONFIG),
      plain: buildEncounter(plain, 43, 'warrior', 43, stats, DEFAULT_COMBAT_CONFIG),
    };
  };

  it('only the Pale Marches’ foes have traits, one each', () => {
    const traited = ENEMIES.filter((e) => e.traits !== undefined).map((e) => e.id);
    expect(traited).toEqual(getArea('paleMarches').enemies.map((e) => e.enemyId));
    for (const e of ENEMIES.filter((x) => x.traits)) {
      expect(Object.keys(e.traits!), e.id).toHaveLength(1);
      for (const v of Object.values(e.traits!)) {
        expect(v, e.id).toBeGreaterThan(0);
        expect(v, e.id).toBeLessThan(1);
      }
    }
  });

  it('the hollow knight’s blade ignores part of the hero’s armour', () => {
    const { enemy, traited, plain } = withTraits('hollowKnight');
    const pierced = stats.armor * (1 - enemy.traits!.defensePierce!);
    const raw = enemyStatsAtLevel(enemy, 43).damage;
    expect(traited.enemyHit).toBe(
      Math.max(1, Math.round(raw * (1 - mitigation(pierced, 43, DEFAULT_COMBAT_CONFIG)))),
    );
    expect(traited.enemyHit).toBeGreaterThan(plain.enemyHit);
    expect(traited.auto).toEqual(plain.auto);
    expect(traited.skill).toEqual(plain.skill);
  });

  it('the reach stalker lowers the hero’s crit chance, the husk titan its crit damage', () => {
    const stalker = withTraits('reachStalker');
    expect(stalker.traited.auto.critChance).toBeCloseTo(0.15);
    expect(stalker.traited.auto.normal).toBe(stalker.plain.auto.normal);
    expect(stalker.traited.auto.crit).toBe(stalker.plain.auto.crit);
    expect(stalker.traited.enemyHit).toBe(stalker.plain.enemyHit);
    const titan = withTraits('huskTitan');
    // Half the bonus: × 1.4 instead of × 1.8.
    expect(titan.traited.auto.crit / titan.traited.auto.normal).toBeCloseTo(1.4, 1);
    expect(titan.traited.auto.critChance).toBe(titan.plain.auto.critChance);
    expect(titan.traited.auto.crit).toBeLessThan(titan.plain.auto.crit);
  });

  it('the pale choir dulls the class skill, never below a basic attack', () => {
    const { traited, plain } = withTraits('paleChoir');
    expect(traited.auto).toEqual(plain.auto);
    expect(traited.skill.normal).toBeLessThan(plain.skill.normal);
    expect(traited.skill.normal).toBeGreaterThanOrEqual(traited.auto.normal);
  });

  it('a foe without traits builds exactly the encounter it did', () => {
    for (const e of ENEMIES.filter((x) => !x.traits)) {
      const a = buildEncounter(e, 30, 'mage', 30, stats, DEFAULT_COMBAT_CONFIG);
      const b = buildEncounter({ ...e, traits: {} }, 30, 'mage', 30, stats, DEFAULT_COMBAT_CONFIG);
      expect(b, e.id).toEqual(a);
    }
  });
});
