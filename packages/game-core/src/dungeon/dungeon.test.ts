import { describe, expect, it } from 'vitest';
import {
  AREA_LOOT_TABLES,
  DEFAULT_ACTIVITY_CONFIG,
  DEFAULT_COMBAT_CONFIG,
  ITEM_BASES,
  buildEncounter,
  canClassUseItem,
  createRng,
  deriveCharacterStats,
  dungeonRunProgress,
  generateItem,
  getDungeon,
  getDungeonTier,
  getEnemy,
  resolveEnrage,
  scaleEnemy,
  DUNGEON_TIERS,
  getLootTable,
  resolveDungeonFight,
  simulateDungeonRun,
  isValuableDrop,
  type ClassId,
  type DungeonEvent,
  type DungeonRunInput,
  type GeneratedItem,
  findItemBase,
  mythicForBase,
  setForBase,
} from '../index.js';

/** One tier-3 item per slot at the given level (the gear a crypt-ready hero has collected). */
export function cryptGear(classId: ClassId, level: number): GeneratedItem[] {
  const rng = createRng(`gear:${classId}:${level}`);
  const taken = new Set<string>();
  const out: GeneratedItem[] = [];
  const bases = ITEM_BASES.filter(
    (b) => !b.unique && b.minItemLevel <= level && canClassUseItem(b, classId),
  ).sort((a, b) => b.tier - a.tier || b.minItemLevel - a.minItemLevel);
  for (const base of bases) {
    if (taken.has(base.slot)) continue;
    taken.add(base.slot);
    const copies = base.slot === 'ring' ? 2 : 1;
    for (let i = 0; i < copies; i++) {
      out.push(
        generateItem({
          seed: rng.int(0, 2 ** 31),
          itemLevel: level,
          baseId: base.id,
          rarityId: 'uncommon',
        })!,
      );
    }
  }
  return out;
}

const input = (overrides: Partial<DungeonRunInput> = {}): DungeonRunInput => ({
  dungeonId: 'namelessCrypt',
  character: { classId: 'warrior', level: 16, xp: 0 },
  equipment: cryptGear('warrior', 16),
  seed: 'crypt-test',
  bossLootEligible: true,
  inventoryCount: 0,
  ...overrides,
});

