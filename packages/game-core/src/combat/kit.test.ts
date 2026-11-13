import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SKILLS,
  AUTO_SKILLS,
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_SKILLS_PROTOTYPE_MODE,
  PASSIVE_SKILLS,
  PULSE_MS,
  SkillsReplayMismatch,
  buildEncounter,
  createRng,
  defaultLoadout,
  deriveCharacterStats,
  deriveEquippedStats,
  kitAfterAttack,
  kitPulse,
  kitSpenderFor,
  kitStart,
  getEnemy,
  killDistribution,
  resolveFightDetailed,
  resolveLoadout,
  sampleFight,
  settleFarming,
  simulateDuel,
  simulateDungeonRun,
  simulateFarming,
  simulateFarmingAggregate,
  skillsPrototypeMode,
  validateLoadout,
  type AreaId,
  type ClassId,
  type EncounterSetup,
  type FarmingInput,
  type FarmingResult,
  type FightOutcome,
  type Loadout,
} from '../index.js';
import { kit as commonKit, legendaryKit, upgraded } from '../balance/kits.js';
import { withSkillsPrototype } from '../balance/loadouts.js';
import { equipmentModifiers, DEFAULT_ACTIVITY_CONFIG, DEFAULT_LOOT_CONFIG } from '../index.js';

const SLOW = { timeout: 120_000 };

/** Ticket 9.1: the skills prototype (docs/SKILLS.md). */

const full: Record<ClassId, Loadout> = {
  warrior: { actives: ['rend', 'execute', 'earthsplitter'], passive: 'juggernaut' },
  mage: { actives: ['scorch', 'pyroblast', 'meteor'], passive: 'deepReserves' },
  hunter: { actives: ['serratedArrow', 'volley', 'killShot'], passive: 'predator' },
  warlock: { actives: ['agony', 'corruption', 'soulBurn'], passive: 'soulSiphon' },
};
const farmingLoadout: Record<ClassId, Loadout> = {
  warrior: { actives: ['heavyStrike', 'charge', 'execute'], passive: 'berserker' },
  mage: { actives: ['firebolt', 'pyroblast', 'shatter'], passive: 'arcanePower' },
  hunter: { actives: ['aimedShot', 'firstBlood', 'quickShot'], passive: 'steadyAim' },
  warlock: { actives: ['shadowBolt', 'soulBurn', 'drainSoul'], passive: 'darkPact' },
};

const gear = (c: ClassId, il: number) => upgraded(legendaryKit(c, il), 5);
const stats = (c: ClassId, level: number, il: number) => {
  const m = equipmentModifiers(
    gear(c, il),
    DEFAULT_ACTIVITY_CONFIG.modifierCaps,
    DEFAULT_LOOT_CONFIG,
    {
      classId: c,
    },
  );
  return { stats: m.stats, effects: m.effects, modifiers: m };
};
const farmInput = (
  c: ClassId,
  areaId: AreaId,
  level: number,
  il: number,
  minutes: number,
  seed: string,
  loadout?: Loadout,
): FarmingInput => {
  const s = stats(c, level, il);
  return {
    character: { classId: c, level, xp: 0 },
    equipment: s.stats,
    modifiers: { skillDamage: s.modifiers.skillDamage, bossDamage: s.modifiers.bossDamage },
    effects: s.effects,
    areaId,
    seed,
    durationMs: minutes * 60_000,
    firstCycle: 0,
    ...(loadout ? { loadout } : {}),
  };
};

describe('the switch (9.1)', () => {
  it('is off by default; off, no encounter carries a kit and a loadout changes nothing', () => {
    expect(DEFAULT_SKILLS_PROTOTYPE_MODE).toBe('off');
    withSkillsPrototype(() => {
      expect(skillsPrototypeMode()).toBe('off');
      const setup = buildEncounter(
        getEnemy('risenFarmhand'),
        3,
        'warrior',
        3,
        deriveEquippedStats('warrior', 3, []),
        DEFAULT_COMBAT_CONFIG,
        undefined,
        undefined,
        { loadout: full.warrior },
      );
      expect(setup.kit).toBeUndefined();
      for (const c of CLASS_IDS) {
        const base = {
          character: { classId: c, level: 49, xp: 0 },
          equipment: gear(c, 47),
          areaId: 'hollowDeep' as const,
          seed: 'switch-off',
          firstCycle: 0,
          durationMs: 20 * 60_000,
          inventoryCount: 0,
        };
        expect(settleFarming({ ...base, loadout: full[c] })).toEqual(settleFarming(base));
      }
    }, 'off');
  });

  it('on, every encounter carries a kit, the default loadout when the hero has none', () => {
    withSkillsPrototype(() => {
      const setup = buildEncounter(
        getEnemy('risenFarmhand'),
        3,
        'mage',
        3,
        deriveEquippedStats('mage', 3, []),
        DEFAULT_COMBAT_CONFIG,
      );
      expect(setup.kit?.isDefault).toBe(true);
      expect(setup.kit?.active).toBe(false);
    });
  });
});

