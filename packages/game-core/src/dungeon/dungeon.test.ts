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
  getEnemy,
  getLootTable,
  resolveDungeonFight,
  simulateDungeonRun,
  type ClassId,
  type DungeonEvent,
  type DungeonRunInput,
  type GeneratedItem,
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
    const dungeon = getDungeon('namelessCrypt');
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
    expect(full.items).toEqual([]);
    expect(full.salvaged).toEqual(free.items);
    expect(full.goldSalvaged).toBeGreaterThan(0);
  });

  it('rejects invalid input', () => {
    expect(() => simulateDungeonRun(input({ seed: '' }))).toThrow(RangeError);
    expect(() =>
      simulateDungeonRun(input({ character: { classId: 'warrior', level: 0, xp: 0 } })),
    ).toThrow(RangeError);
    expect(() => simulateDungeonRun(input({ inventoryCount: -1 }))).toThrow(RangeError);
  });
});

describe('the Gravewarden enrage', () => {
  it('hits harder and faster from the enrage time on', () => {
    const dungeon = getDungeon('namelessCrypt');
    const stats = deriveCharacterStats('warrior', 16, []);
    const setup = {
      ...buildEncounter(getEnemy('gravewarden'), 16, 'warrior', 16, stats, DEFAULT_COMBAT_CONFIG),
      maxFightMs: dungeon.bossMaxFightMs,
      enemyHealth: 1_000_000,
    };
    const log: DungeonEvent[] = [];
    resolveDungeonFight(setup, 1_000_000, createRng('enrage'), 0, log, dungeon.bossEnrage);
    const hits = log.filter((e) => e.type === 'enemyAttack');
    const before = hits.filter((e) => e.t < dungeon.bossEnrage.atMs);
    const after = hits.filter((e) => e.t >= dungeon.bossEnrage.atMs);
    expect(log.filter((e) => e.type === 'enrage')).toEqual([
      { t: dungeon.bossEnrage.atMs, type: 'enrage' },
    ]);
    expect(new Set(before.map((e) => e.damage))).toEqual(new Set([setup.enemyHit]));
    expect(new Set(after.map((e) => e.damage))).toEqual(
      new Set([Math.round(setup.enemyHit * dungeon.bossEnrage.damageMultiplier)]),
    );
    const gap = (xs: { t: number }[]) => xs[xs.length - 1]!.t - xs[xs.length - 2]!.t;
    expect(gap(after)).toBeLessThan(gap(before));
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
  it('unique bases drop only from the boss table', () => {
    const uniques = ITEM_BASES.filter((b) => b.unique).map((b) => b.id);
    expect(uniques.length).toBeGreaterThanOrEqual(3);
    for (const table of AREA_LOOT_TABLES) {
      for (const e of table.entries) expect(uniques).not.toContain(e.baseId);
    }
    const boss = getLootTable(getDungeon('namelessCrypt').bossLoot.lootTableId);
    for (const id of uniques) expect(boss.entries.map((e) => e.baseId)).toContain(id);
  });
});