describe('simulateDungeonRun', () => {
  it('is deterministic for the same input and differs by seed', () => {
    const a = simulateDungeonRun(input());
    const b = simulateDungeonRun(input());
    expect(b).toEqual(a);
    const c = simulateDungeonRun(input({ seed: 'another-run' }));
    expect(c.events).not.toEqual(a.events);
  });

  it('runs every room, then the boss, in real time (minutes)', () => {
    const run = simulateDungeonRun(input());
    const dungeon = { ...getDungeon('namelessCrypt'), ...getDungeonTier('namelessCrypt', 1) };
    expect(run.outcome).toBe('cleared');
    expect(run.roomsCleared).toBe(dungeon.rooms.length);
    const roomFights = dungeon.rooms.reduce((n, r) => n + r.enemies, 0);
    expect(run.encounters).toHaveLength(roomFights + 1);
    expect(run.encounters.at(-1)).toMatchObject({ room: null, enemyId: 'gravewarden' });
    expect(run.encounters.at(-1)!.enemyLevel).toBe(dungeon.bossLevel);
    for (const e of run.encounters.slice(0, -1)) {
      expect(['cryptGhoul', 'boneAcolyte']).toContain(e.enemyId);
      expect(e.enemyLevel).toBeGreaterThanOrEqual(dungeon.minLevel);
      expect(e.enemyLevel).toBeLessThanOrEqual(dungeon.maxLevel);
    }
    // Encounters are sequential and the run ends with the last one.
    for (let i = 1; i < run.encounters.length; i++) {
      expect(run.encounters[i]!.startMs).toBeGreaterThan(run.encounters[i - 1]!.endMs);
    }
    expect(run.durationMs).toBe(run.encounters.at(-1)!.endMs);
    expect(run.durationMs).toBeGreaterThan(60_000);
    expect(run.durationMs).toBeLessThan(10 * 60_000);
    expect(run.events.at(-1)).toEqual({ t: run.durationMs, type: 'end', outcome: 'cleared' });
  });

  it('a boss kill drops the seal and boss items and emits the quest event', () => {
    const run = simulateDungeonRun(input());
    expect(run.bossDefeated).toBe(true);
    expect(run.bossLoot).toBe(true);
    expect(run.materials).toEqual({ gravewardenSeal: 1 });
    expect(run.questEvents).toEqual([{ type: 'bossDefeated', bossId: 'gravewarden' }]);
    const bossTable = getLootTable('gravewarden');
    const bossItems = run.items.slice(-2);
    for (const item of bossItems) {
      expect(bossTable.entries.map((e) => e.baseId)).toContain(item.baseId);
      expect(item.rarityId).not.toBe('common');
    }
    expect(run.xpGained).toBeGreaterThan(0);
    expect(run.goldLooted).toBeGreaterThan(0);
  });

  it('boss loot on cooldown: the kill still counts, but no seal and no boss items', () => {
    const on = simulateDungeonRun(input());
    const off = simulateDungeonRun(input({ bossLootEligible: false }));
    expect(off.bossDefeated).toBe(true);
    expect(off.bossLoot).toBe(false);
    expect(off.materials).toEqual({});
    expect(off.questEvents).toEqual(on.questEvents);
    expect(off.items).toEqual(on.items.slice(0, on.items.length - 2));
    expect(off.xpGained).toBe(on.xpGained);
  });

  it('failure keeps the room rewards, drops nothing from the boss and removes no progress', () => {
    const run = simulateDungeonRun(
      input({ character: { classId: 'mage', level: 12, xp: 0 }, equipment: [] }),
    );
    expect(run.outcome).toBe('failed');
    expect(run.bossDefeated).toBe(false);
    expect(run.bossLoot).toBe(false);
    expect(run.materials).toEqual({});
    expect(run.questEvents).toEqual([]);
    expect(run.xpGained).toBeGreaterThan(0);
    expect(run.level).toBeGreaterThanOrEqual(12);
    expect(run.events.at(-1)).toMatchObject({ type: 'end', outcome: 'failed' });
  });

  it('only rare-or-better gear makes the crypt easy; naked heroes at the entry level fail', () => {
    let nakedWins = 0;
    let gearedWins = 0;
    for (let i = 0; i < 40; i++) {
      for (const classId of ['warrior', 'mage', 'hunter', 'warlock'] as const) {
        const naked = simulateDungeonRun(
          input({ seed: `b${i}`, character: { classId, level: 12, xp: 0 }, equipment: [] }),
        );
        if (naked.bossDefeated) nakedWins++;
        const geared = simulateDungeonRun(
          input({
            seed: `b${i}`,
            character: { classId, level: 16, xp: 0 },
            equipment: cryptGear(classId, 16),
          }),
        );
        if (geared.bossDefeated) gearedWins++;
      }
    }
    expect(nakedWins).toBe(0);
    expect(gearedWins).toBeGreaterThan(150);
  });

  it('salvages drops that do not fit the inventory', () => {
    const full = simulateDungeonRun(
      input({ inventoryCount: DEFAULT_ACTIVITY_CONFIG.inventory.capacity }),
    );
    const free = simulateDungeonRun(input());
    // Ticket B.2: valuable drops are kept beyond the capacity, every other drop is salvaged.
    expect(full.items).toEqual(free.items.filter(isValuableDrop));
    expect(full.overCapacity).toEqual(full.items);
    expect(full.salvaged).toEqual(free.items.filter((i) => !isValuableDrop(i)));
    expect(full.goldSalvaged).toBeGreaterThan(0);
  });

  it('keeps every valuable drop of every tier when the pack is full (ticket B.2)', () => {
    const cap = DEFAULT_ACTIVITY_CONFIG.inventory.capacity;
    let valuable = 0;
    for (const tier of [1, 2, 3] as const) {
      for (let i = 0; i < 40; i++) {
        const args = input({
          seed: `full-pack:${tier}:${i}`,
          tier,
          character: { classId: 'warrior', level: 24, xp: 0 },
          equipment: cryptGear('warrior', 24),
        });
        const free = simulateDungeonRun(args);
        const full = simulateDungeonRun({ ...args, inventoryCount: cap + 2 });
        expect(full.items).toEqual(free.items.filter(isValuableDrop));
        expect(full.overCapacity).toEqual(full.items);
        expect(full.salvaged.some(isValuableDrop)).toBe(false);
        valuable += full.items.length;
      }
    }
    expect(valuable).toBeGreaterThan(0);
  });

  it('rejects invalid input', () => {
    expect(() => simulateDungeonRun(input({ seed: '' }))).toThrow(RangeError);
    expect(() =>
      simulateDungeonRun(input({ character: { classId: 'warrior', level: 0, xp: 0 } })),
    ).toThrow(RangeError);
    expect(() => simulateDungeonRun(input({ inventoryCount: -1 }))).toThrow(RangeError);
  });
});

