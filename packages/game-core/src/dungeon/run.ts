import { isClassId, type ClassId } from '../classes.js';
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig } from '../activity/config.js';
import { equipmentModifiers } from '../activity/equipment.js';
import { salvageValue } from '../activity/settle.js';
import { deriveCharacterStats, type StatBlock } from '../combat/characterStats.js';
import {
  DEFAULT_COMBAT_CONFIG,
  buildEncounter,
  rollEncounter,
  type CombatConfig,
  type EncounterSetup,
} from '../combat/encounter.js';
import { MAX_LEVEL, applyXp, xpToNextLevel } from '../combat/progression.js';
import type { QuestEvent } from '../quests/events.js';
import { DEFAULT_LOOT_CONFIG, getLootTable, type LootConfig } from '../loot/config.js';
import { generateItem, rollItemLevel, rollLoot, type GeneratedItem } from '../loot/generate.js';
import { RARITY_IDS } from '../rarity.js';
import { createRng, type Rng } from '../rng.js';
import {
  getDungeon,
  isDungeonId,
  type BossEnrage,
  type DungeonDefinition,
  type DungeonId,
} from '../world/dungeons.js';
import { getEnemy, type EnemyId } from '../world/enemies.js';
import type { MaterialId } from '../world/materials.js';

/**
 * Dungeon runs (ticket 2.5, GDD §11.2). A run is a fixed sequence: walk into each room, fight its
 * enemies one after another, then walk into the boss chamber and fight the boss. Everything is
 * decided by the server seed and the character snapshot taken at the start, so the whole run is
 * known the moment it starts; the server only *reveals* it as real time passes
 * (`dungeonRunProgress`). Settling or polling more or less often therefore cannot change anything.
 */

/** Combat log of a run; `t` is ms since the run started. Health values are after the event. */
export type DungeonEvent =
  /** Entering room `room` (0-based), or the boss chamber (`room: null`). */
  | { t: number; type: 'enter'; room: number | null }
  | {
      t: number;
      type: 'spawn';
      enemyId: EnemyId;
      enemyLevel: number;
      enemyHealth: number;
      health: number;
      maxHealth: number;
    }
  | {
      t: number;
      type: 'attack';
      damage: number;
      crit: boolean;
      skill: boolean;
      enemyHealth: number;
    }
  | { t: number; type: 'enemyAttack'; damage: number; health: number }
  | { t: number; type: 'enrage' }
  | { t: number; type: 'kill'; enemyId: EnemyId; xp: number }
  | { t: number; type: 'levelUp'; level: number; health: number; maxHealth: number }
  | { t: number; type: 'death'; enemyId: EnemyId }
  | { t: number; type: 'timeout'; enemyId: EnemyId }
  | { t: number; type: 'end'; outcome: DungeonRunOutcome };

export type DungeonRunOutcome = 'cleared' | 'failed';

/** One fight of a run. */
export interface DungeonEncounterRecord {
  /** Position in the run (0-based; the boss is last). */
  index: number;
  /** Room index, or null for the boss. */
  room: number | null;
  enemyId: EnemyId;
  enemyLevel: number;
  startMs: number;
  endMs: number;
  outcome: 'kill' | 'death' | 'timeout';
  xp: number;
}

export interface DungeonRunInput {
  dungeonId: DungeonId;
  /** Snapshot at the start of the run; the run always starts at full health. */
  character: { classId: ClassId; level: number; xp: number };
  /** Equipped items at the start of the run (persisted `GeneratedItem` columns). */
  equipment?: readonly Pick<GeneratedItem, 'baseId' | 'rarityId' | 'itemLevel' | 'affixes'>[];
  /** Server-generated secret of this run. Never accept a seed from the client. */
  seed: string;
  /** Whether a boss kill drops boss loot (the cooldown is checked by the server at run start). */
  bossLootEligible: boolean;
  /** Unequipped items held when the result is claimed (capacity rule). */
  inventoryCount: number;
}

export interface DungeonRunOptions {
  activity?: ActivityConfig;
  combat?: CombatConfig;
  loot?: LootConfig;
}

