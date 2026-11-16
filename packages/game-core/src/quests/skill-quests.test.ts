import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SKILLS,
  CLASS_IDS,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_COMBAT_CONFIG,
  DEFAULT_LOOT_CONFIG,
  EFFECTS,
  ITEM_BASES,
  PASSIVE_SKILLS,
  SKILL_QUESTS,
  SKILL_QUEST_BASES,
  buildEncounter,
  combineEffects,
  createRng,
  deriveCharacterStats,
  equipmentModifiers,
  findSet,
  generateItem,
  getEnemy,
  getItemBase,
  getSkillQuest,
  killDistribution,
  legendaryEffectPool,
  resolveFightDetailed,
  sampleFight,
  setBonusInstances,
  simulateFarming,
  simulateFarmingAggregate,
  skillQuestBlockers,
  skillQuestLearned,
  skillQuestMissing,
  skillTaughtBy,
  thrifty,
  validateItem,
  validateLoadout,
  wornSets,
  type ClassId,
  type FarmingInput,
  type FightOutcome,
  type GeneratedItem,
  type Loadout,
} from '../index.js';
import { legendaryKit, upgraded } from '../balance/kits.js';

/** Ticket 9.3: skill quests and the skill-aware effects (docs/QUESTS.md, docs/EFFECTS.md). */

const SLOW = { timeout: 120_000 };

const bossLoadout: Record<ClassId, Loadout> = {
  warrior: { actives: ['heavyStrike', 'execute', 'earthsplitter'], passive: 'juggernaut' },
  mage: { actives: ['scorch', 'pyroblast', 'meteor'], passive: 'deepReserves' },
  hunter: { actives: ['serratedArrow', 'volley', 'killShot'], passive: 'predator' },
  warlock: { actives: ['agony', 'corruption', 'soulBurn'], passive: 'malice' },
};

/** The same item without its effect and set: its stats alone. */
const strip = (i: GeneratedItem): GeneratedItem => {
  const out = { ...i };
  delete out.effectId;
  delete out.effectRoll;
  delete out.setId;
  return out;
};

const questItem = (baseId: string, effectId: string, roll = 1, classId?: ClassId) => {
  const quest = SKILL_QUESTS.find((q) => q.item.baseId === baseId)!;
  // Find a seed that rolls the wanted effect, with game-core's own rules (CLAUDE.md "seeds").
  for (let seed = 1; seed < 5_000; seed++) {
    const item = generateItem({
      seed,
      itemLevel: quest.item.itemLevel,
      baseId,
      rarityId: 'legendary',
      ...(classId ? { classId } : {}),
    })!;
    if (item.effectId === effectId) return { ...item, effectRoll: roll };
  }
  throw new Error(`no seed rolls ${effectId} on ${baseId}`);
};

/** A level-49 Legendary kit with the ring and the neck swapped for the given items. */
const kitWith = (c: ClassId, swap: GeneratedItem[]): GeneratedItem[] => {
  const kit = upgraded(legendaryKit(c, 47), 5);
  const slots = swap.map((i) => getItemBase(i.baseId).slot);
  const out: GeneratedItem[] = [];
  const dropped = new Set<string>();
  for (const item of kit) {
    const slot = getItemBase(item.baseId).slot;
    if (slots.includes(slot) && !dropped.has(slot)) {
      dropped.add(slot);
      continue;
    }
    out.push(item);
  }
  return [...out, ...swap];
};

const farmInput = (
  c: ClassId,
  equipment: GeneratedItem[],
  seed: string,
  loadout?: Loadout,
): FarmingInput => {
  const m = equipmentModifiers(
    equipment,
    DEFAULT_ACTIVITY_CONFIG.modifierCaps,
    DEFAULT_LOOT_CONFIG,
    {
      classId: c,
      extraEffects: setBonusInstances(equipment),
    },
  );
  return {
    character: { classId: c, level: 49, xp: 0 },
    equipment: m.stats,
    modifiers: { skillDamage: m.skillDamage, bossDamage: m.bossDamage },
    effects: m.effects,
    areaId: 'hollowDeep',
    seed,
    durationMs: 20 * 60_000,
    firstCycle: 0,
    ...(loadout ? { loadout } : {}),
  };
};

