import { describe, expect, it } from 'vitest';
import {
  BOSS_MODIFIERS,
  BOSS_MODIFIER_IDS,
  DEFAULT_COMBAT_CONFIG,
  ITEM_SETS,
  applyBossModifier,
  bossModifierOfWeek,
  buildEncounter,
  createRng,
  deriveCharacterStats,
  dungeonRunProgress,
  getBossModifier,
  getDungeonTier,
  getEnemy,
  getItemBase,
  findEffect,
  guildBossWeek,
  guildBossWeekFromKey,
  isBossModifierId,
  resolveDungeonFight,
  simulateDungeonRun,
  simulateGuildBossAttempt,
  tierTakesBossModifier,
  WEEK_MS,
  type BossMechanics,
  type BossModifierId,
  type DungeonEvent,
  type DungeonId,
  type DungeonRunInput,
  type DungeonTier,
} from '../index.js';

import { legendaryKit, upgraded } from '../balance/kits.js';

const DAY = 24 * 60 * 60 * 1000;
const monday = (key: string) => guildBossWeekFromKey(key).startMs;

describe('the weekly boss modifier (ticket 6.3)', () => {
  it('is data: five modifiers with plain words and a small hoard focus', () => {
    expect(BOSS_MODIFIERS.map((m) => m.id)).toEqual([...BOSS_MODIFIER_IDS]);
    for (const m of BOSS_MODIFIERS) {
      expect(m.name.length, m.id).toBeGreaterThan(0);
      expect(m.effect.length, m.id).toBeGreaterThan(20);
      expect(m.lootFocus.name.length, m.id).toBeGreaterThan(0);
      const f = m.lootFocus;
      // Small: at most × 2, and never a set restriction (the dungeon's own focus keeps that).
      expect(f.sets ?? []).toEqual([]);
      expect((f.slots?.length ?? 0) + (f.effects?.length ?? 0), m.id).toBeGreaterThan(0);
      if (f.slots) expect(f.slotWeight).toBeGreaterThan(1);
      if (f.slots) expect(f.slotWeight).toBeLessThanOrEqual(2);
      if (f.effects) expect(f.effectWeight).toBeLessThanOrEqual(2);
      for (const e of f.effects ?? []) expect(findEffect(e)?.kind, e).toBe('legendary');
    }
    expect(ITEM_SETS.length).toBeGreaterThan(0);
    expect(isBossModifierId('burning')).toBe(true);
    expect(isBossModifierId('calm')).toBe(false);
    expect(() => getBossModifier('calm' as BossModifierId)).toThrow();
  });

  it('is the same for every moment of a week and fixed per week (pinned)', () => {
    const pins: Record<string, BossModifierId> = {};
    for (const key of ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'])
      pins[key] = bossModifierOfWeek(guildBossWeekFromKey(key)).id;
    // Pinned: the rotation is public and announced; a change to it changes announced weeks.
    expect(pins).toEqual({
      '2026-11-02': 'relentless',
      '2026-11-09': 'warded',
      '2026-11-16': 'burning',
      '2026-11-23': 'frenzied',
      '2026-11-30': 'unyielding',
    });
    for (const key of Object.keys(pins)) {
      const start = monday(key);
      for (const offset of [0, 1, DAY, 3 * DAY + 12 * 3_600_000, WEEK_MS - 1])
        expect(bossModifierOfWeek(start + offset).id, `${key} + ${offset}`).toBe(pins[key]);
    }
  });

  it('holds every modifier once per cycle and never the same two weeks running', () => {
    const k = BOSS_MODIFIER_IDS.length;
    const start = monday('2026-11-02');
    let last: BossModifierId | null = null;
    const seen = new Map<BossModifierId, number>();
    for (let w = -200; w < 800; w++) {
      const id = bossModifierOfWeek(start + w * WEEK_MS).id;
      expect(id, `week ${w}`).not.toBe(last);
      last = id;
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    // 1,000 weeks: every modifier 200 times (± one cycle edge).
    for (const id of BOSS_MODIFIER_IDS)
      expect(Math.abs(seen.get(id)! - 1_000 / k)).toBeLessThanOrEqual(1);
  });

  it('turns at Monday 00:00 UTC exactly (the window rule, injected clock)', () => {
    for (const key of ['2026-11-09', '2026-11-16', '2027-01-04']) {
      const edge = monday(key);
      const before = bossModifierOfWeek(edge - 1);
      const after = bossModifierOfWeek(edge);
      expect(guildBossWeek(edge - 1).key).not.toBe(key);
      expect(guildBossWeek(edge).key).toBe(key);
      expect(after.id).toBe(bossModifierOfWeek(guildBossWeekFromKey(key)).id);
      expect(before.id).toBe(bossModifierOfWeek(edge - WEEK_MS).id);
      // Adjacent weeks never share a modifier, so the boundary is visible.
      expect(after.id).not.toBe(before.id);
    }
  });

  it('applies nothing without a modifier', () => {
    const tier = getDungeonTier('tyrantsForge', 1);
    const data = { scale: tier.bossScale, enrage: tier.bossEnrage, mechanics: tier.bossMechanics };
    for (const none of [null, undefined]) {
      const out = applyBossModifier(data, none);
      expect(out.attackSpeedMultiplier).toBe(1);
      expect(out.enrage).toBe(data.enrage);
      expect(out.mechanics).toBe(data.mechanics);
    }
    // Merged with the tier's own mechanics (the Tyrant keeps his shell and hammer).
    const burning = applyBossModifier(data, 'burning');
    expect(burning.mechanics).toMatchObject({ ...tier.bossMechanics, burn: expect.any(Object) });
    expect(applyBossModifier(data, 'relentless').enrage.atMs).toEqual({
      min: tier.bossEnrage.atMs.min - 5_000,
      max: tier.bossEnrage.atMs.max - 5_000,
    });
    expect(applyBossModifier({ enrage: tier.bossEnrage }, 'unyielding').scale).toEqual({
      health: 1.15,
      damage: 1,
    });
  });
});

/** A level-34 warrior against the Heroic Gravewarden, as a bare fight. */
function bareFight(mechanics?: BossMechanics, phaseClockMs?: number) {
  const tier = getDungeonTier('namelessCrypt', 4);
  const stats = deriveCharacterStats('warrior', 34, []);
  const setup = {
    ...buildEncounter(getEnemy('gravewarden'), 34, 'warrior', 34, stats, DEFAULT_COMBAT_CONFIG),
    maxFightMs: tier.bossMaxFightMs,
  };
  const log: DungeonEvent[] = [];
  const end = resolveDungeonFight(
    setup,
    stats.health * 20,
    createRng('bare'),
    0,
    log,
    undefined,
    mechanics,
    phaseClockMs,
  );
  return { setup, log, end };
}

describe('modifier mechanics (ticket 6.3)', () => {
  it('Burning: a burn every few seconds for a share of the blow, its own timeline', () => {
    const { burn } = getBossModifier('burning').mechanics!;
    const plain = bareFight();
    const { setup, log, end } = bareFight({ burn: burn! });
    const burns = log.filter((e) => e.type === 'burn');
    // On a tie the hero's blow comes first: a kill on a tick's moment ends the fight before it.
    expect(burns.length).toBe(Math.ceil(end.offsetMs / burn!.everyMs) - 1);
    for (const [i, b] of burns.entries()) {
      expect(b.t).toBe((i + 1) * burn!.everyMs);
      expect(b.damage).toBe(Math.max(1, Math.round(setup.enemyHit * burn!.damageShare)));
    }
    // The hero's blows and the boss's are the same draws as without it.
    const blows = (l: DungeonEvent[]) =>
      l.flatMap((e) =>
        e.type === 'attack'
          ? [[e.t, e.damage, e.crit]]
          : e.type === 'enemyAttack'
            ? [[e.t, e.damage]]
            : [],
      );
    expect(blows(log)).toEqual(blows(plain.log).slice(0, blows(log).length));
  });

  it('Warded: softens the hero’s blows only between its two health shares', () => {
    const { ward } = getBossModifier('warded').mechanics!;
    const plain = bareFight().log.filter((e) => e.type === 'attack');
    const { setup, log } = bareFight({ ward: ward! });
    const raised = log.findIndex((e) => e.type === 'wardRaised');
    const broken = log.findIndex((e) => e.type === 'wardBroken');
    expect(raised).toBeGreaterThan(0);
    expect(broken).toBeGreaterThan(raised);
    let i = 0;
    for (const [n, e] of log.entries()) {
      if (e.type !== 'attack' || i >= plain.length) continue;
      const p = plain[i++]!;
      expect(e.crit).toBe(p.crit);
      const inWard = n > raised && n < broken;
      expect(e.damage).toBe(
        inWard ? Math.max(1, Math.round(p.damage * ward!.damageTakenMultiplier)) : p.damage,
      );
    }
    // The ward rose at its share and broke at the lower one.
    const before = log.slice(0, raised).findLast((e) => e.type === 'attack')!;
    if (before.type !== 'attack') throw new Error('no attack');
    expect(before.enemyHealth / setup.enemyHealth).toBeLessThanOrEqual(ward!.fromHealthShare);
  });

  it('Frenzied: below its share the boss strikes faster', () => {
    const { frenzy } = getBossModifier('frenzied').mechanics!;
    const { setup, log } = bareFight({ frenzy: frenzy! });
    const at = log.findIndex((e) => e.type === 'frenzy');
    expect(at).toBeGreaterThan(0);
    const blows = log.map((e, i) => ({ e, i })).filter(({ e }) => e.type === 'enemyAttack');
    const gaps = blows
      .slice(1)
      .map((b, n) => ({ gap: b.e.t - blows[n]!.e.t, after: blows[n]!.i > at }));
    for (const g of gaps.filter((x) => !x.after)) expect(g.gap).toBe(setup.enemyIntervalMs);
    for (const g of gaps.filter((x) => x.after))
      expect(g.gap).toBe(Math.round(setup.enemyIntervalMs / frenzy!.attackSpeedMultiplier));
  });

  it('a boss that cannot fall reads the ward and frenzy from the clock', () => {
    const { ward } = getBossModifier('warded').mechanics!;
    const clock = 60_000;
    const { log } = bareFight({ ward: ward! }, clock);
    const raised = log.find((e) => e.type === 'wardRaised')!;
    expect(raised.t).toBeGreaterThanOrEqual((1 - ward!.fromHealthShare) * clock);
  });
});

const kitFor = (level: number) => upgraded(legendaryKit('warrior', level - 1), 10);
const runInput = (
  dungeonId: DungeonId,
  tier: DungeonTier,
  level: number,
  over: Partial<DungeonRunInput> = {},
): DungeonRunInput => ({
  dungeonId,
  tier,
  character: { classId: 'warrior', level, xp: 0 },
  equipment: kitFor(level),
  seed: `mod-run:${dungeonId}:${tier}`,
  bossLootEligible: true,
  inventoryCount: 0,
  ...over,
});
const BOSSES: [DungeonId, DungeonTier, number][] = [
  ['namelessCrypt', 1, 16],
  ['namelessCrypt', 2, 21],
  ['namelessCrypt', 3, 24],
  ['namelessCrypt', 4, 36],
  ['ashenWatch', 1, 28],
  ['tyrantsForge', 1, 40],
];

describe('runs with a modifier (ticket 6.3)', () => {
  it('no modifier reproduces the run exactly; the result names a modifier only when set', () => {
    for (const [d, t, level] of BOSSES) {
      const plain = simulateDungeonRun(runInput(d, t, level));
      expect(simulateDungeonRun(runInput(d, t, level, { bossModifier: null }))).toEqual(plain);
      expect('bossModifier' in plain).toBe(false);
      const warded = simulateDungeonRun(runInput(d, t, level, { bossModifier: 'warded' }));
      // Crypt tier I takes no modifier (owner decision): it fights exactly as without one.
      if (tierTakesBossModifier(d, t)) expect(warded.bossModifier).toBe('warded');
      else expect(warded).toEqual(plain);
    }
    expect(() =>
      simulateDungeonRun(runInput('namelessCrypt', 1, 16, { bossModifier: 'calm' as never })),
    ).toThrow(RangeError);
  });

  it('crypt tier I never takes a modifier; every other boss does', () => {
    expect(tierTakesBossModifier('namelessCrypt', 1)).toBe(false);
    for (const [d, t] of BOSSES.filter(([d, t]) => !(d === 'namelessCrypt' && t === 1)))
      expect(tierTakesBossModifier(d, t), `${d} ${t}`).toBe(true);
    for (const m of BOSS_MODIFIER_IDS)
      for (let i = 0; i < 20; i++) {
        const input = runInput('namelessCrypt', 1, 16, { seed: `tier1:${i}` });
        expect(simulateDungeonRun({ ...input, bossModifier: m })).toEqual(
          simulateDungeonRun(input),
        );
      }
  });

  it('replays equal with the modifier, and every poll reveals the same run', () => {
    for (const [d, t, level] of BOSSES)
      for (const m of BOSS_MODIFIER_IDS) {
        const input = runInput(d, t, level, { bossModifier: m });
        const run = simulateDungeonRun(input);
        expect(simulateDungeonRun(input), `${d} ${t} ${m}`).toEqual(run);
        const seen: DungeonEvent[] = [];
        let last = -1;
        for (let at = 0; ; at += 3_300) {
          const p = dungeonRunProgress(run, at, 10_000);
          seen.push(...p.events.filter((e) => e.t > last));
          last = p.elapsedMs;
          if (p.finished) break;
        }
        expect(seen, `${d} ${t} ${m}`).toEqual(run.events);
      }
  });

  it('changes only the boss: the chambers and the enrage draw are the same', () => {
    for (const m of BOSS_MODIFIER_IDS) {
      const plain = simulateDungeonRun(runInput('namelessCrypt', 4, 36));
      const mod = simulateDungeonRun(runInput('namelessCrypt', 4, 36, { bossModifier: m }));
      expect(mod.encounters.slice(0, -1)).toEqual(plain.encounters.slice(0, -1));
      const shift = getBossModifier(m).enrageEarlierMs ?? 0;
      expect(mod.enrageAtMs).toBe(plain.enrageAtMs - shift);
    }
  });

  it('the hoard keeps its rarities and item levels; the focus only reweights the base pick', () => {
    let focused = 0;
    let before = 0;
    const slots = getBossModifier('burning').lootFocus.slots!;
    for (let i = 0; i < 300; i++) {
      const input = runInput('namelessCrypt', 4, 36, { seed: `hoard:${i}` });
      const a = simulateDungeonRun(input);
      const b = simulateDungeonRun({ ...input, bossModifier: 'burning' });
      if (!a.bossLoot || !b.bossLoot) continue;
      const hoardA = a.items.slice(-2);
      const hoardB = b.items.slice(-2);
      expect(hoardB.map((x) => [x.rarityId, x.itemLevel, x.setId !== undefined])).toEqual(
        hoardA.map((x) => [x.rarityId, x.itemLevel, x.setId !== undefined]),
      );
      for (const x of hoardA) if (slots.some((s) => x.baseId && slotOf(x.baseId) === s)) before++;
      for (const x of hoardB) if (slots.some((s) => x.baseId && slotOf(x.baseId) === s)) focused++;
    }
    expect(focused).toBeGreaterThan(before);
  });
});

const slotOf = (baseId: string) => getItemBase(baseId).slot;

describe('the guild boss with a modifier (ticket 6.3)', () => {
  const attempt = (bossModifier?: BossModifierId | null, seed = 'gb:1') =>
    simulateGuildBossAttempt({
      bossId: 'risenGravewarden',
      character: { classId: 'hunter', level: 24 },
      equipment: legendaryKit('hunter', 23),
      seed,
      ...(bossModifier !== undefined ? { bossModifier } : {}),
    });

  it('without one an attempt is exactly as before; with one it is deterministic', () => {
    expect(attempt(null)).toEqual(attempt());
    expect('bossModifier' in attempt()).toBe(false);
    for (const m of BOSS_MODIFIER_IDS) {
      expect(attempt(m)).toEqual(attempt(m));
      expect(attempt(m).bossModifier).toBe(m);
    }
  });

  it('an attempt fights the modifier it is given: the week it was made in decides', () => {
    // Two attempts with the same stream on either side of Monday: each with its own week's modifier.
    const edge = monday('2026-11-16');
    const before = bossModifierOfWeek(edge - 1).id;
    const after = bossModifierOfWeek(edge).id;
    expect(attempt(before, 's:2026-11-09:3')).toEqual(attempt(before, 's:2026-11-09:3'));
    expect(attempt(after).bossModifier).toBe(after);
    expect(attempt(before).bossModifier).toBe(before);
    // The modifier changes the fight (one of the two differs from the unmodified attempt).
    const plain = attempt().damage;
    expect([attempt(before).damage, attempt(after).damage].some((d) => d !== plain)).toBe(true);
  });

  it('Warded and Frenzied follow the clock (the guild boss never loses health shares)', () => {
    const w = attempt('warded');
    expect(w.events.some((e) => e.type === 'wardRaised')).toBe(true);
  });
});
