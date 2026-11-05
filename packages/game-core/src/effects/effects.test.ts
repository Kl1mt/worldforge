import { describe, expect, it } from 'vitest';
import {
  CLASS_IDS,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_EFFECT_CAPS,
  DEFAULT_LOOT_CONFIG,
  EFFECTS,
  ITEM_BASES,
  ITEM_SETS,
  MYTHIC_ITEMS,
  attackHit,
  buildEncounter,
  combineEffects,
  createRng,
  describeEffect,
  deriveCharacterStats,
  emptyCombatEffects,
  equipmentModifiers,
  findEffect,
  generateItem,
  getEnemy,
  getItemBase,
  getLootTable,
  killDistribution,
  legendaryEffectPool,
  resolveDungeonFight,
  resolveFightDetailed,
  sampleFight,
  settleFarming,
  simulateFarming,
  simulateFarmingAggregate,
  validateItem,
  type ClassId,
  type CombatEffects,
  type DungeonEvent,
  type EncounterSetup,
  type EnemyId,
  type FarmingInput,
  type FarmingResult,
  type FightOutcome,
  type GeneratedItem,
  type SettleFarmingInput,
} from '../index.js';

/** A synthetic item carrying one effect (equipment is not validated). */
export const effectItem = (effectId: string, effectRoll = 1): GeneratedItem => ({
  seed: 1,
  baseId: 'iron-ring',
  rarityId: 'legendary',
  itemLevel: 1,
  affixes: [],
  effectId,
  effectRoll,
});

const effectsOf = (classId: ClassId, ...ids: string[]): CombatEffects =>
  combineEffects(
    ids.map((effectId) => ({ effectId, roll: 1 })),
    classId,
  );

describe('effect registry', () => {
  it('has unique ids, valid kinds and text placeholders that all resolve', () => {
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(EFFECTS.length);
    for (const e of EFFECTS) {
      expect(['legendary', 'mythic', 'set']).toContain(e.kind);
      expect(e.components.length, e.id).toBeGreaterThan(0);
      for (const roll of [0, 0.5, 1]) {
        const text = describeEffect({ effectId: e.id, roll });
        expect(text, e.id).not.toMatch(/[{}]/);
        expect(text.length, e.id).toBeGreaterThan(10);
      }
      if (e.kind === 'legendary') {
        expect(e.slots?.length, e.id).toBeGreaterThan(0);
        expect(e.weight, e.id).toBeGreaterThan(0);
      }
    }
  });

  it('has one class effect per class and a Legendary pool for every slot that drops', () => {
    for (const c of CLASS_IDS) {
      expect(EFFECTS.filter((e) => e.kind === 'legendary' && e.classId === c)).toHaveLength(1);
    }
    for (const base of ITEM_BASES) {
      expect(legendaryEffectPool(base).length, base.id).toBeGreaterThanOrEqual(2);
    }
  });

  it('describes rolled values', () => {
    expect(describeEffect({ effectId: 'headsmans-due', roll: 0 })).toBe(
      'Deal 40 % more damage to enemies below 30 % health.',
    );
    expect(describeEffect({ effectId: 'headsmans-due', roll: 1 })).toBe(
      'Deal 80 % more damage to enemies below 30 % health.',
    );
    expect(describeEffect({ effectId: 'bloodrush', roll: 0.5 })).toContain('2.5 % attack speed');
    expect(describeEffect({ effectId: 'bloodrush', roll: 0.5 })).toContain('every 10 s');
    expect(describeEffect({ effectId: 'nope', roll: 1 })).toBe('');
  });

  it('has six named Mythics on their own stronger bases with Mythic signatures', () => {
    expect(MYTHIC_ITEMS).toHaveLength(6);
    expect(new Set(MYTHIC_ITEMS.map((m) => m.effectId)).size).toBe(6);
    const total = (b: ReturnType<typeof getItemBase>, level: number) =>
      b.stats.reduce((s, x) => s + x.base + x.perLevel * (level - 1), 0);
    for (const m of MYTHIC_ITEMS) {
      const base = getItemBase(m.baseId);
      expect(base.unique, m.id).toBe(true);
      expect(findEffect(m.effectId)?.kind, m.id).toBe('mythic');
      // Stronger than every regular tier-3 base of the same slot the same classes can use.
      const peers = ITEM_BASES.filter(
        (b) =>
          !b.unique &&
          b.tier === 3 &&
          b.slot === base.slot &&
          b.classes.some((c) => base.classes.includes(c)),
      );
      expect(peers.length, m.id).toBeGreaterThan(0);
      for (const p of peers)
        expect(total(base, 20), `${m.id} vs ${p.id}`).toBeGreaterThan(total(p, 20));
      // A class signature sits on a base only that class can use.
      const cls = findEffect(m.effectId)!.classId;
      if (cls) expect(base.classes, m.id).toEqual([cls]);
    }
  });
});