describe('boss mechanics (ticket 6.2)', () => {
  const tier = getDungeonTier('tyrantsForge', 1);
  const stats = deriveCharacterStats('warrior', 38, []);
  const setup = {
    ...buildEncounter(getEnemy('forgeTyrant'), 40, 'warrior', 38, stats, DEFAULT_COMBAT_CONFIG),
    maxFightMs: tier.bossMaxFightMs,
  };
  const fight = (mechanics?: Parameters<typeof resolveDungeonFight>[6], hp = 1_000_000) => {
    const log: DungeonEvent[] = [];
    const out = resolveDungeonFight(setup, hp, createRng('mech'), 0, log, undefined, mechanics);
    return { out, log };
  };

  it('without mechanics (or with none set) a fight is exactly as before', () => {
    expect(fight({})).toEqual(fight());
    expect(fight().log.some((e) => e.type === 'shellBroken')).toBe(false);
    expect(fight().log.some((e) => e.type === 'enemyAttack' && 'heavy' in e)).toBe(false);
    for (const d of ['namelessCrypt', 'ashenWatch'] as const)
      for (const t of getDungeon(d).tiers)
        expect(t.bossMechanics, `${d} ${t.tier}`).toBeUndefined();
  });

  it('every n-th blow is heavy, and the shell softens the hero’s blows until it breaks', () => {
    const { heavyBlow, shell } = tier.bossMechanics!;
    const { log } = fight(tier.bossMechanics);
    const blows = log.filter((e) => e.type === 'enemyAttack');
    for (const [i, b] of blows.entries()) {
      const heavy = (i + 1) % heavyBlow!.every === 0;
      expect(b.damage, `blow ${i}`).toBe(
        heavy ? Math.round(setup.enemyHit * heavyBlow!.damageMultiplier) : setup.enemyHit,
      );
    }
    const plain = fight().log.filter((e) => e.type === 'attack');
    const shelled = log.filter((e) => e.type === 'attack');
    const broke = log.findIndex((e) => e.type === 'shellBroken');
    expect(log.filter((e) => e.type === 'shellBroken')).toHaveLength(1);
    // The same draws: crits land on the same blows; softened until the break, plain after it.
    for (const [i, a] of shelled.entries()) {
      expect(a.crit, `attack ${i}`).toBe(plain[i]!.crit);
      const softened = log.indexOf(a) < broke;
      expect(a.damage, `attack ${i}`).toBe(
        softened
          ? Math.max(1, Math.round(plain[i]!.damage * shell!.damageTakenMultiplier))
          : plain[i]!.damage,
      );
    }
    const at = log[broke - 1];
    expect(
      at?.type === 'attack' && at.enemyHealth <= setup.enemyHealth * shell!.untilHealthShare,
    ).toBe(true);
  });
});