export interface DungeonRunResult {
  dungeonId: DungeonId;
  outcome: DungeonRunOutcome;
  /** Real time the run takes: until the boss falls or the hero does. */
  durationMs: number;
  totalRooms: number;
  /** Hero health (full) when the run starts. */
  startHealth: number;
  /** Rooms whose every enemy was killed. */
  roomsCleared: number;
  encounters: DungeonEncounterRecord[];
  events: DungeonEvent[];
  kills: number;
  killsByEnemy: Partial<Record<EnemyId, number>>;
  xpGained: number;
  startLevel: number;
  level: number;
  xp: number;
  levelsGained: number;
  bossDefeated: boolean;
  /** Whether boss loot dropped (boss killed and off cooldown). */
  bossLoot: boolean;
  /** Gold from room kills and the boss purse (after gold find). */
  goldLooted: number;
  /** Gold from items salvaged because the inventory was full. */
  goldSalvaged: number;
  /** Items to add, in drop order (boss items last). */
  items: GeneratedItem[];
  /** Items that did not fit and were salvaged to gold. */
  salvaged: GeneratedItem[];
  materials: Partial<Record<MaterialId, number>>;
  /** Events for quests (ticket 2.4), e.g. `{ type: 'bossDefeated', bossId: 'gravewarden' }`. */
  questEvents: QuestEvent[];
}

const MAX_SEED = 0xffffffff;

function validate(input: DungeonRunInput): void {
  if (!isDungeonId(input.dungeonId))
    throw new RangeError(`Unknown dungeon: ${String(input.dungeonId)}`);
  const { classId, level, xp } = input.character;
  if (!isClassId(classId)) throw new RangeError(`Unknown class: ${String(classId)}`);
  if (!Number.isInteger(level) || level < 1 || level > MAX_LEVEL)
    throw new RangeError(`Invalid level: ${level}`);
  const need = xpToNextLevel(level);
  if (!Number.isInteger(xp) || xp < 0 || (need > 0 && xp >= need) || (need === 0 && xp !== 0))
    throw new RangeError(`Invalid xp: ${xp}`);
  if (!Number.isInteger(input.inventoryCount) || input.inventoryCount < 0)
    throw new RangeError(`Invalid inventoryCount: ${input.inventoryCount}`);
  if (typeof input.seed !== 'string' || input.seed.length === 0)
    throw new RangeError('A dungeon run needs a server seed.');
}

/**
 * Resolves one fight attack by attack (same timeline rules as `resolveFightDetailed`: the hero
 * attacks at `j · playerInterval`, the enemy at its own rhythm, the hero first on ties, nothing
 * after `maxFightMs`). With `enrage`, enemy hits from `enrage.atMs` on are stronger and faster.
 */
export function resolveDungeonFight(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs: number,
  log: DungeonEvent[],
  enrage?: BossEnrage,
): { kind: 'kill' | 'death' | 'timeout'; offsetMs: number; health: number } {
  let enemyHealth = setup.enemyHealth;
  let hp = health;
  let attack = 1;
  let nextEnemy = setup.enemyIntervalMs;
  let enraged = false;
  const enragedInterval = enrage
    ? Math.max(1, Math.round(setup.enemyIntervalMs / enrage.attackSpeedMultiplier))
    : setup.enemyIntervalMs;
  for (;;) {
    const p = attack * setup.playerIntervalMs;
    const e = nextEnemy;
    const next = Math.min(p, e);
    if (enrage && !enraged && next >= enrage.atMs && enrage.atMs <= setup.maxFightMs) {
      enraged = true;
      log.push({ t: startMs + enrage.atMs, type: 'enrage' });
    }
    if (p <= setup.maxFightMs && p <= e) {
      const skill = attack % setup.skillEvery === 0;
      const hit = skill ? setup.skill : setup.auto;
      const crit = rng.chance(hit.critChance);
      const damage = crit ? hit.crit : hit.normal;
      enemyHealth = Math.max(0, enemyHealth - damage);
      log.push({ t: startMs + p, type: 'attack', damage, crit, skill, enemyHealth });
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: p, health: hp };
      attack++;
    } else if (e <= setup.maxFightMs) {
      const strong = enrage !== undefined && e >= enrage.atMs;
      const raw = strong
        ? Math.max(1, Math.round(setup.enemyHit * enrage.damageMultiplier))
        : setup.enemyHit;
      const damage = Math.min(hp, raw);
      hp -= damage;
      log.push({ t: startMs + e, type: 'enemyAttack', damage, health: hp });
      if (hp <= 0) return { kind: 'death', offsetMs: e, health: 0 };
      nextEnemy = e + (strong ? enragedInterval : setup.enemyIntervalMs);
    } else {
      return { kind: 'timeout', offsetMs: setup.maxFightMs, health: hp };
    }
  }
}

