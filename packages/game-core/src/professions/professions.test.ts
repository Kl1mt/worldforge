import { describe, expect, it } from 'vitest';
import {
  AREAS,
  DEFAULT_PROFESSION_CONFIG,
  applyProfessionXp,
  createRng,
  initialProfessions,
  normalizeProfessions,
  professionXpToNext,
  rollGathering,
  settleFarming,
  validateProfessionConfig,
  type ProfessionLevels,
  type SettleFarmingInput,
} from '../index.js';

const HOUR = 60 * 60 * 1000;

const input = (overrides: Partial<SettleFarmingInput> = {}): SettleFarmingInput => ({
  character: { classId: 'warrior', level: 1, xp: 0 },
  areaId: 'abandonedFields',
  seed: 'professions-test',
  durationMs: HOUR,
  inventoryCount: 0,
  firstCycle: 0,
  ...overrides,
});

const at = (level: number): ProfessionLevels => {
  const p = initialProfessions();
  for (const id of Object.keys(p) as (keyof ProfessionLevels)[]) p[id] = { level, xp: 0 };
  return p;
};

describe('profession content', () => {
  it('matches the content contract', () => {
    expect(validateProfessionConfig(DEFAULT_PROFESSION_CONFIG)).toEqual([]);
    for (const area of AREAS) expect(DEFAULT_PROFESSION_CONFIG.areas[area.id]).toBeDefined();
  });

  it('reports broken data', () => {
    const broken = {
      ...DEFAULT_PROFESSION_CONFIG,
      areas: {
        ...DEFAULT_PROFESSION_CONFIG.areas,
        abandonedFields: {
          yields: [{ materialId: 'ironOre' as const, chance: 2 }],
          undeadDrops: [],
        },
      },
    };
    const problems = validateProfessionConfig(broken);
    expect(problems).toContain('abandonedFields: ironOre not listed by the area');
    expect(problems).toContain('abandonedFields: ironOre chance 2');
    expect(problems).toContain('abandonedFields: lists timber but yields none');
  });
});

describe('profession levels', () => {
  it('has a growing XP curve with a cap at 50', () => {
    expect(professionXpToNext(1)).toBe(20);
    expect(professionXpToNext(10)).toBeGreaterThan(professionXpToNext(9));
    expect(professionXpToNext(50)).toBe(0);
    expect(() => professionXpToNext(0)).toThrow(RangeError);
  });

  it('applies level-ups and discards XP beyond the cap', () => {
    expect(applyProfessionXp({ level: 1, xp: 0 }, 19)).toEqual({ level: 1, xp: 19 });
    expect(applyProfessionXp({ level: 1, xp: 0 }, 20)).toEqual({ level: 2, xp: 0 });
    expect(applyProfessionXp({ level: 49, xp: 0 }, 1e9)).toEqual({ level: 50, xp: 0 });
    expect(applyProfessionXp({ level: 50, xp: 0 }, 100)).toEqual({ level: 50, xp: 0 });
    expect(() => applyProfessionXp({ level: 1, xp: 0 }, -1)).toThrow(RangeError);
  });

  it('normalises stored state', () => {
    expect(normalizeProfessions({ mining: { level: 3, xp: 5 } })).toEqual({
      ...initialProfessions(),
      mining: { level: 3, xp: 5 },
    });
    expect(() => normalizeProfessions({ mining: { level: 51, xp: 0 } })).toThrow(RangeError);
    expect(() => normalizeProfessions({ mining: { level: 2, xp: -1 } })).toThrow(RangeError);
  });
});