describe('the Gravewarden enrage', () => {
  it('hits harder and faster from the enrage time on', () => {
    const tier = getDungeonTier('namelessCrypt', 1);
    const enrage = resolveEnrage(tier.bossEnrage, createRng('enrage-moment'));
    const stats = deriveCharacterStats('warrior', 16, []);
    const setup = {
      ...buildEncounter(getEnemy('gravewarden'), 16, 'warrior', 16, stats, DEFAULT_COMBAT_CONFIG),
      maxFightMs: tier.bossMaxFightMs,
      enemyHealth: 1_000_000,
    };
    const log: DungeonEvent[] = [];
    resolveDungeonFight(setup, 1_000_000, createRng('enrage'), 0, log, enrage);
    const hits = log.filter((e) => e.type === 'enemyAttack');
    const before = hits.filter((e) => e.t < enrage.atMs);
    const after = hits.filter((e) => e.t >= enrage.atMs);
    expect(log.filter((e) => e.type === 'enrage')).toEqual([{ t: enrage.atMs, type: 'enrage' }]);
    expect(new Set(before.map((e) => e.damage))).toEqual(new Set([setup.enemyHit]));
    expect(new Set(after.map((e) => e.damage))).toEqual(
      new Set([Math.round(setup.enemyHit * enrage.damageMultiplier)]),
    );
    const gap = (xs: { t: number }[]) => xs[xs.length - 1]!.t - xs[xs.length - 2]!.t;
    expect(gap(after)).toBeLessThan(gap(before));
  });

  it('enrages at a moment drawn per run from the tier’s window, in whole seconds (ticket 3.6)', () => {
    for (const t of DUNGEON_TIERS) {
      const { atMs } = getDungeonTier('namelessCrypt', t).bossEnrage;
      const moments = new Set<number>();
      for (let i = 0; i < 200; i++) {
        const run = simulateDungeonRun(
          input({ tier: t, seed: `enrage:${i}`, bossLootEligible: false }),
        );
        expect(run.enrageAtMs).toBeGreaterThanOrEqual(atMs.min);
        expect(run.enrageAtMs).toBeLessThanOrEqual(atMs.max);
        expect(run.enrageAtMs % 1000).toBe(0);
        moments.add(run.enrageAtMs);
        // The log shows it at that moment of the boss fight, if the fight lasts that long.
        const boss = run.encounters.at(-1)!;
        const enrage = run.events.find((e) => e.type === 'enrage');
        if (boss.room === null && boss.endMs - boss.startMs >= run.enrageAtMs) {
          expect(enrage?.t).toBe(boss.startMs + run.enrageAtMs);
        } else {
          expect(enrage).toBeUndefined();
        }
      }
      // Spread over the window, not a fixed moment.
      expect(moments.size, `tier ${t}`).toBeGreaterThan(25);
      expect(Math.min(...moments)).toBeLessThan(atMs.min + 5_000);
      expect(Math.max(...moments)).toBeGreaterThan(atMs.max - 5_000);
    }
  });

  it('draws the enrage from its own stream: the rooms and every drop are untouched by it', () => {
    // The same run with a fixed enrage moment (a window of one value draws nothing).
    const tier = getDungeonTier('namelessCrypt', 1);
    const fixed = resolveEnrage(
      { ...tier.bossEnrage, atMs: { min: 45_000, max: 45_000 } },
      createRng('x'),
    );
    expect(fixed.atMs).toBe(45_000);
    const a = simulateDungeonRun(input({ seed: 'stream-a' }));
    const b = simulateDungeonRun(input({ seed: 'stream-a', bossLootEligible: false }));
    expect(b.enrageAtMs).toBe(a.enrageAtMs);
    expect(b.encounters).toEqual(a.encounters);
  });
});

describe('crypt tiers (ticket 3.6)', () => {
  const tierInput = (tier: 1 | 2 | 3, level: number, classId: ClassId = 'warrior') =>
    input({
      tier,
      character: { classId, level, xp: 0 },
      equipment: cryptGear(classId, level - 1).map((i) => ({
        ...i,
        rarityId: 'legendary' as const,
        // Ticket 4.8: tier III's boss is tougher (health × 3); +10 keeps this hero a sure winner.
        upgradeLevel: 10,
      })),
    });

  it('tier I is the default', () => {
    expect(simulateDungeonRun(input({ tier: 1 }))).toEqual(simulateDungeonRun(input()));
    expect(simulateDungeonRun(input()).tier).toBe(1);
  });

  it('each tier fights in its level range, against its scaled boss, and rolls its own tables', () => {
    for (const t of DUNGEON_TIERS) {
      const def = getDungeonTier('namelessCrypt', t);
      const run = simulateDungeonRun(tierInput(t, def.bossLevel));
      expect(run.tier).toBe(t);
      for (const e of run.encounters.slice(0, -1)) {
        expect(e.enemyLevel).toBeGreaterThanOrEqual(def.minLevel);
        expect(e.enemyLevel).toBeLessThanOrEqual(def.maxLevel);
      }
      const spawn = run.events.findLast((e) => e.type === 'spawn')!;
      if (spawn.type !== 'spawn') throw new Error('no spawn');
      expect(spawn.enemyId).toBe('gravewarden');
      expect(spawn.enemyLevel).toBe(def.bossLevel);
      const stats = deriveCharacterStats('warrior', def.bossLevel, []);
      const plain = buildEncounter(
        scaleEnemy(getEnemy('gravewarden'), def.bossScale),
        def.bossLevel,
        'warrior',
        def.bossLevel,
        stats,
        DEFAULT_COMBAT_CONFIG,
      );
      expect(spawn.enemyHealth).toBe(plain.enemyHealth);
      if (t > 1) {
        const unscaled = buildEncounter(
          getEnemy('gravewarden'),
          def.bossLevel,
          'warrior',
          def.bossLevel,
          stats,
          DEFAULT_COMBAT_CONFIG,
        );
        expect(plain.enemyHealth).toBeGreaterThan(unscaled.enemyHealth);
        expect(plain.enemyHit).toBeGreaterThan(unscaled.enemyHit);
      }
      expect(run.bossDefeated, `tier ${t}`).toBe(true);
      const bossTable = getLootTable(def.bossLoot.lootTableId);
      for (const item of run.items.slice(-def.bossLoot.items)) {
        expect(bossTable.entries.map((e) => e.baseId).concat(item.baseId)).toContain(item.baseId);
        expect(item.itemLevel).toBeGreaterThanOrEqual(bossTable.itemLevel!.min);
        expect(item.itemLevel).toBeLessThanOrEqual(bossTable.itemLevel!.max);
      }
    }
  });

  it('every tier is deterministic and reveals the same run however often it is polled', () => {
    for (const t of DUNGEON_TIERS) {
      const def = getDungeonTier('namelessCrypt', t);
      const run = simulateDungeonRun(tierInput(t, def.bossLevel));
      expect(simulateDungeonRun(tierInput(t, def.bossLevel))).toEqual(run);
      for (const step of [1_000, 7_700, 60_000]) {
        const seen: DungeonEvent[] = [];
        let last = -1;
        for (let at = 0; ; at += step) {
          const p = dungeonRunProgress(run, at, 10_000);
          seen.push(...p.events.filter((e) => e.t > last));
          last = p.elapsedMs;
          if (p.finished) break;
        }
        expect(seen).toEqual(run.events);
      }
    }
  });

  it('rejects an unknown tier', () => {
    expect(() => simulateDungeonRun(input({ tier: 4 as never }))).toThrow(RangeError);
    expect(() => getDungeonTier('namelessCrypt', 0 as never)).toThrow();
  });
});