describe('skill quests (content)', () => {
  it('a quest at each boss teaches every class one later-content skill', () => {
    expect(SKILL_QUESTS.map((q) => q.bossId)).toEqual(['forgeTyrant', 'hollowSovereign']);
    for (const c of CLASS_IDS) {
      const tyrant = skillTaughtBy(getSkillQuest('theTyrantsLesson'), c);
      const sovereign = skillTaughtBy(getSkillQuest('theSovereignsLesson'), c);
      expect(ACTIVE_SKILLS.find((s) => s.id === tyrant.id)?.unlock.deed).toBe(
        'forgeTyrantSkillLearned',
      );
      expect(PASSIVE_SKILLS.find((s) => s.id === sovereign.id)?.unlock.deed).toBe(
        'hollowSovereignSkillLearned',
      );
    }
    // Every deed skill is taught by exactly one quest.
    const deeds = [...ACTIVE_SKILLS, ...PASSIVE_SKILLS].filter((s) => s.unlock.deed);
    expect(deeds).toHaveLength(8);
    for (const s of deeds) {
      expect(SKILL_QUESTS.filter((q) => q.teaches === s.unlock.deed)).toHaveLength(1);
    }
  });

  it('each needs a boss kill and an older boss’s material', () => {
    const tyrant = getSkillQuest('theTyrantsLesson');
    const sovereign = getSkillQuest('theSovereignsLesson');
    expect(tyrant.objectives).toEqual([{ kind: 'defeatBoss', bossId: 'forgeTyrant' }]);
    expect(tyrant.cost.materials).toEqual({ gravewardenSeal: 2 });
    expect(sovereign.objectives).toEqual([{ kind: 'defeatBoss', bossId: 'hollowSovereign' }]);
    expect(sovereign.cost.materials).toEqual({ tyrantsEmber: 2 });
    // The quest opens at the taught skill's own level.
    for (const q of SKILL_QUESTS) {
      expect(q.level).toBe(skillTaughtBy(q, 'warrior').level);
      expect(skillQuestBlockers(q, q.level - 1)).toEqual([{ kind: 'level', required: q.level }]);
      expect(skillQuestBlockers(q, q.level)).toEqual([]);
    }
    expect(skillQuestMissing(tyrant, {})).toEqual({ gravewardenSeal: 2 });
    expect(skillQuestMissing(tyrant, { gravewardenSeal: 1 })).toEqual({ gravewardenSeal: 1 });
    expect(skillQuestMissing(tyrant, { gravewardenSeal: 2, tyrantsEmber: 0 })).toEqual({});
  });

  it('the deed flag, not the kill flag, unlocks the skill (9.2’s rule replaced)', () => {
    const forgebreaker = { actives: ['heavyStrike', 'forgebreaker'] };
    expect(
      validateLoadout('warrior', forgebreaker, {
        level: 50,
        progress: { forgeTyrantDefeated: true },
      }),
    ).toEqual(['forgebreaker is locked']);
    expect(
      validateLoadout('warrior', forgebreaker, {
        level: 50,
        progress: { forgeTyrantSkillLearned: true },
      }),
    ).toEqual([]);
    // The level still counts.
    expect(
      validateLoadout('warrior', forgebreaker, {
        level: 35,
        progress: { forgeTyrantSkillLearned: true },
      }),
    ).toEqual(['forgebreaker is locked']);
    const q = getSkillQuest('theSovereignsLesson');
    expect(skillQuestLearned(q, { hollowSovereignDefeated: true })).toBe(false);
    expect(skillQuestLearned(q, { hollowSovereignSkillLearned: true })).toBe(true);
  });
});