describe('combineEffects', () => {
  it('maps the roll into the range and caps stacked sources', () => {
    expect(combineEffects([{ effectId: 'headsmans-due', roll: 0.5 }], 'warrior').execute).toEqual({
      threshold: 0.3,
      bonus: 0.6,
    });
    const many = combineEffects(
      Array.from({ length: 5 }, () => ({ effectId: 'headsmans-due', roll: 1 })),
      'warrior',
    );
    expect(many.execute.bonus).toBe(DEFAULT_EFFECT_CAPS.execute.bonus);
    const thorns = combineEffects(
      Array.from({ length: 5 }, () => ({ effectId: 'bramblemail', roll: 1 })),
      'mage',
    );
    expect(thorns.thorns).toBe(DEFAULT_EFFECT_CAPS.thorns);
  });

  it('counts class effects only for their class', () => {
    expect(effectsOf('warrior', 'mana-surge')).toEqual(emptyCombatEffects());
    expect(effectsOf('mage', 'mana-surge').skillSurge).toBe(1.3);
    expect(effectsOf('hunter', 'widows-kiss').critBurn).toBe(0.5);
    expect(effectsOf('mage', 'widows-kiss')).toEqual(emptyCombatEffects());
  });

  it('scales magnitudes with strength but not thresholds, stacks or decay (Void, ticket 3.5)', () => {
    const fx = combineEffects(
      [
        { effectId: 'headsmans-due', roll: 0, strength: 1.5 },
        { effectId: 'bloodrush', roll: 0, strength: 1.5 },
      ],
      'warrior',
    );
    expect(fx.execute).toEqual({ threshold: 0.3, bonus: 0.6 });
    expect(fx.bloodrush).toEqual({ perStack: 0.03, maxStacks: 5, decayMs: 10_000 });
  });

  it('ignores unknown effects and items without one', () => {
    const m = equipmentModifiers(
      [{ ...effectItem('gone'), effectRoll: null }],
      undefined,
      undefined,
      {
        classId: 'warrior',
      },
    );
    expect(m.effects).toEqual(emptyCombatEffects());
    const plain = equipmentModifiers([effectItem('emberbrand')]);
    expect(plain.effects).toEqual(emptyCombatEffects());
    expect(plain.effectInstances).toEqual([{ effectId: 'emberbrand', roll: 1 }]);
  });

  it('takes extra instances (set bonuses, ticket 3.3)', () => {
    const m = equipmentModifiers([], undefined, undefined, {
      classId: 'warrior',
      extraEffects: [{ effectId: 'tyrants-bane', roll: 0 }],
    });
    expect(m.effects.bossSlayer).toBe(0.1);
  });
});