describe('skills and loadouts (content)', () => {
  it('gives every class six actives and four passives by level (1–36), plus two from bosses', () => {
    for (const c of CLASS_IDS) {
      const actives = ACTIVE_SKILLS.filter((s) => s.classId === c);
      const passives = PASSIVE_SKILLS.filter((s) => s.classId === c);
      const byLevel = actives.filter((s) => !s.unlock.deed);
      expect(byLevel.map((s) => s.unlock.level)).toEqual([1, 5, 12, 20, 28, 36]);
      expect(passives.filter((s) => !s.unlock.deed).map((s) => s.unlock.level)).toEqual([
        8, 16, 24, 32,
      ]);
      expect(actives.filter((s) => s.unlock.deed === 'forgeTyrantDefeated')).toHaveLength(1);
      expect(passives.filter((s) => s.unlock.deed === 'hollowSovereignDefeated')).toHaveLength(1);
      expect(actives.filter((s) => s.kind === 'core')).toHaveLength(2);
      // Today's skill is the first core skill, with today's numbers.
      const today = AUTO_SKILLS[c];
      expect(actives[0]).toMatchObject({
        id: today.id,
        kind: 'core',
        everyNthAttack: today.everyNthAttack,
        damageMultiplier: today.damageMultiplier,
        bonusCritChance: today.bonusCritChance,
        unlock: { level: 1 },
      });
      expect(defaultLoadout(c)).toEqual({ actives: [today.id, null, null], passive: null });
      expect(validateLoadout(c, full[c], { level: 50, progress: {} })).toEqual([]);
      expect(validateLoadout(c, farmingLoadout[c], { level: 50 })).toEqual([]);
    }
    const ids = [...ACTIVE_SKILLS, ...PASSIVE_SKILLS].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('validates class, slots, duplicates and unlocks', () => {
    const hero = { level: 30 };
    expect(validateLoadout('warrior', { actives: ['heavyStrike'] }, hero)).toEqual([]);
    expect(validateLoadout('warrior', { actives: ['shieldSlam'] }, hero)).toContain(
      'slot 1 holds a core skill, not shieldSlam',
    );
    expect(validateLoadout('warrior', { actives: [null, 'charge'] })).toContain(
      'slot 1 needs a core skill',
    );
    expect(validateLoadout('warrior', { actives: ['heavyStrike', 'rend'] })).toContain(
      'slot 2 holds a spender',
    );
    expect(validateLoadout('warrior', { actives: ['heavyStrike', 'charge', 'charge'] })).toContain(
      'charge twice',
    );
    expect(validateLoadout('warrior', { actives: ['firebolt'] })).toContain(
      'firebolt is not a warrior skill',
    );
    expect(validateLoadout('warrior', { actives: ['heavyStrike', 'earthsplitter'] }, hero)).toEqual(
      ['earthsplitter is locked'],
    );
    expect(
      validateLoadout('warrior', { actives: ['heavyStrike', 'forgebreaker'] }, { level: 50 }),
    ).toEqual(['forgebreaker is locked']);
    expect(
      validateLoadout(
        'warrior',
        { actives: ['heavyStrike', 'forgebreaker'] },
        { level: 50, progress: { forgeTyrantDefeated: true } },
      ),
    ).toEqual([]);
    expect(validateLoadout('warrior', { actives: ['heavyStrike'], passive: 'malice' })).toContain(
      'malice is not a warrior passive',
    );
    expect(validateLoadout('warrior', { actives: ['heavyStrike', null, null, null] })).toHaveLength(
      1,
    );
    expect(validateLoadout('warrior', { actives: ['nope'] })).toContain('unknown skill nope');
    expect(() => resolveLoadout('warrior', { actives: ['firebolt'] })).toThrow(RangeError);
  });
});

describe('the default loadout fights exactly as today (the replay)', () => {
  it('farming, both simulations, every class, three areas: equal to the switch off', SLOW, () => {
    for (const c of CLASS_IDS) {
      for (const [areaId, level, il] of [
        ['abandonedFields', 3, 2],
        ['sunkenAbbey', 20, 19],
        ['hollowDeep', 49, 47],
      ] as const) {
        const i = farmInput(c, areaId, level, il, 15, `replay:${c}:${areaId}`);
        const off = withSkillsPrototype(
          () => [simulateFarming(i), simulateFarmingAggregate(i)],
          'off',
        );
        // Shadow mode also resolves every fight twice and throws on the first difference.
        const on = withSkillsPrototype(
          () => [simulateFarming(i), simulateFarmingAggregate(i)],
          'shadow',
        );
        expect(on).toEqual(off);
      }
    }
  });

  it('crypt and boss runs and duels: equal to the switch off', SLOW, () => {
    for (const c of CLASS_IDS) {
      const run = () => [
        simulateDungeonRun({
          dungeonId: 'namelessCrypt',
          tier: 3,
          character: { classId: c, level: 23, xp: 0 },
          equipment: gear(c, 22),
          seed: `replay-run:${c}`,
          bossLootEligible: true,
          inventoryCount: 0,
        }),
        simulateDungeonRun({
          dungeonId: 'hollowThrone',
          character: { classId: c, level: 50, xp: 0 },
          equipment: gear(c, 47),
          seed: `replay-sov:${c}`,
          bossLootEligible: false,
          inventoryCount: 0,
          bossModifier: 'warded',
        }),
        simulateDuel({
          challenger: { classId: c, level: 32, equipment: gear(c, 29) },
          defender: { classId: 'warlock', level: 33, equipment: commonKit('warlock', 30) },
          seed: `replay-duel:${c}`,
        }),
      ];
      expect(withSkillsPrototype(run, 'shadow')).toEqual(withSkillsPrototype(run, 'off'));
    }
  });

  it('the shadow replay catches a kit that fights differently', () => {
    const setup = withSkillsPrototype(
      () =>
        buildEncounter(
          getEnemy('risenFarmhand'),
          5,
          'warrior',
          5,
          deriveEquippedStats('warrior', 5, []),
          DEFAULT_COMBAT_CONFIG,
          undefined,
          undefined,
          { loadout: { actives: ['heavyStrike', 'shieldSlam'] } },
        ),
      'on',
    );
    // Pretend it is the default loadout: shadow mode compares it with today's fight.
    const forged: EncounterSetup = {
      ...setup,
      kit: { ...setup.kit!, isDefault: true, start: 100 },
    };
    expect(() =>
      withSkillsPrototype(() => resolveFightDetailed(forged, 300, createRng('x')), 'shadow'),
    ).toThrow(SkillsReplayMismatch);
    expect(() => withSkillsPrototype(() => killDistribution(forged, 300), 'shadow')).toThrow(
      SkillsReplayMismatch,
    );
  });
});

describe('resources, cooldowns and damage over time on the timeline', () => {
  const setupWith = (
    c: ClassId,
    loadout: Loadout,
    level = 40,
    fragments = 0,
    enemy = 'risenFarmhand',
  ) =>
    withSkillsPrototype(() =>
      buildEncounter(
        getEnemy(enemy as never),
        level,
        c,
        level,
        deriveEquippedStats(c, level, []),
        DEFAULT_COMBAT_CONFIG,
        undefined,
        undefined,
        { loadout, fragments },
      ),
    );

  it('compiles resources from the class rules and the passive', () => {
    expect(setupWith('mage', { actives: ['firebolt', 'pyroblast'] }).kit!.start).toBe(100);
    const deep = setupWith('mage', { actives: ['firebolt', 'pyroblast'], passive: 'deepReserves' });
    expect(deep.kit!.start).toBe(140);
    expect(deep.kit!.rules.max).toBe(140);
    expect(setupWith('warrior', { actives: ['heavyStrike', 'shieldSlam'] }).kit!.start).toBe(0);
    expect(setupWith('hunter', { actives: ['aimedShot', 'quickShot'] }).kit!.start).toBe(20);
    // Fragments: what the last kill left, within the cap.
    expect(setupWith('warlock', { actives: ['shadowBolt', 'soulBurn'] }, 40, 2).kit!.start).toBe(2);
    expect(setupWith('warlock', { actives: ['shadowBolt', 'soulBurn'] }, 40, 9).kit!.start).toBe(3);
  });

  it('a spender replaces a basic attack only when it is ready, and the core keeps its cadence', () => {
    const s = setupWith('warrior', { actives: ['heavyStrike', 'charge', 'shieldSlam'] });
    const log: Parameters<typeof resolveFightDetailed>[4] = [];
    withSkillsPrototype(() =>
      resolveFightDetailed({ ...s, enemyHealth: 100_000 }, 100_000, createRng('cadence'), 0, log),
    );
    const attacks = log!.filter((e) => e.type === 'attack');
    // Attack 1 is Charge (a skill), every 4th is Heavy Strike, as today.
    expect(attacks[0]!.type === 'attack' && attacks[0]!.skill).toBe(true);
    attacks.forEach((a, k) => {
      if ((k + 1) % 4 === 0) expect(a.type === 'attack' && a.skill).toBe(true);
    });
    // Rage: 15 from Charge plus 4 an attack and 4 a blow; Shield Slam (50) fires once there is enough.
    const skills = attacks.filter((a) => a.type === 'attack' && a.skill).length;
    expect(skills).toBeGreaterThan(Math.floor(attacks.length / 4) + 1);
  });

  it('damage over time ticks on the fight’s pulse, feeds fragments and can make the kill', () => {
    const s = setupWith('warlock', { actives: ['shadowBolt', 'corruption'] });
    const kit = s.kit!;
    expect(kit.pulses).toBe(true);
    const tick = Math.max(1, Math.round(kit.dealt * 0.08));
    expect(kit.dots).toEqual([{ ticks: 12, damage: tick }]);
    const cast = kitAfterAttack(kit, kitStart(kit), 0, false, 500);
    expect(cast.dot).toEqual([12]);
    // While the curse runs it is not cast again.
    expect(kitSpenderFor(kit, cast, 2, 600, 1_000)).toBe(-1);
    const pulsed = kitPulse(kit, cast);
    expect(pulsed.damage).toBe(tick);
    expect(pulsed.state.dot).toEqual([11]);
    expect(pulsed.state.r).toBe(1); // a Soul Fragment from the curse's pulse
    // A foe that the first pulse finishes: the curse (60 %) lands at 999 ms, the tick at 1,000.
    const opener = Math.max(1, Math.round(kit.dealt * 0.6));
    const fight: EncounterSetup = {
      ...s,
      playerIntervalMs: 999,
      enemyHealth: opener + tick,
      enemyHit: 1,
      auto: { ...s.auto, critChance: 0 },
      skill: { ...s.skill, critChance: 0 },
      kit: { ...kit, critChance: 0 },
    };
    const outcome = withSkillsPrototype(() => resolveFightDetailed(fight, 1000, createRng('dot')));
    expect(outcome).toEqual({ kind: 'kill', offsetMs: PULSE_MS, enemyHits: expect.any(Number) });
    const exact = withSkillsPrototype(() => killDistribution(fight, 1000));
    expect(exact).toEqual([
      { offsetMs: 999, enemyHits: expect.any(Number), probability: 0, attack: 1 },
      { offsetMs: PULSE_MS, enemyHits: expect.any(Number), probability: 1, attack: 0 },
    ]);
  });

  it('carries Soul Fragments from kill to kill, and loses them on a death', () => {
    const i = farmInput('warlock', 'hollowDeep', 49, 47, 20, 'souls', {
      actives: ['shadowBolt', 'soulBurn'],
      passive: 'darkPact',
    });
    let last = '';
    const r = withSkillsPrototype(() =>
      simulateFarmingAggregate(i, { onCycle: (cycle) => (last = cycle.outcome) }),
    );
    expect(r.soulFragments).toBe(last === 'kill' ? 3 : 0);
    // The default loadout carries nothing and reports nothing.
    const d = withSkillsPrototype(() => simulateFarmingAggregate({ ...i, loadout: null }));
    expect(d.soulFragments).toBeUndefined();
  });
});

describe('the two simulations agree under kits', () => {
  const trials = 12_000;
  const compare = (setup: EncounterSetup, health: number) => {
    const detailedRng = createRng(`kit-detailed:${health}`);
    const sampledRng = createRng(`kit-sampled:${health}`);
    const distribution = withSkillsPrototype(() => killDistribution(setup, health));
    const total = distribution.reduce((s, e) => s + e.probability, 0);
    expect(total).toBeLessThanOrEqual(1 + 1e-9);
    const tally = () => ({ kill: 0, death: 0, timeout: 0, offset: 0 });
    const a = tally();
    const b = tally();
    const add = (t: ReturnType<typeof tally>, o: FightOutcome) => {
      t[o.kind]++;
      t.offset += o.offsetMs;
    };
    withSkillsPrototype(() => {
      for (let i = 0; i < trials; i++) {
        add(a, resolveFightDetailed(setup, health, detailedRng));
        add(b, sampleFight(setup, health, sampledRng, distribution));
      }
    });
    for (const k of ['kill', 'death', 'timeout'] as const)
      expect(Math.abs(a[k] - b[k]) / trials, k).toBeLessThan(0.015);
    expect(Math.abs(a.offset - b.offset) / Math.max(1, a.offset)).toBeLessThan(0.03);
  };

  for (const c of CLASS_IDS) {
    for (const [name, loadout] of [
      ['boss loadout', full[c]],
      ['farming loadout', farmingLoadout[c]],
    ] as const) {
      it(`per fight: ${c}, ${name}, a Hollow Deep foe and the Hollow Sovereign`, () => {
        const s = stats(c, 49, 47);
        for (const [enemy, level, fragments] of [
          ['hollowSentinel', 49, 0],
          ['hollowSovereign', 50, 2],
        ] as const) {
          const setup = withSkillsPrototype(() =>
            buildEncounter(
              getEnemy(enemy),
              level,
              c,
              49,
              deriveCharacterStats(c, 49, s.stats),
              DEFAULT_COMBAT_CONFIG,
              { skillDamage: s.modifiers.skillDamage, bossDamage: s.modifiers.bossDamage },
              { effects: s.effects },
              { loadout, fragments },
            ),
          );
          expect(setup.kit?.active).toBe(true);
          compare({ ...setup, maxFightMs: 30_000 }, setup.effects?.maxHealth ?? 2_000);
        }
      });
    }
  }

  it(
    'per window: kills, deaths and XP agree within 4 standard errors (150 seeds × 15 min)',
    SLOW,
    () => {
      const seeds = 150;
      const keys = ['kills', 'deaths', 'xpGained', 'encounters'] as const;
      const st = (v: number[]) => {
        const mean = v.reduce((s, x) => s + x, 0) / v.length;
        return { mean, variance: v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1) };
      };
      for (const c of CLASS_IDS) {
        const detailed: FarmingResult[] = [];
        const aggregate: FarmingResult[] = [];
        withSkillsPrototype(() => {
          for (let k = 0; k < seeds; k++) {
            const i = farmInput(c, 'hollowDeep', 49, 47, 15, `kit-window:${k}`, full[c]);
            detailed.push(simulateFarming(i, { maxEvents: 0 }));
            aggregate.push(simulateFarmingAggregate(i));
          }
        });
        for (const key of keys) {
          const a = st(detailed.map((r) => r[key]));
          const b = st(aggregate.map((r) => r[key]));
          const se = Math.sqrt(a.variance / seeds + b.variance / seeds);
          expect(Math.abs(a.mean - b.mean), `${c} ${key}`).toBeLessThanOrEqual(4 * se + 1e-9);
        }
      }
    },
  );

  it('settling more often gives the same result, Soul Fragments included', SLOW, () => {
    for (const c of CLASS_IDS) {
      for (const loadout of [full[c], farmingLoadout[c]]) {
        withSkillsPrototype(() => {
          const base = {
            character: { classId: c, level: 49, xp: 0 } as {
              classId: ClassId;
              level: number;
              xp: number;
            },
            equipment: gear(c, 47),
            areaId: 'hollowDeep' as const,
            seed: `split:${c}`,
            inventoryCount: 10_000,
            loadout,
          };
          const whole = settleFarming({ ...base, firstCycle: 0, durationMs: 40 * 60_000 });
          let character: typeof base.character & Record<string, unknown> = { ...base.character };
          let firstCycle = 0;
          let carry = 0;
          let kills = 0;
          for (let k = 0; k < 8; k++) {
            const part = settleFarming({
              ...base,
              character,
              firstCycle,
              durationMs: 5 * 60_000 + carry,
            });
            kills += part.kills;
            firstCycle += part.encounters;
            carry = part.unusedMs;
            character = {
              classId: c,
              level: part.level,
              xp: part.xp,
              health: part.health,
              momentum: part.momentum,
              ...(part.soulFragments !== undefined ? { soulFragments: part.soulFragments } : {}),
            };
          }
          expect(kills, `${c} ${loadout.actives[0]}`).toBe(whole.kills);
          expect(character.level).toBe(whole.level);
          expect(character.xp).toBe(whole.xp);
        });
      }
    }
  });
});