describe('skill-aware effects on new bases only', () => {
  const skillEffects = EFFECTS.filter((e) => e.bases !== undefined);

  it('roll only on the quest bases, and those bases roll only them', () => {
    expect(skillEffects.map((e) => e.id).sort()).toEqual(
      ['deep-wellspring', 'festering-craft', 'practiced-hand'].sort(),
    );
    for (const base of ITEM_BASES) {
      const pool = legendaryEffectPool(base, 'warrior').map((e) => e.id);
      const quest = (SKILL_QUEST_BASES as readonly string[]).includes(base.id);
      for (const e of skillEffects) expect(pool.includes(e.id), base.id).toBe(quest);
      if (quest) expect(pool.sort()).toEqual(skillEffects.map((e) => e.id).sort());
    }
  });

  it('the quest rewards are valid Legendaries of the Masters’ Lessons with an effect of their own', () => {
    const seen = new Set<string>();
    for (const q of SKILL_QUESTS) {
      const base = getItemBase(q.item.baseId);
      expect(base.unique).toBe(true);
      for (let seed = 0; seed < 300; seed++) {
        const item = generateItem({ seed, ...q.item, classId: CLASS_IDS[seed % 4]! })!;
        expect(validateItem(item), JSON.stringify(item)).toEqual([]);
        expect(item.setId).toBe('masters-lessons');
        expect(item.rarityId).toBe('legendary');
        expect(item.variant).toBeUndefined();
        expect(skillEffects.map((e) => e.id)).toContain(item.effectId);
        seen.add(item.effectId!);
      }
    }
    expect(seen.size).toBe(3);
    expect(findSet('masters-lessons')?.questOnly).toBe(true);
    // Forged: an older effect on a quest base, or a skill effect on an older base.
    const ring = questItem('masters-ember-band', 'practiced-hand');
    expect(validateItem({ ...ring, effectId: 'tyrants-bane' }).join()).toMatch(/not allowed/);
    const old = generateItem({
      seed: 3,
      itemLevel: 41,
      baseId: 'hollow-signet',
      rarityId: 'legendary',
    })!;
    expect(validateItem({ ...old, effectId: 'practiced-hand', effectRoll: 1 }).join()).toMatch(
      /not allowed/,
    );
  });

  it('combine under their caps, the set bonus included, and only when worn', () => {
    const ring = questItem('masters-ember-band', 'practiced-hand');
    const torc = questItem('masters-hollow-torc', 'festering-craft');
    expect(wornSets([ring]).flatMap((w) => w.active)).toEqual([]);
    expect(wornSets([ring, torc])[0]!.active.map((b) => b.effectId)).toEqual(['lessons-mastery']);
    const fx = combineEffects(
      [
        { effectId: ring.effectId!, roll: 1 },
        { effectId: torc.effectId!, roll: 1 },
        ...setBonusInstances([ring, torc]),
      ],
      'warrior',
    );
    expect(fx.skillSpender).toBeCloseTo(0.12 + 0.05, 9);
    expect(fx.skillDot).toBeCloseTo(0.3 + 0.1, 9);
    expect(fx.skillThrift).toBeUndefined();
    // Without them the combined object is exactly the pre-9.3 one (no new keys).
    expect(
      Object.keys(combineEffects([{ effectId: 'tyrants-bane', roll: 1 }], 'mage')),
    ).not.toContain('skillSpender');
    expect(thrifty(50, 0.2)).toBe(40);
    expect(thrifty(1, 0.2)).toBe(1);
    expect(thrifty(0, 0.2)).toBe(0);
    expect(thrifty(30)).toBe(30);
  });

  it('change nothing for the default loadout (the default fights exactly as before)', () => {
    for (const c of CLASS_IDS) {
      const ring = questItem('masters-ember-band', 'practiced-hand', 1, c);
      const torc = questItem('masters-hollow-torc', 'deep-wellspring', 1, c);
      const withFx = kitWith(c, [ring, torc]);
      // The same items without their effects and set: the stats alone.
      const plain = withFx.map((i) => (i === ring || i === torc ? strip(i) : i));
      for (const sim of [simulateFarmingAggregate, (i: FarmingInput) => simulateFarming(i)]) {
        const a = sim(farmInput(c, withFx, `fx-default:${c}`));
        const b = sim(farmInput(c, plain, `fx-default:${c}`));
        expect(a, c).toEqual(b);
      }
    }
  });

  it('act on a chosen loadout’s kit: spenders, ticks and costs', () => {
    for (const c of CLASS_IDS) {
      const build = (items: GeneratedItem[]) => {
        const m = equipmentModifiers(
          items,
          DEFAULT_ACTIVITY_CONFIG.modifierCaps,
          DEFAULT_LOOT_CONFIG,
          {
            classId: c,
            extraEffects: setBonusInstances(items),
          },
        );
        return buildEncounter(
          getEnemy('hollowSovereign'),
          50,
          c,
          49,
          deriveCharacterStats(c, 49, m.stats),
          DEFAULT_COMBAT_CONFIG,
          { skillDamage: m.skillDamage, bossDamage: m.bossDamage },
          { effects: m.effects },
          { loadout: bossLoadout[c], fragments: 2 },
        );
      };
      const ring = questItem('masters-ember-band', 'practiced-hand', 1, c);
      const torc = questItem('masters-hollow-torc', 'deep-wellspring', 1, c);
      const base = build(kitWith(c, []));
      const fx = build(kitWith(c, [ring, torc]));
      const plain = build(kitWith(c, [strip(ring), strip(torc)]));
      expect(base.kit && fx.kit && plain.kit).toBeTruthy();
      expect(fx.kit!.key).not.toBe(plain.kit!.key);
      fx.kit!.spenders.forEach((s, i) => {
        const p = plain.kit!.spenders[i]!;
        // Practiced Hand 12 % and the set's 5 % add to the passive's spender bonus.
        expect(s.bonus, `${c} ${s.id}`).toBeCloseTo(p.bonus + 0.17, 9);
        expect(s.cost).toBe(thrifty(p.cost, 0.2));
      });
      // The set's 10 % on every tick.
      fx.kit!.dots.forEach((d, i) => {
        expect(d.damage, c).toBeGreaterThanOrEqual(plain.kit!.dots[i]!.damage);
      });
    }
  });

  it('the two simulations agree per fight with them', SLOW, () => {
    const trials = 6_000;
    for (const c of CLASS_IDS) {
      const items = kitWith(c, [
        questItem('masters-ember-band', 'deep-wellspring', 1, c),
        questItem('masters-hollow-torc', 'festering-craft', 1, c),
      ]);
      const m = equipmentModifiers(
        items,
        DEFAULT_ACTIVITY_CONFIG.modifierCaps,
        DEFAULT_LOOT_CONFIG,
        {
          classId: c,
          extraEffects: setBonusInstances(items),
        },
      );
      const setup = {
        ...buildEncounter(
          getEnemy('hollowSovereign'),
          50,
          c,
          49,
          deriveCharacterStats(c, 49, m.stats),
          DEFAULT_COMBAT_CONFIG,
          { skillDamage: m.skillDamage, bossDamage: m.bossDamage },
          { effects: m.effects },
          { loadout: bossLoadout[c], fragments: 2 },
        ),
        maxFightMs: 30_000,
      };
      const health = deriveCharacterStats(c, 49, m.stats).health;
      const distribution = killDistribution(setup, health);
      const d = createRng(`fx-detailed:${c}`);
      const s = createRng(`fx-sampled:${c}`);
      const tally = () => ({ kill: 0, death: 0, timeout: 0, offset: 0 });
      const a = tally();
      const b = tally();
      const add = (t: ReturnType<typeof tally>, o: FightOutcome) => {
        t[o.kind]++;
        t.offset += o.offsetMs;
      };
      for (let i = 0; i < trials; i++) {
        add(a, resolveFightDetailed(setup, health, d));
        add(b, sampleFight(setup, health, s, distribution));
      }
      for (const k of ['kill', 'death', 'timeout'] as const)
        expect(Math.abs(a[k] - b[k]) / trials, `${c} ${k}`).toBeLessThan(0.02);
      expect(Math.abs(a.offset - b.offset) / Math.max(1, a.offset), c).toBeLessThan(0.03);
    }
  });
});
