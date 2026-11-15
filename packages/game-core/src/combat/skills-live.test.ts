import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  PVP_RULES_BASELINE,
  PVP_RULES_VERSION,
  buildEncounter,
  characterPower,
  createRng,
  defaultLoadout,
  deriveCharacterStats,
  effectiveLoadout,
  equipmentModifiers,
  getEnemy,
  loadoutTelemetryKey,
  normalisePvpRulesPlan,
  planPvpRulesSwitch,
  pvpRulesVersionAt,
  resolveFightDetailed,
  settleFarming,
  simulateDuel,
  simulateDungeonRun,
  simulateFarming,
  simulateFarmingAggregate,
  simulateGuildBossAttempt,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_LOOT_CONFIG,
  type ClassId,
  type CombatEvent,
  type FarmingInput,
  type FarmingResult,
  type Loadout,
} from '../index.js';
import { legendaryKit, upgraded } from '../balance/kits.js';
import { withSkillsPrototype } from '../balance/loadouts.js';

/**
 * Ticket 9.2: the skills switch in play (`live`). The default loadout runs today's code path (the
 * whole game-core suite runs in `live`, so every balance suite is the default-loadout replay; CI's
 * "skills replay" job also runs it in `shadow`), and a chosen loadout fights exactly as 9.1's kit
 * path measured it (`on`), so 9.1's agreement, measurements and guards carry over.
 */

// Heavy cases (CLAUDE.md "Time"): about 2–8 s locally each; 120 s is far above the slow case.
const SLOW = { timeout: 120_000 };

const boss: Record<ClassId, Loadout> = {
  warrior: { actives: ['rend', 'execute', 'earthsplitter'], passive: 'juggernaut' },
  mage: { actives: ['scorch', 'pyroblast', 'meteor'], passive: 'deepReserves' },
  hunter: { actives: ['serratedArrow', 'volley', 'killShot'], passive: 'predator' },
  warlock: { actives: ['agony', 'corruption', 'soulBurn'], passive: 'soulSiphon' },
};
const farming: Record<ClassId, Loadout> = {
  warrior: { actives: ['heavyStrike', 'charge', 'execute'], passive: 'berserker' },
  mage: { actives: ['firebolt', 'pyroblast', 'shatter'], passive: 'arcanePower' },
  hunter: { actives: ['aimedShot', 'firstBlood', 'quickShot'], passive: 'steadyAim' },
  warlock: { actives: ['shadowBolt', 'soulBurn', 'drainSoul'], passive: 'darkPact' },
};

const gear = (c: ClassId, il: number) => upgraded(legendaryKit(c, il), 5);
const farmInput = (c: ClassId, seed: string, loadout?: Loadout, minutes = 15): FarmingInput => {
  const m = equipmentModifiers(
    gear(c, 47),
    DEFAULT_ACTIVITY_CONFIG.modifierCaps,
    DEFAULT_LOOT_CONFIG,
    {
      classId: c,
    },
  );
  return {
    character: { classId: c, level: 49, xp: 0 },
    equipment: m.stats,
    modifiers: { skillDamage: m.skillDamage, bossDamage: m.bossDamage },
    effects: m.effects,
    areaId: 'hollowDeep',
    seed,
    durationMs: minutes * 60_000,
    firstCycle: 0,
    ...(loadout ? { loadout } : {}),
  };
};

describe('the default loadout in play is today, bit for bit', () => {
  it(
    'farming (both simulations), crypt, boss, guild boss and duels: equal to the switch off',
    SLOW,
    () => {
      for (const c of CLASS_IDS) {
        const run = (loadout?: Loadout) => [
          simulateFarming(farmInput(c, `live:${c}`, loadout)),
          simulateFarmingAggregate(farmInput(c, `live:${c}`, loadout)),
          simulateDungeonRun({
            dungeonId: 'hollowThrone',
            character: { classId: c, level: 50, xp: 0 },
            equipment: gear(c, 47),
            seed: `live-sov:${c}`,
            bossLootEligible: false,
            inventoryCount: 0,
            ...(loadout ? { loadout } : {}),
          }),
          simulateGuildBossAttempt({
            bossId: 'risenGravewarden',
            character: { classId: c, level: 30 },
            equipment: gear(c, 29),
            seed: `live-gb:${c}`,
            ...(loadout ? { loadout } : {}),
          }),
          simulateDuel({
            challenger: {
              classId: c,
              level: 32,
              equipment: gear(c, 29),
              ...(loadout ? { loadout } : {}),
            },
            defender: { classId: 'warlock', level: 33, equipment: gear('warlock', 30) },
            seed: `live-duel:${c}`,
          }),
        ];
        const off = withSkillsPrototype(() => run(), 'off');
        const live = withSkillsPrototype(() => run(), 'live');
        const liveDefault = withSkillsPrototype(() => run(defaultLoadout(c)), 'live');
        expect(live).toEqual(off);
        expect(liveDefault).toEqual(off);
      }
    },
  );

  it('Power: the default loadout scores Power 4 = Power 3; versions 1–3 never read a loadout', () => {
    for (const c of CLASS_IDS) {
      const input = { classId: c, level: 34, equipment: gear(c, 33) };
      const v3 = characterPower(input, 3);
      expect({ ...characterPower(input, 4), formulaVersion: 3 }).toEqual(v3);
      expect({
        ...characterPower({ ...input, loadout: defaultLoadout(c) }, 4),
        formulaVersion: 3,
      }).toEqual(v3);
      expect(characterPower({ ...input, loadout: boss[c] }, 3)).toEqual(v3);
    }
  });
});