describe('Legendary and Mythic generation', () => {
  const sample = (n: number, params: Omit<Parameters<typeof generateItem>[0], 'seed'>) => {
    const rng = createRng(`gen:${JSON.stringify(params)}`);
    return Array.from({ length: n }, () =>
      generateItem({ ...params, seed: rng.int(0, 2 ** 32 - 1) })!,
    );
  };

  it('gives every Legendary one valid effect for its slot and class, on a 0.05 roll grid', () => {
    for (const classId of CLASS_IDS) {
      const items = sample(1500, {
        itemLevel: 20,
        rarityId: 'legendary',
        classId,
        lootTable: getLootTable('blackwater'),
      });
      const seen = new Set<string>();
      for (const item of items) {
        expect(validateItem(item), JSON.stringify(item)).toEqual([]);
        const effect = findEffect(item.effectId!)!;
        expect(effect.kind).toBe('legendary');
        expect(effect.slots).toContain(getItemBase(item.baseId).slot);
        if (effect.classId) expect(effect.classId).toBe(classId);
        expect(Math.round(item.effectRoll! * 20)).toBeCloseTo(item.effectRoll! * 20, 9);
        seen.add(effect.id);
      }
      // Every effect possible for the class shows up, including its class effect.
      const possible = EFFECTS.filter(
        (e) => e.kind === 'legendary' && (e.classId === undefined || e.classId === classId),
      );
      for (const e of possible) expect(seen, `${classId} ${e.id}`).toContain(e.id);
    }
  });

  it('gives a Legendary its full affix count plus the effect (drawn last, after the affixes)', () => {
    const rng = createRng('legendary-order');
    for (let i = 0; i < 300; i++) {
      const seed = rng.int(0, 2 ** 32 - 1);
      const params = {
        seed,
        itemLevel: 18,
        rarityId: 'legendary' as const,
        classId: 'mage' as const,
      };
      const item = generateItem(params)!;
      const { effectId, effectRoll, ...rest } = item;
      expect(effectId).toBeDefined();
      expect(effectRoll).toBeDefined();
      expect(rest.affixes).toHaveLength(DEFAULT_LOOT_CONFIG.rarities.legendary.affixCount);
    }
  });

  it('never puts effects on other rarities', () => {
    for (const rarityId of ['common', 'uncommon', 'rare', 'epic'] as const) {
      for (const item of sample(300, { itemLevel: 18, rarityId, classId: 'hunter' })) {
        expect(item.effectId).toBeUndefined();
        expect(item.mythicId).toBeUndefined();
      }
    }
  });

  it('drops named Mythics only from late-game tables; elsewhere a Mythic roll is a Legendary', () => {
    const allMythic = {
      ...DEFAULT_LOOT_CONFIG,
      rarities: {
        ...DEFAULT_LOOT_CONFIG.rarities,
        common: { ...DEFAULT_LOOT_CONFIG.rarities.common, weight: 0 },
        uncommon: { ...DEFAULT_LOOT_CONFIG.rarities.uncommon, weight: 0 },
        rare: { ...DEFAULT_LOOT_CONFIG.rarities.rare, weight: 0 },
        epic: { ...DEFAULT_LOOT_CONFIG.rarities.epic, weight: 0 },
        legendary: { ...DEFAULT_LOOT_CONFIG.rarities.legendary, weight: 0 },
      },
    };
    const rng = createRng('mythic-sources');
    for (const tableId of ['abandonedFields', 'blackwater', 'namelessCrypt']) {
      for (let i = 0; i < 200; i++) {
        const item = generateItem(
          {
            seed: rng.int(0, 2 ** 32 - 1),
            itemLevel: 17,
            lootTable: getLootTable(tableId),
            classId: 'warrior',
          },
          allMythic,
        )!;
        expect(item.rarityId, tableId).toBe('legendary');
        expect(item.mythicId).toBeUndefined();
        // The crypt turns some of those Legendaries into set pieces (ticket 3.3), without effect.
        expect(item.effectId !== undefined || item.setId !== undefined, tableId).toBe(true);
      }
    }
    for (const classId of CLASS_IDS) {
      const seen = new Set<string>();
      for (const tableId of ['sunkenAbbey', 'gravewarden']) {
        for (let i = 0; i < 200; i++) {
          const item = generateItem(
            {
              seed: rng.int(0, 2 ** 32 - 1),
              itemLevel: 17,
              lootTable: getLootTable(tableId),
              classId,
            },
            allMythic,
          )!;
          expect(item.rarityId).toBe('mythic');
          const mythic = MYTHIC_ITEMS.find((m) => m.id === item.mythicId)!;
          expect(item.baseId).toBe(mythic.baseId);
          expect(item.effectId).toBe(mythic.effectId);
          expect(item.effectRoll).toBeUndefined();
          expect(getItemBase(item.baseId).classes).toContain(classId);
          expect(validateItem(item)).toEqual([]);
          seen.add(mythic.id);
        }
      }
      // The two all-class Mythics plus the class's own.
      expect(seen.size, classId).toBe(3);
    }
  });

  it('keeps Mythics extremely rare: under one per 1,000 Sunken Abbey drops', () => {
    const rng = createRng('mythic-rate');
    let mythics = 0;
    let legendaries = 0;
    const n = 40_000;
    for (let i = 0; i < n; i++) {
      const item = generateItem({
        seed: rng.int(0, 2 ** 32 - 1),
        itemLevel: 20,
        lootTable: getLootTable('sunkenAbbey'),
        classId: 'warlock',
      })!;
      if (item.rarityId === 'mythic') mythics++;
      if (item.rarityId === 'legendary') legendaries++;
    }
    expect(mythics / n).toBeLessThan(0.001);
    expect(mythics).toBeGreaterThan(0);
    expect(legendaries / n).toBeGreaterThan(0.003);
  });

  it('validation rejects forged effects', () => {
    const legendary = generateItem({
      seed: 7,
      itemLevel: 18,
      rarityId: 'legendary',
      classId: 'warrior',
    })!;
    expect(validateItem(legendary)).toEqual([]);
    expect(validateItem({ ...legendary, effectRoll: 0.33 }).join()).toMatch(/invalid roll/);
    expect(validateItem({ ...legendary, effectId: 'starfall' }).join()).toMatch(/not allowed/);
    expect(
      validateItem({
        ...legendary,
        rarityId: 'epic',
        affixes: legendary.affixes.slice(0, 3),
      }).join(),
    ).toMatch(/on a epic item/);
    expect(validateItem({ ...legendary, effectId: 'nope' }).join()).toMatch(/unknown effect/);
    const mythic: GeneratedItem = {
      seed: 1,
      baseId: 'widowmaker',
      rarityId: 'mythic',
      itemLevel: 18,
      affixes: [],
      effectId: 'widows-kiss',
      mythicId: 'widowmaker',
    };
    expect(validateItem(mythic).filter((e) => !e.startsWith('expected'))).toEqual([]);
    const unnamed: GeneratedItem = { ...mythic };
    delete unnamed.mythicId;
    expect(validateItem(unnamed).join()).toMatch(/without its mythic/);
    expect(validateItem({ ...mythic, effectId: 'starfall' }).join()).toMatch(/needs effect/);
    // Pre-3.2 stat-only Legendaries and Mythics stay valid.
    const old: GeneratedItem = { ...legendary };
    delete old.effectId;
    delete old.effectRoll;
    expect(validateItem(old)).toEqual([]);
  });
});