describe('rollGathering', () => {
  const cycle = { areaId: 'abandonedFields' as const, enemyId: 'carrionWolf' as const };

  it('gathers nothing on a death', () => {
    for (let i = 0; i < 50; i++) {
      const rng = createRng(`d:${i}`);
      expect(rollGathering({ ...cycle, outcome: 'death' }, initialProfessions(), rng)).toEqual([]);
    }
  });

  it('is deterministic per stream', () => {
    const roll = (i: number) =>
      rollGathering({ ...cycle, outcome: 'kill' }, initialProfessions(), createRng(`g:${i}`));
    for (let i = 0; i < 20; i++) expect(roll(i)).toEqual(roll(i));
  });

  it('drops soul shards only from undead kills where the area lists them', () => {
    let shards = 0;
    for (let i = 0; i < 400; i++) {
      const p = initialProfessions();
      const undead = rollGathering(
        { areaId: 'oldBurialGrounds', outcome: 'kill', enemyId: 'risenSkeleton' },
        p,
        createRng(`s:${i}`),
      );
      shards += undead.filter((f) => f.materialId === 'soulShard').length;
      for (const f of undead) expect(f.professionId).toBeNull();
      // Timeouts are not kills; undead in other areas drop no shards.
      expect(
        rollGathering(
          { areaId: 'oldBurialGrounds', outcome: 'timeout', enemyId: 'risenSkeleton' },
          p,
          createRng(`s:${i}`),
        ),
      ).toEqual([]);
      const fields = rollGathering(
        { areaId: 'abandonedFields', outcome: 'kill', enemyId: 'risenFarmhand' },
        p,
        createRng(`s:${i}`),
      );
      expect(fields.some((f) => f.materialId === 'soulShard')).toBe(false);
    }
    expect(shards / 400).toBeGreaterThan(0.18);
    expect(shards / 400).toBeLessThan(0.32);
  });

  it('a higher profession level raises yield, not the find rate', () => {
    const total = (levels: ProfessionLevels) => {
      let finds = 0;
      let units = 0;
      for (let i = 0; i < 2000; i++) {
        for (const f of rollGathering({ ...cycle, outcome: 'kill' }, levels, createRng(`y:${i}`))) {
          finds++;
          units += f.quantity;
        }
      }
      return { finds, units };
    };
    const low = total(at(1));
    const high = total(at(50));
    expect(high.finds).toBe(low.finds);
    expect(low.units).toBe(low.finds);
    expect(high.units / high.finds).toBeGreaterThan(1.9);
  });
});

describe('gathering in settleFarming', () => {
  it('is deterministic and grants materials with profession XP', () => {
    const a = settleFarming(input({ durationMs: 3 * HOUR }));
    expect(a).toEqual(settleFarming(input({ durationMs: 3 * HOUR })));
    expect(a.materials.timber).toBeGreaterThan(50);
    expect(a.materials.ashwort).toBeGreaterThan(30);
    expect(Object.keys(a.materials).sort()).toEqual(['ashwort', 'timber']);
    expect(a.professions.woodcutting.level).toBeGreaterThan(1);
    expect(a.professions.herbalism.level).toBeGreaterThan(1);
    expect(a.professions.mining).toEqual({ level: 1, xp: 0 });
    expect(a.professionXpGained.mining).toBeUndefined();
  });

  it('gathers each area’s own materials', () => {
    const mid = { classId: 'warrior' as const, level: 20, xp: 0 };
    const abbey = settleFarming(
      input({ areaId: 'sunkenAbbey', character: mid, durationMs: 3 * HOUR }),
    );
    expect(
      Object.keys(abbey.materials).every((id) => ['ironOre', 'abbeySilver'].includes(id)),
    ).toBe(true);
    expect(abbey.materials.ironOre).toBeGreaterThan(0);
    const grave = settleFarming(
      input({ areaId: 'oldBurialGrounds', character: { ...mid, level: 12 }, durationMs: HOUR }),
    );
    expect(Object.keys(grave.materials)).toEqual(['soulShard']);
    expect(grave.professionXpGained).toEqual({});
  });

  it('uses the stored profession levels', () => {
    const fresh = settleFarming(input());
    const veteran = settleFarming(input({ professions: at(40) }));
    expect(veteran.kills).toBe(fresh.kills);
    expect(veteran.materials.timber!).toBeGreaterThan(fresh.materials.timber! * 1.5);
  });

  it('gathers nothing in an unfinished cycle', () => {
    const r = settleFarming(input({ durationMs: 1_000 }));
    expect(r.materials).toEqual({});
    expect(r.professions).toEqual(initialProfessions());
  });
});