/**
 * Plays a whole dungeon run. Pure and deterministic: the same input gives the same run.
 *
 * RNG streams (per encounter, like farming's per-cycle streams): room enemy `k` of room `r` draws
 * its encounter and fight from `${seed}:room:${r}:${k}` and its loot from `${seed}:loot:${r}:${k}`;
 * the boss fight from `${seed}:boss`, the boss loot from `${seed}:boss-loot`. So changing one
 * fight's number of draws never shifts another fight.
 *
 * XP is applied per kill (a level-up recomputes the stats and restores full health, as in
 * farming). A death or a timeout ends the run as `failed`: the rewards of the kills before it are
 * kept, the boss drops nothing, and no progress is ever removed.
 */
export function simulateDungeonRun(
  input: DungeonRunInput,
  options: DungeonRunOptions = {},
): DungeonRunResult {
  validate(input);
  const activity = options.activity ?? DEFAULT_ACTIVITY_CONFIG;
  const combat = options.combat ?? DEFAULT_COMBAT_CONFIG;
  const lootConfig = options.loot ?? DEFAULT_LOOT_CONFIG;
  const dungeon: DungeonDefinition = getDungeon(input.dungeonId);
  const roomTable = getLootTable(dungeon.lootTableId);
  const { classId } = input.character;
  const modifiers = equipmentModifiers(input.equipment ?? [], activity.modifierCaps, lootConfig);

  let level = input.character.level;
  let xp = input.character.xp;
  let stats: StatBlock = deriveCharacterStats(classId, level, modifiers.stats);
  let health = stats.health;
  const startHealth = health;
  let now = 0;
  let goldLooted = 0;
  let xpGained = 0;
  let kills = 0;
  let roomsCleared = 0;
  const killsByEnemy: Partial<Record<EnemyId, number>> = {};
  const drops: GeneratedItem[] = [];
  const materials: Partial<Record<MaterialId, number>> = {};
  const events: DungeonEvent[] = [];
  const encounters: DungeonEncounterRecord[] = [];
  const questEvents: QuestEvent[] = [];

  const regen = (ms: number) => {
    const gained = Math.floor((stats.health * combat.outOfCombatRegenPerSecond * ms) / 1000);
    health = Math.min(stats.health, health + gained);
  };

  /** Fights one enemy; returns false when the run is lost. */
  const fight = (
    setup: EncounterSetup,
    rng: Rng,
    room: number | null,
    enrage?: BossEnrage,
  ): boolean => {
    const startMs = now;
    events.push({
      t: startMs,
      type: 'spawn',
      enemyId: setup.enemyId,
      enemyLevel: setup.enemyLevel,
      enemyHealth: setup.enemyHealth,
      health,
      maxHealth: stats.health,
    });
    const outcome = resolveDungeonFight(setup, health, rng, startMs, events, enrage);
    now = startMs + outcome.offsetMs;
    health = outcome.health;
    const won = outcome.kind === 'kill';
    encounters.push({
      index: encounters.length,
      room,
      enemyId: setup.enemyId,
      enemyLevel: setup.enemyLevel,
      startMs,
      endMs: now,
      outcome: outcome.kind,
      xp: won ? setup.xpReward : 0,
    });
    if (!won) {
      events.push({
        t: now,
        type: outcome.kind === 'death' ? 'death' : 'timeout',
        enemyId: setup.enemyId,
      });
      return false;
    }
    kills++;
    killsByEnemy[setup.enemyId] = (killsByEnemy[setup.enemyId] ?? 0) + 1;
    xpGained += setup.xpReward;
    events.push({ t: now, type: 'kill', enemyId: setup.enemyId, xp: setup.xpReward });
    const after = applyXp({ level, xp }, setup.xpReward);
    if (after.level !== level) {
      stats = deriveCharacterStats(classId, after.level, modifiers.stats);
      health = stats.health;
      for (let l = level + 1; l <= after.level; l++)
        events.push({ t: now, type: 'levelUp', level: l, health, maxHealth: stats.health });
    }
    level = after.level;
    xp = after.xp;
    return true;
  };

  let alive = true;
  for (let r = 0; r < dungeon.rooms.length && alive; r++) {
    events.push({ t: now, type: 'enter', room: r });
    now += dungeon.travelMs;
    regen(dungeon.travelMs);
    for (let k = 0; k < dungeon.rooms[r]!.enemies; k++) {
      if (k > 0) {
        now += combat.searchMs;
        regen(combat.searchMs);
      }
      const rng = createRng(`${input.seed}:room:${r}:${k}`);
      const characterLevel = level;
      const setup = rollEncounter(rng, dungeon, classId, characterLevel, stats, combat);
      if (!fight(setup, rng, r)) {
        alive = false;
        break;
      }
      const drop = rollLoot(
        {
          rng: createRng(`${input.seed}:loot:${r}:${k}`),
          sourceLevel: setup.enemyLevel,
          lootTable: roomTable,
          goldFind: modifiers.goldFind,
        },
        lootConfig,
      );
      goldLooted += drop.gold;
      drops.push(...drop.items);
    }
    if (alive) roomsCleared++;
  }

  let bossDefeated = false;
  let bossLoot = false;
  if (alive) {
    events.push({ t: now, type: 'enter', room: null });
    now += dungeon.travelMs;
    regen(dungeon.travelMs);
    const setup: EncounterSetup = {
      ...buildEncounter(getEnemy(dungeon.bossId), dungeon.bossLevel, classId, level, stats, combat),
      maxFightMs: dungeon.bossMaxFightMs,
    };
    bossDefeated = fight(setup, createRng(`${input.seed}:boss`), null, dungeon.bossEnrage);
    if (bossDefeated) {
      questEvents.push({ type: 'bossDefeated', bossId: dungeon.bossId });
      if (input.bossLootEligible) {
        bossLoot = true;
        const loot = rollBossLoot(
          dungeon,
          createRng(`${input.seed}:boss-loot`),
          modifiers.goldFind,
          lootConfig,
        );
        goldLooted += loot.gold;
        drops.push(...loot.items);
        for (const m of dungeon.bossDrops) materials[m] = (materials[m] ?? 0) + 1;
      }
    }
  }
  const outcome: DungeonRunOutcome = bossDefeated ? 'cleared' : 'failed';
  events.push({ t: now, type: 'end', outcome });

  // Capacity rule as in farming: drops beyond the free space are salvaged to gold.
  let free = Math.max(0, activity.inventory.capacity - input.inventoryCount);
  const items: GeneratedItem[] = [];
  const salvaged: GeneratedItem[] = [];
  let goldSalvaged = 0;
  for (const item of drops) {
    if (free > 0) {
      items.push(item);
      free--;
    } else {
      salvaged.push(item);
      goldSalvaged += salvageValue(item, activity.inventory);
    }
  }

  return {
    dungeonId: dungeon.id,
    outcome,
    durationMs: now,
    totalRooms: dungeon.rooms.length,
    startHealth,
    roomsCleared,
    encounters,
    events,
    kills,
    killsByEnemy,
    xpGained,
    startLevel: input.character.level,
    level,
    xp,
    levelsGained: level - input.character.level,
    bossDefeated,
    bossLoot,
    goldLooted,
    goldSalvaged,
    items,
    salvaged,
    materials,
    questEvents,
  };
}