/** A setup for `classId` at `level` against `enemyId` with the given effects. */
function setupWith(
  classId: ClassId,
  level: number,
  enemyId: EnemyId,
  fx: CombatEffects,
  momentum = 0,
): EncounterSetup {
  return buildEncounter(
    getEnemy(enemyId),
    level,
    classId,
    level,
    deriveCharacterStats(classId, level),
    DEFAULT_COMBAT_CONFIG,
    undefined,
    { effects: fx, momentum },
  );
}

describe('effects in a fight', () => {
  it('prices hits through one function', () => {
    const plain = setupWith('warrior', 10, 'cryptGhoul', emptyCombatEffects());
    expect(plain.effects).toBeUndefined();
    const fx = setupWith('warrior', 10, 'cryptGhoul', effectsOf('warrior', 'headsmans-due'));
    const full = attackHit(fx, 1, false, 100, fx.enemyHealth);
    const low = attackHit(fx, 1, false, 100, fx.effects!.executeHealth);
    expect(full.normal).toBe(plain.auto.normal);
    expect(low.normal).toBe(Math.round(fx.effects!.dealt * 1.8));
    // Fortitude needs the hero's health, rage the missing health.
    const fort = setupWith('mage', 10, 'cryptGhoul', effectsOf('mage', 'unbroken'));
    const max = fort.effects!.maxHealth;
    expect(attackHit(fort, 1, false, max, 1000).normal).toBeGreaterThan(
      attackHit(fort, 1, false, Math.floor(max * 0.7), 1000).normal,
    );
    const rage = setupWith(
      'warrior',
      10,
      'cryptGhoul',
      effectsOf('warrior', 'rage-fuelled-strikes'),
    );
    const m = rage.effects!.maxHealth;
    expect(attackHit(rage, 4, false, Math.floor(m * 0.4), 1000).normal).toBeGreaterThan(
      attackHit(rage, 4, false, m, 1000).normal,
    );
    expect(attackHit(rage, 4, false, m, 1000).normal).toBe(rage.skill.normal);
    // Surge: a crit turns the next attack into the skill; the opener is always the skill.
    const surge = setupWith('mage', 10, 'cryptGhoul', effectsOf('mage', 'mana-surge'));
    expect(attackHit(surge, 1, true, 1, 1000).skill).toBe(true);
    expect(attackHit(surge, 1, false, 1, 1000).skill).toBe(false);
    const opener = setupWith('hunter', 10, 'cryptGhoul', effectsOf('hunter', 'ambush'));
    expect(attackHit(opener, 1, false, 1, 1000).skill).toBe(true);
    expect(attackHit(opener, 2, false, 1, 1000).skill).toBe(false);
  });

  it('bloodrush stacks speed up attacks, boss slayer only hits bosses', () => {
    const fx = effectsOf('hunter', 'bloodrush');
    const none = setupWith('hunter', 10, 'cryptGhoul', fx, 0);
    const five = setupWith('hunter', 10, 'cryptGhoul', fx, 5);
    expect(five.playerIntervalMs).toBeLessThan(none.playerIntervalMs);
    const slayer = effectsOf('warrior', 'tyrants-bane');
    expect(setupWith('warrior', 16, 'gravewarden', slayer).auto.normal).toBeGreaterThan(
      setupWith('warrior', 16, 'gravewarden', emptyCombatEffects()).auto.normal,
    );
    expect(setupWith('warrior', 16, 'cryptGhoul', slayer)).toEqual(
      setupWith('warrior', 16, 'cryptGhoul', emptyCombatEffects()),
    );
  });
});