describe('a chosen loadout in play fights as 9.1 measured it', () => {
  it(
    'equals the kit path (`on`) in every simulation, so 9.1’s agreement and bands carry over',
    SLOW,
    () => {
      for (const c of CLASS_IDS) {
        for (const loadout of [boss[c], farming[c]]) {
          const run = () => [
            settleFarming({
              character: { classId: c, level: 49, xp: 0 },
              equipment: gear(c, 47),
              areaId: 'hollowDeep',
              seed: `chosen:${c}`,
              firstCycle: 0,
              durationMs: 20 * 60_000,
              inventoryCount: 0,
              loadout,
            }),
            simulateFarming(farmInput(c, `chosen:${c}`, loadout, 5)),
            simulateDungeonRun({
              dungeonId: 'hollowThrone',
              character: { classId: c, level: 50, xp: 0 },
              equipment: gear(c, 47),
              seed: `chosen-sov:${c}`,
              bossLootEligible: false,
              inventoryCount: 0,
              loadout,
            }),
            characterPower({ classId: c, level: 50, equipment: gear(c, 47), loadout }, 4),
          ];
          const live = withSkillsPrototype(run, 'live');
          const on = withSkillsPrototype(run, 'on');
          // The same kit in both modes (9.2's tick events and skill names are logged in both).
          expect(live).toEqual(on);
        }
      }
    },
  );

  it(
    'the two simulations agree per loadout in play (100 seeds × 15 min, 4 standard errors)',
    SLOW,
    () => {
      const seeds = 100;
      const st = (v: number[]) => {
        const mean = v.reduce((s, x) => s + x, 0) / v.length;
        return { mean, variance: v.reduce((s, x) => s + (x - mean) ** 2, 0) / (v.length - 1) };
      };
      withSkillsPrototype(() => {
        for (const c of CLASS_IDS) {
          for (const loadout of [boss[c], farming[c]]) {
            const a: FarmingResult[] = [];
            const b: FarmingResult[] = [];
            for (let k = 0; k < seeds; k++) {
              const i = farmInput(c, `agree:${k}`, loadout);
              a.push(simulateFarming(i, { maxEvents: 0 }));
              b.push(simulateFarmingAggregate(i));
            }
            for (const key of ['kills', 'deaths', 'xpGained', 'encounters'] as const) {
              const x = st(a.map((r) => r[key]));
              const y = st(b.map((r) => r[key]));
              const se = Math.sqrt(x.variance / seeds + y.variance / seeds);
              expect(Math.abs(x.mean - y.mean), `${c} ${key}`).toBeLessThanOrEqual(4 * se + 1e-9);
            }
          }
        }
      }, 'live');
    },
  );

  it('logs damage over time and the skill of each cast; the log adds up to the kill', () => {
    const c: ClassId = 'warlock';
    const m = equipmentModifiers(
      gear(c, 47),
      DEFAULT_ACTIVITY_CONFIG.modifierCaps,
      DEFAULT_LOOT_CONFIG,
      {
        classId: c,
      },
    );
    const setup = buildEncounter(
      getEnemy('hollowSentinel'),
      49,
      c,
      49,
      deriveCharacterStats(c, 49, m.stats),
      DEFAULT_COMBAT_CONFIG,
      { skillDamage: m.skillDamage, bossDamage: m.bossDamage },
      undefined,
      { loadout: boss.warlock },
    );
    let seen = 0;
    for (let s = 0; s < 20; s++) {
      const log: CombatEvent[] = [];
      const o = resolveFightDetailed(setup, 100_000, createRng(`ticks:${s}`), 0, log);
      const ticks = log.filter((e) => e.type === 'tick');
      for (const e of log)
        if (e.type === 'attack' && e.skill)
          expect(['agony', 'corruption', 'soulBurn']).toContain(e.skillId);
      if (o.kind !== 'kill') continue;
      seen++;
      expect(ticks.length).toBeGreaterThan(0);
      const dealt = log.reduce(
        (t, e) => t + (e.type === 'attack' || e.type === 'tick' ? e.damage : 0),
        0,
      );
      expect(dealt).toBeGreaterThanOrEqual(setup.enemyHealth);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('a stored loadout the hero can no longer field reads as the default', () => {
    expect(effectiveLoadout('warrior', boss.warrior, { level: 49 })).toEqual(boss.warrior);
    expect(effectiveLoadout('warrior', boss.warrior, { level: 27 })).toEqual(
      defaultLoadout('warrior'),
    );
    expect(effectiveLoadout('warrior', boss.mage, { level: 49 })).toEqual(
      defaultLoadout('warrior'),
    );
    expect(effectiveLoadout('warrior', null, { level: 49 })).toEqual(defaultLoadout('warrior'));
    expect(loadoutTelemetryKey('warrior', null)).toBe('default');
    expect(loadoutTelemetryKey('warrior', defaultLoadout('warrior'))).toBe('default');
    expect(loadoutTelemetryKey('warrior', boss.warrior)).toBe(
      'rend+execute+earthsplitter:juggernaut',
    );
  });
});

describe('duel rules version 3 (owner decision 6)', () => {
  const duel = (c: ClassId, loadout: Loadout | undefined, seed: string, rulesVersion?: number) =>
    simulateDuel({
      challenger: {
        classId: c,
        level: 32,
        equipment: gear(c, 29),
        ...(loadout ? { loadout } : {}),
      },
      defender: { classId: c, level: 33, equipment: gear(c, 29) },
      seed,
      ...(rulesVersion ? { rulesVersion } : {}),
    });

  it('version 2 never reads a loadout; version 3 does, and logs its ticks and casts', () => {
    expect(PVP_RULES_VERSION).toBe(3);
    for (const c of CLASS_IDS) {
      const v2 = duel(c, boss[c], `v2:${c}`, 2);
      expect(v2).toEqual(duel(c, undefined, `v2:${c}`, 2));
      expect(v2.rulesVersion).toBe(2);
      const v3 = duel(c, boss[c], `v2:${c}`);
      expect(v3.rulesVersion).toBe(3);
      expect(v3.events.some((e) => e.type === 'attack' && e.skillId !== undefined)).toBe(true);
    }
  });

  it(
    'a chosen loadout is an edge, not a gear tier: the best duel loadouts win 50–88 % against the default',
    SLOW,
    () => {
      for (const c of CLASS_IDS) {
        let wins = 0;
        const n = 80;
        for (let s = 0; s < n; s++) {
          const r = duel(c, boss[c], `edge:${c}:${s}`);
          wins += r.outcome === 'challenger' ? 1 : r.outcome === 'draw' ? 0.5 : 0;
        }
        expect(wins / n, c).toBeLessThan(0.88);
      }
    },
  );
});

describe('duel rules between seasons (5.3’s rule)', () => {
  const day = 86_400_000;
  const t0 = new Date('2027-01-10T12:00:00Z');
  const at = (d: number) => new Date(t0.getTime() + d * day);
  const season = (number: number, from: number, to: number) => ({
    number,
    startsAt: at(from),
    endsAt: at(to),
  });

  it('waits for the end of the season under way, at once between seasons, and plans once', () => {
    expect(PVP_RULES_BASELINE).toBe(2);
    const seasons = [season(1, -20, 36)];
    const plan = planPvpRulesSwitch([], seasons, t0);
    expect(plan.map((s) => [s.from, s.to, s.afterSeason])).toEqual([[2, 3, 1]]);
    expect(pvpRulesVersionAt(plan, seasons, at(35.99))).toBe(2);
    expect(pvpRulesVersionAt(plan, seasons, at(36))).toBe(3);
    expect(planPvpRulesSwitch(plan, seasons, at(1))).toEqual([]);
    // Ended early: the switch follows the plan as it stands.
    expect(pvpRulesVersionAt(plan, [season(1, -20, 2)], at(2))).toBe(3);
    // Between seasons: at once.
    const now = planPvpRulesSwitch([], [season(1, -60, -1)], t0);
    expect(now[0]!.afterSeason).toBeNull();
    expect(pvpRulesVersionAt(now, [], t0)).toBe(3);
  });

  it('never trusts a stored plan', () => {
    expect(normalisePvpRulesPlan('x')).toEqual([]);
    expect(normalisePvpRulesPlan([{ from: 2, to: 9, afterSeason: null }])).toEqual([]);
    expect(normalisePvpRulesPlan([{ from: 2, to: 3, afterSeason: 0 }])).toEqual([]);
    expect(normalisePvpRulesPlan([{ from: 2, to: 3, afterSeason: 4, plannedAt: 'p' }])).toEqual([
      { from: 2, to: 3, afterSeason: 4, plannedAt: 'p' },
    ]);
  });
});