/** Boss items (fixed count, boosted rarity odds) and the boss purse. */
function rollBossLoot(
  dungeon: DungeonDefinition,
  rng: Rng,
  goldFind: number,
  config: LootConfig,
): { gold: number; items: GeneratedItem[] } {
  const { bossLoot } = dungeon;
  const table = getLootTable(bossLoot.lootTableId);
  const bossConfig: LootConfig = {
    ...config,
    rarities: Object.fromEntries(
      RARITY_IDS.map((id) => [id, { ...config.rarities[id], weight: bossLoot.rarityWeights[id] }]),
    ) as LootConfig['rarities'],
  };
  const bonus = Number.isFinite(goldFind) ? Math.max(0, goldFind) : 0;
  const gold = Math.max(1, Math.round(rng.int(bossLoot.gold.min, bossLoot.gold.max) * (1 + bonus)));
  const items: GeneratedItem[] = [];
  for (let n = 0; n < bossLoot.items; n++) {
    const rolled = rollItemLevel(dungeon.bossLevel, rng, config);
    const itemLevel = table.itemLevel
      ? Math.min(table.itemLevel.max, Math.max(table.itemLevel.min, rolled))
      : rolled;
    const item = generateItem(
      { seed: rng.int(0, MAX_SEED), itemLevel, lootTable: table },
      bossConfig,
    );
    if (item) items.push(item);
  }
  return { gold, items };
}