/** Every legendary and mythic effect, each on the class it is for (or every class). */
const EFFECT_CASES: [string, ClassId][] = EFFECTS.filter((e) => e.kind !== 'set').flatMap((e) =>
  (e.classId ? [e.classId] : CLASS_IDS).map((c) => [e.id, c] as [string, ClassId]),
);

const SET_CASES: [string, ClassId][] = ITEM_SETS.flatMap((x) =>
  CLASS_IDS.map((c) => [x.id, c] as [string, ClassId]),
);

describe('sampled fights match detailed fights with effects', () => {
  const trials = 12_000;
  const fights: [EnemyId, number, number][] = [
    ['cryptGhoul', 14, 1],
    ['fallenKnight', 18, 0.6],
  ];

  const checkFights = (effectId: string, classId: ClassId, fx: CombatEffects) => {
    for (const [enemyId, level, healthShare] of fights) {
      const setup = setupWith(classId, level, enemyId, fx, 3);
      const health = Math.max(
        1,
        Math.floor(deriveCharacterStats(classId, level).health * healthShare),
      );
      const distribution = killDistribution(setup, health);
      const total = distribution.reduce((s, e) => s + e.probability, 0);
      expect(total).toBeLessThanOrEqual(1 + 1e-9);
      const a = { kill: 0, death: 0, timeout: 0, hits: 0, offset: 0 };
      const b = { ...a };
      const add = (t: typeof a, o: FightOutcome) => {
        t[o.kind]++;
        t.hits += o.enemyHits;
        t.offset += o.offsetMs;
      };
      const dRng = createRng(`d:${effectId}:${classId}:${enemyId}`);
      const sRng = createRng(`s:${effectId}:${classId}:${enemyId}`);
      for (let i = 0; i < trials; i++) {
        add(a, resolveFightDetailed(setup, health, dRng));
        add(b, sampleFight(setup, health, sRng, distribution));
      }
      const label = `${effectId} ${classId} ${enemyId}`;
      for (const k of ['kill', 'death', 'timeout'] as const) {
        expect(Math.abs(a[k] - b[k]) / trials, `${label} ${k}`).toBeLessThan(0.02);
      }
      expect(Math.abs(a.offset - b.offset) / Math.max(1, a.offset), label).toBeLessThan(0.02);
      expect(Math.abs(a.hits - b.hits) / Math.max(1, a.hits), label).toBeLessThan(0.03);
    }
  };

  it.each(EFFECT_CASES)('%s (%s)', (effectId, classId) => {
    checkFights(effectId, classId, effectsOf(classId, effectId));
  });

  // Ticket 3.3: a full set (all its bonuses at once), the way `setBonusInstances` passes them.
  it.each(SET_CASES)('full set %s (%s)', (setId, classId) => {
    const set = ITEM_SETS.find((x) => x.id === setId)!;
    checkFights(setId, classId, effectsOf(classId, ...set.bonuses.map((b) => b.effectId)));
  });

  it('agrees exactly when nothing is random (thorns kills included)', () => {
    for (const [effectId, classId] of EFFECT_CASES) {
      for (const share of [1, 0.5, 0.2]) {
        const base = setupWith(classId, 15, 'fallenKnight', effectsOf(classId, effectId), 2);
        const s: EncounterSetup = {
          ...base,
          auto: { ...base.auto, critChance: 0 },
          skill: { ...base.skill, critChance: 0 },
          ...(base.effects
            ? { effects: { ...base.effects, critChance: 0, skillBonusCrit: 0 } }
            : {}),
        };
        const health = Math.max(1, Math.floor(deriveCharacterStats(classId, 15).health * share));
        expect(sampleFight(s, health, createRng(1), killDistribution(s, health)), effectId).toEqual(
          resolveFightDetailed(s, health, createRng(1)),
        );
      }
    }
  });

  it('thorns can kill between hero attacks, in both simulations', () => {
    const base = setupWith('warrior', 10, 'cryptGhoul', effectsOf('warrior', 'bramblemail'));
    const s: EncounterSetup = {
      ...base,
      enemyHealth: base.effects!.thornsDamage,
      playerIntervalMs: base.enemyIntervalMs * 3,
      auto: { normal: 1, crit: 1, critChance: 0 },
      skill: { normal: 1, crit: 1, critChance: 0 },
      effects: { ...base.effects!, critChance: 0, dealt: 0.4, raw: 0.4 },
    };
    const outcome = resolveFightDetailed(s, 10_000, createRng(1));
    expect(outcome).toEqual({ kind: 'kill', offsetMs: s.enemyIntervalMs, enemyHits: 1 });
    expect(sampleFight(s, 10_000, createRng(1), killDistribution(s, 10_000))).toEqual(outcome);
    const log: DungeonEvent[] = [];
    expect(resolveDungeonFight(s, 10_000, createRng(1), 0, log).kind).toBe('kill');
    expect(log.map((e) => e.type)).toEqual(['enemyAttack', 'thorns']);
  });
});