describe('dungeonRunProgress', () => {
  const run = simulateDungeonRun(input());

  it('never reveals the future or the outcome before the end', () => {
    for (const at of [0, 1_000, 30_000, run.durationMs / 2, run.durationMs - 1]) {
      const p = dungeonRunProgress(run, at, 10_000);
      expect(p.finished).toBe(false);
      expect(p.outcome).toBeNull();
      expect(p.events.every((e) => e.t <= at)).toBe(true);
      expect(p.encounters.every((e) => e.endMs <= at)).toBe(true);
    }
    const end = dungeonRunProgress(run, run.durationMs + 5_000, 10_000);
    expect(end).toMatchObject({
      finished: true,
      outcome: 'cleared',
      stage: 'done',
      roomsCleared: 4,
    });
    expect(end.events).toEqual(run.events);
  });

  it('polling at any rate reveals the same run (invariance)', () => {
    for (const step of [1_000, 3_300, 60_000]) {
      const seen: DungeonEvent[] = [];
      let last = -1;
      for (let at = 0; ; at += step) {
        const p = dungeonRunProgress(run, at, 10_000);
        seen.push(...p.events.filter((e) => e.t > last));
        last = p.elapsedMs;
        if (p.finished) break;
      }
      expect(seen).toEqual(run.events);
    }
  });

  it('tracks rooms, the boss stage, health and the foe', () => {
    const boss = run.encounters.at(-1)!;
    const mid = dungeonRunProgress(run, boss.startMs + 1);
    expect(mid.stage).toBe('boss');
    expect(mid.roomsCleared).toBe(4);
    expect(mid.foe?.enemyId).toBe('gravewarden');
    expect(mid.health).toBeGreaterThan(0);
    expect(dungeonRunProgress(run, 0)).toMatchObject({ stage: 0, roomsCleared: 0, foe: null });
    expect(dungeonRunProgress(run, 0).health).toBe(run.startHealth);
  });
});

describe('boss loot content', () => {
  it('unique bases drop only from the boss table (Mythic and set bases only through their roll)', () => {
    const uniques = ITEM_BASES.filter(
      (b) => b.unique && !mythicForBase(b.id) && !setForBase(b.id),
    ).map((b) => b.id);
    expect(uniques.length).toBeGreaterThanOrEqual(3);
    for (const table of AREA_LOOT_TABLES) {
      for (const e of table.entries) expect(findItemBase(e.baseId)?.unique, e.baseId).toBeFalsy();
    }
    for (const tier of getDungeon('namelessCrypt').tiers) {
      const boss = getLootTable(tier.bossLoot.lootTableId);
      for (const id of uniques) expect(boss.entries.map((e) => e.baseId)).toContain(id);
    }
  });
});