export interface DungeonFoe {
  enemyId: EnemyId;
  enemyLevel: number;
  health: number;
  maxHealth: number;
}

/** What the client may see of a run at `elapsedMs` (never its future). */
export interface DungeonRunProgress {
  elapsedMs: number;
  durationMs: number;
  finished: boolean;
  /** Known only once finished. */
  outcome: DungeonRunOutcome | null;
  totalRooms: number;
  /** Rooms cleared so far. */
  roomsCleared: number;
  /** Where the hero is: a room index, `boss`, or `done`. */
  stage: number | 'boss' | 'done';
  /** Fights that have ended so far. */
  encounters: DungeonEncounterRecord[];
  /** The most recent events up to `elapsedMs` (at most `maxEvents`). */
  events: DungeonEvent[];
  /** Hero health at `elapsedMs`. */
  health: number;
  maxHealth: number;
  /** The enemy being fought at `elapsedMs`, if any. */
  foe: DungeonFoe | null;
  enraged: boolean;
}

/** Reveals a run up to `elapsedMs` (clamped to `[0, durationMs]`). */
export function dungeonRunProgress(
  run: DungeonRunResult,
  elapsedMs: number,
  maxEvents = 40,
): DungeonRunProgress {
  const at = Math.min(run.durationMs, Math.max(0, Math.floor(elapsedMs)));
  const finished = elapsedMs >= run.durationMs;
  let n = 0;
  while (n < run.events.length && run.events[n]!.t <= at) n++;
  const seen = run.events.slice(0, n);

  let health = run.startHealth;
  let maxHealth = run.startHealth;
  let foe = null as DungeonFoe | null;
  let enraged = false;
  let stage: DungeonRunProgress['stage'] = 0;
  for (const e of seen) {
    switch (e.type) {
      case 'enter':
        stage = e.room === null ? 'boss' : e.room;
        foe = null;
        break;
      case 'spawn':
        health = e.health;
        maxHealth = e.maxHealth;
        foe = {
          enemyId: e.enemyId,
          enemyLevel: e.enemyLevel,
          health: e.enemyHealth,
          maxHealth: e.enemyHealth,
        };
        enraged = false;
        break;
      case 'attack':
        if (foe) foe = { ...foe, health: e.enemyHealth };
        break;
      case 'enemyAttack':
        health = e.health;
        break;
      case 'enrage':
        enraged = true;
        break;
      case 'levelUp':
        health = e.health;
        maxHealth = e.maxHealth;
        break;
      case 'kill':
      case 'death':
      case 'timeout':
        foe = null;
        break;
      case 'end':
        stage = 'done';
        break;
    }
  }
  const encounters = run.encounters.filter((x) => x.endMs <= at);
  const roomsCleared = countClearedRooms(run, at);
  return {
    elapsedMs: at,
    durationMs: run.durationMs,
    finished,
    outcome: finished ? run.outcome : null,
    totalRooms: run.totalRooms,
    roomsCleared,
    stage,
    encounters,
    events: maxEvents > 0 ? seen.slice(-maxEvents) : [],
    health,
    maxHealth,
    foe,
    enraged,
  };
}

function countClearedRooms(run: DungeonRunResult, at: number): number {
  let cleared = 0;
  for (let r = 0; r < run.totalRooms; r++) {
    const fights = run.encounters.filter((x) => x.room === r);
    if (fights.length === 0 || fights.some((x) => x.outcome !== 'kill')) break;
    const last = fights[fights.length - 1]!;
    if (last.endMs > at) break;
    cleared++;
  }
  return Math.min(cleared, run.roomsCleared);
}
