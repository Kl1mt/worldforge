import { describe, expect, it } from 'vitest';
import { AREAS, ENEMIES, ENEMY_IDS, getArea, getEnemy, isAreaId, isEnemyId } from '../index.js';

describe('enemies', () => {
  it('defines the three Abandoned Fields enemies', () => {
    expect(ENEMIES.map((e) => e.name)).toEqual([
      'Risen Farmhand',
      'Carrion Wolf',
      'Bone Scarecrow',
    ]);
    expect(ENEMIES.map((e) => e.id)).toEqual([...ENEMY_IDS]);
  });

  it('has positive, finite stats', () => {
    for (const e of ENEMIES) {
      expect(e.attackSpeed).toBeGreaterThan(0);
      for (const s of [e.health, e.damage, e.armor, e.resistance, e.xp]) {
        expect(s.base).toBeGreaterThan(0);
        expect(s.perLevel).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('looks up and guards ids', () => {
    expect(getEnemy('carrionWolf').name).toBe('Carrion Wolf');
    expect(isEnemyId('boneScarecrow')).toBe(true);
    expect(isEnemyId('dragon')).toBe(false);
    expect(() => getEnemy('dragon' as never)).toThrow();
  });
});

describe('areas', () => {
  it('defines Abandoned Fields with a valid level range and known enemies', () => {
    const area = getArea('abandonedFields');
    expect(area.name).toBe('Abandoned Fields');
    expect(area.minLevel).toBeGreaterThanOrEqual(1);
    expect(area.maxLevel).toBeGreaterThanOrEqual(area.minLevel);
    expect(area.enemies.map((e) => e.enemyId).sort()).toEqual([...ENEMY_IDS].sort());
    for (const a of AREAS) {
      expect(a.enemies.reduce((sum, e) => sum + e.weight, 0)).toBeGreaterThan(0);
      for (const e of a.enemies) expect(isEnemyId(e.enemyId)).toBe(true);
    }
    expect(isAreaId('abandonedFields')).toBe(true);
    expect(isAreaId('crowwood')).toBe(false);
  });
});