describe('farming windows with effects', () => {
  const MIN = 60_000;
  const stats = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
    return { mean, variance };
  };
  const keys = ['kills', 'deaths', 'xpGained', 'damageTaken', 'encounters', 'momentum'] as const;

  it.each([
    ['warrior', 'carrion-feast', 'rage-fuelled-strikes'],
    ['mage', 'mana-surge', 'unbroken'],
    ['hunter', 'bloodrush', 'ambush'],
    ['warlock', 'soul-rot', 'bramblemail'],
    ['warrior', 'endless-hunger', 'headsmans-due'],
    ['mage', 'starfall', 'emberbrand'],
    // Ticket 3.3: full sets (every bonus) next to an item effect.
    ['warrior', 'vigil-tidebound,vigil-hold-the-line,vigil-undertow', 'rage-fuelled-strikes'],
    ['mage', 'choir-kindled,choir-hymn-of-cinders,choir-last-rite', 'emberbrand'],
    ['hunter', 'bloodmoon-scent,bloodmoon-long-hunt', 'carrion-feast'],
  ] as const)('%s with %s + %s: aggregate matches detailed', (classId, a, b) => {
    const seeds = 150;
    const effects = effectsOf(classId, ...a.split(','), b);
    const detailed: FarmingResult[] = [];
    const aggregate: FarmingResult[] = [];
    for (let s = 0; s < seeds; s++) {
      const input: FarmingInput = {
        character: { classId, level: 13, xp: 0, health: 60 },
        areaId: 'blackwater',
        seed: `fx-${s}`,
        durationMs: 15 * MIN,
        effects,
      };
      detailed.push(simulateFarming(input, { maxEvents: 0 }));
      aggregate.push(simulateFarmingAggregate(input));
    }
    for (const key of keys) {
      const x = stats(detailed.map((r) => r[key]));
      const y = stats(aggregate.map((r) => r[key]));
      const se = Math.sqrt(x.variance / seeds + y.variance / seeds);
      expect(Math.abs(x.mean - y.mean), key).toBeLessThanOrEqual(4 * se + 1e-9);
    }
  });

  it('settles exactly the same in one window or many small ones (bloodrush and life on kill)', () => {
    const equipment = [
      effectItem('endless-hunger'),
      effectItem('bramblemail'),
      effectItem('unbroken'),
    ];
    const run = (stepMs: number) => {
      let character: SettleFarmingInput['character'] = { classId: 'hunter', level: 4, xp: 0 };
      let carry = 0;
      let firstCycle = 0;
      let kills = 0;
      let deaths = 0;
      let xp = 0;
      let maxMomentum = 0;
      const total = 20 * MIN;
      for (let t = 0; t < total; t += stepMs) {
        const s = settleFarming({
          character,
          equipment,
          areaId: 'crowwood',
          seed: 'fx-split',
          firstCycle,
          durationMs: carry + Math.min(stepMs, total - t),
          inventoryCount: 0,
        });
        carry = s.unusedMs;
        firstCycle += s.encounters;
        kills += s.kills;
        deaths += s.deaths;
        xp += s.xpGained;
        maxMomentum = Math.max(maxMomentum, s.momentum);
        character = {
          classId: 'hunter',
          level: s.level,
          xp: s.xp,
          health: s.health,
          momentum: s.momentum,
        };
      }
      return { kills, deaths, xp, character, carry, firstCycle, maxMomentum };
    };
    const once = run(20 * MIN);
    expect(once.kills).toBeGreaterThan(0);
    expect(once.character.momentum).toBeGreaterThan(0);
    for (const step of [1_000, 9_000, 60_000]) {
      const split = run(step);
      expect({ ...split, maxMomentum: 0 }).toEqual({ ...once, maxMomentum: 0 });
    }
  });

  it('bloodrush builds a streak and loses it on death or timeout; life on kill heals', () => {
    // One cycle at a time, chaining the stacks: a kill adds one (up to 5), anything else resets.
    const effects = effectsOf('mage', 'bloodrush');
    let character: FarmingInput['character'] = { classId: 'mage', level: 3, xp: 0 };
    const outcomes = new Set<string>();
    for (let cycle = 0; cycle < 120; cycle++) {
      let outcome = '';
      const r = simulateFarmingAggregate(
        {
          character,
          areaId: 'crowwood',
          seed: 'streak',
          durationMs: 10 * MIN,
          firstCycle: cycle,
          maxCycles: 1,
          effects,
        },
        { onCycle: (c) => (outcome = c.outcome) },
      );
      outcomes.add(outcome);
      const before = character.momentum ?? 0;
      expect(r.momentum).toBe(outcome === 'kill' ? Math.min(5, before + 1) : 0);
      character = {
        classId: 'mage',
        level: r.level,
        xp: r.xp,
        health: r.health,
        momentum: r.momentum,
      };
    }
    expect(outcomes).toContain('kill');
    expect(outcomes).toContain('death');
    // Without bloodrush the stored stacks do nothing and are dropped.
    const off = settleFarming({
      character: { classId: 'warrior', level: 10, xp: 0, momentum: 4 },
      areaId: 'oldBurialGrounds',
      seed: 'streak',
      firstCycle: 0,
      durationMs: 10 * MIN,
      inventoryCount: 0,
    });
    expect(off.momentum).toBe(0);
    const healed = simulateFarming({
      character: { classId: 'warrior', level: 6, xp: 0, health: 120 },
      areaId: 'crowwood',
      seed: 'heal',
      durationMs: 10 * MIN,
      effects: effectsOf('warrior', 'carrion-feast'),
      firstCycle: 0,
      maxCycles: 1,
    });
    const plain = simulateFarming({
      character: { classId: 'warrior', level: 6, xp: 0, health: 120 },
      areaId: 'crowwood',
      seed: 'heal',
      durationMs: 10 * MIN,
      firstCycle: 0,
      maxCycles: 1,
    });
    expect(plain.kills).toBe(1);
    expect(healed.health).toBe(
      Math.min(plain.maxHealth, plain.health + Math.floor(plain.maxHealth * 0.12)),
    );
  });
});
