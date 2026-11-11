import { setBonusInstances } from '../items/sets.js';
import { isClassId, type ClassId } from '../classes.js';
import { DEFAULT_ACTIVITY_CONFIG, type ActivityConfig } from '../activity/config.js';
import { equipmentModifiers, type EquippedItem } from '../activity/equipment.js';
import { lifeOnKillHeal, momentumAfterIdle } from '../combat/farming.js';
import { hasCombatEffects } from '../effects/resolve.js';
import { createDropPlacer, type FilteredDrop } from '../activity/placement.js';
import type { LootFilterRules } from '../economy/lootFilter.js';
import { deriveCharacterStats, type StatBlock } from '../combat/characterStats.js';
import {
  DEFAULT_COMBAT_CONFIG,
  attackHit,
  buildEncounter,
  rollEncounter,
  thornsDamage,
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
  getDungeonTier,
  isDungeonId,
  isDungeonTier,
  type BossEnrage,
  type BossMechanics,
  type DungeonDefinition,
  type DungeonId,
  type DungeonTier,
  type DungeonTierDefinition,
  type EnemyScale,
  type ResolvedEnrage,
} from '../world/dungeons.js';
import { getEnemy, type EnemyDefinition, type EnemyId } from '../world/enemies.js';
import {
  applyBossModifier,
  getBossModifier,
  isBossModifierId,
  type BossModifierId,
} from './modifiers.js';
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
  /** Ticket 6.2: `heavy` marks a boss's heavy blow (`BossMechanics.heavyBlow`); absent otherwise. */
  | { t: number; type: 'enemyAttack'; damage: number; health: number; heavy?: true }
  /** Ticket 6.2: the boss's shell broke (`BossMechanics.shell`). */
  | { t: number; type: 'shellBroken' }
  /** Ticket 6.3 ("Burning"): the hero burned for `damage` (`BossMechanics.burn`). */
  | { t: number; type: 'burn'; damage: number; health: number }
  /** Ticket 6.3 ("Warded"): the boss's ward rose / broke (`BossMechanics.ward`). */
  | { t: number; type: 'wardRaised' }
  | { t: number; type: 'wardBroken' }
  /** Ticket 6.3 ("Frenzied"): the boss's frenzy began (`BossMechanics.frenzy`). */
  | { t: number; type: 'frenzy' }
  /** Thorns (ticket 3.2): the enemy took `damage` from its own blow. */
  | { t: number; type: 'thorns'; damage: number; enemyHealth: number }
  /** Life on kill (ticket 3.2): the hero healed `amount` after a kill. */
  | { t: number; type: 'heal'; amount: number; health: number }
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
  /** Difficulty tier (ticket 3.6); default 1. */
  tier?: DungeonTier;
  /** Snapshot at the start of the run; the run always starts at full health. */
  character: { classId: ClassId; level: number; xp: number };
  /** Equipped items at the start of the run (persisted `GeneratedItem` columns incl. effects). */
  equipment?: readonly EquippedItem[];
  /** Server-generated secret of this run. Never accept a seed from the client. */
  seed: string;
  /** Whether a boss kill drops boss loot (the cooldown is checked by the server at run start). */
  bossLootEligible: boolean;
  /** Unequipped items held when the result is claimed (capacity rule). */
  inventoryCount: number;
  /**
   * Ticket 3.7: the loot filter in force at the claim (read under the character lock). It only
   * decides what happens to the drops; null or absent = no filter, exactly as before.
   */
  lootFilter?: LootFilterRules | null;
  /**
   * Ticket 6.3: the weekly boss modifier of the week the run started in (stored with the run).
   * Null or absent = none: the run is exactly what it was before 6.3.
   */
  bossModifier?: BossModifierId | null;
}

export interface DungeonRunOptions {
  activity?: ActivityConfig;
  combat?: CombatConfig;
  loot?: LootConfig;
}

export interface DungeonRunResult {
  dungeonId: DungeonId;
  tier: DungeonTier;
  /**
   * Ticket 6.3: the boss modifier the run was fought with; absent without one, so a run without a
   * modifier is exactly the pre-6.3 result.
   */
  bossModifier?: BossModifierId;
  /** When the boss enrages in this run (ms into the boss fight; ticket 3.6 draws it per run). */
  enrageAtMs: number;
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
  /** Ticket B.2: valuable drops among `items` kept beyond the pack's capacity. */
  overCapacity: GeneratedItem[];
  /** Ordinary items that did not fit and were salvaged to gold. */
  salvaged: GeneratedItem[];
  /** Ticket 3.7: drops the loot filter handled; present only when a filter was given. */
  filtered?: FilteredDrop[];
  materials: Partial<Record<MaterialId, number>>;
  /** Events for quests (ticket 2.4), e.g. `{ type: 'bossDefeated', bossId: 'gravewarden' }`. */
  questEvents: QuestEvent[];
}

const MAX_SEED = 0xffffffff;

function validate(input: DungeonRunInput): void {
  if (!isDungeonId(input.dungeonId))
    throw new RangeError(`Unknown dungeon: ${String(input.dungeonId)}`);
  if (input.tier !== undefined && !isDungeonTier(input.tier))
    throw new RangeError(`Unknown dungeon tier: ${String(input.tier)}`);
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
  if (
    input.bossModifier !== undefined &&
    input.bossModifier !== null &&
    !isBossModifierId(input.bossModifier)
  )
    throw new RangeError(`Unknown boss modifier: ${String(input.bossModifier)}`);
}

/**
 * Resolves one fight attack by attack (same timeline rules as `resolveFightDetailed`: the hero
 * attacks at `j · playerInterval`, the enemy at its own rhythm, the hero first on ties, nothing
 * after `maxFightMs`). With `enrage`, enemy hits from `enrage.atMs` on are stronger and faster.
 * Ticket 6.2: with `mechanics`, the boss's shell and heavy blows apply (no extra draws; without
 * them every fight is exactly as before). Ticket 6.3: the weekly modifiers' burn, ward and frenzy
 * too; `phaseClockMs` (a boss that cannot fall: the guild boss) reads the ward's and frenzy's
 * health share from the clock instead (1 at the start, 0 at `phaseClockMs`).
 */
export function resolveDungeonFight(
  setup: EncounterSetup,
  health: number,
  rng: Rng,
  startMs: number,
  log: DungeonEvent[],
  enrage?: ResolvedEnrage,
  mechanics?: BossMechanics,
  phaseClockMs?: number,
): { kind: 'kill' | 'death' | 'timeout'; offsetMs: number; health: number } {
  let enemyHealth = setup.enemyHealth;
  let hp = health;
  let attack = 1;
  let nextEnemy = setup.enemyIntervalMs;
  let enraged = false;
  let prevCrit = false;
  const enragedInterval = enrage
    ? Math.max(1, Math.round(setup.enemyIntervalMs / enrage.attackSpeedMultiplier))
    : setup.enemyIntervalMs;
  const shell = mechanics?.shell;
  let shellUp = shell !== undefined;
  const shellFloor = shell ? setup.enemyHealth * shell.untilHealthShare : 0;
  const heavyBlow = mechanics?.heavyBlow;
  let blows = 0;
  // Ticket 6.3: the weekly modifiers (absent: Infinity and no phase, so nothing changes).
  const burn = mechanics?.burn;
  let nextBurn = burn ? burn.everyMs : Infinity;
  const burnDamage = burn ? Math.max(1, Math.round(setup.enemyHit * burn.damageShare)) : 0;
  const ward = mechanics?.ward;
  let wardState: 'before' | 'up' | 'done' = 'before';
  const frenzy = mechanics?.frenzy;
  let frenzied = false;
  const phased = ward !== undefined || frenzy !== undefined;
  /** The boss's health share for the ward and frenzy (by the clock for a boss that can't fall). */
  const share = (offset: number): number =>
    phaseClockMs && phaseClockMs > 0
      ? Math.max(0, 1 - offset / phaseClockMs)
      : enemyHealth / setup.enemyHealth;
  const phases = (offset: number) => {
    if (ward && wardState !== 'done') {
      const s = share(offset);
      if (s <= ward.toHealthShare) {
        if (wardState === 'up') log.push({ t: startMs + offset, type: 'wardBroken' });
        wardState = 'done';
      } else if (wardState === 'before' && s <= ward.fromHealthShare) {
        wardState = 'up';
        log.push({ t: startMs + offset, type: 'wardRaised' });
      }
    }
    if (frenzy && !frenzied && share(offset) <= frenzy.belowHealthShare) {
      frenzied = true;
      log.push({ t: startMs + offset, type: 'frenzy' });
    }
  };
  /** What a blow of `damage` takes off the boss (its shell, or its ward, softens it). */
  const dealt = (damage: number): number => {
    let m = shellUp ? shell!.damageTakenMultiplier : 1;
    if (wardState === 'up') m *= ward!.damageTakenMultiplier;
    return m === 1 ? damage : Math.max(1, Math.round(damage * m));
  };
  const breakShell = (t: number) => {
    if (shellUp && enemyHealth > 0 && enemyHealth <= shellFloor) {
      shellUp = false;
      log.push({ t, type: 'shellBroken' });
    }
  };
  for (;;) {
    const p = attack * setup.playerIntervalMs;
    const e = nextEnemy;
    const b = nextBurn;
    const next = Math.min(p, e, b);
    if (enrage && !enraged && next >= enrage.atMs && enrage.atMs <= setup.maxFightMs) {
      enraged = true;
      log.push({ t: startMs + enrage.atMs, type: 'enrage' });
    }
    if (phased && next <= setup.maxFightMs) phases(next);
    if (p <= setup.maxFightMs && p <= e && p <= b) {
      const hit = attackHit(setup, attack, prevCrit, hp, enemyHealth);
      const crit = rng.chance(hit.critChance);
      prevCrit = crit && !hit.surged;
      const damage = dealt(crit ? hit.crit : hit.normal);
      enemyHealth = Math.max(0, enemyHealth - damage);
      log.push({ t: startMs + p, type: 'attack', damage, crit, skill: hit.skill, enemyHealth });
      if (enemyHealth <= 0) return { kind: 'kill', offsetMs: p, health: hp };
      breakShell(startMs + p);
      if (phased) phases(p);
      attack++;
    } else if (e <= setup.maxFightMs && e <= b) {
      const strong = enrage !== undefined && e >= enrage.atMs;
      blows++;
      const heavy = heavyBlow !== undefined && blows % heavyBlow.every === 0;
      const multiplier =
        (strong ? enrage.damageMultiplier : 1) * (heavy ? heavyBlow.damageMultiplier : 1);
      const raw =
        multiplier === 1 ? setup.enemyHit : Math.max(1, Math.round(setup.enemyHit * multiplier));
      const damage = Math.min(hp, raw);
      hp -= damage;
      log.push({
        t: startMs + e,
        type: 'enemyAttack',
        damage,
        health: hp,
        ...(heavy ? { heavy: true as const } : {}),
      });
      if (hp <= 0) return { kind: 'death', offsetMs: e, health: 0 };
      const thorns = thornsDamage(setup, strong ? enrage.damageMultiplier : 1);
      if (thorns > 0) {
        const taken = dealt(thorns);
        enemyHealth = Math.max(0, enemyHealth - taken);
        log.push({ t: startMs + e, type: 'thorns', damage: taken, enemyHealth });
        if (enemyHealth <= 0) return { kind: 'kill', offsetMs: e, health: hp };
        breakShell(startMs + e);
        if (phased) phases(e);
      }
      const interval = strong ? enragedInterval : setup.enemyIntervalMs;
      nextEnemy =
        e +
        (frenzied ? Math.max(1, Math.round(interval / frenzy!.attackSpeedMultiplier)) : interval);
    } else if (b <= setup.maxFightMs) {
      // Ticket 6.3: a burn tick (its own timeline; never enraged, never mitigated again).
      const damage = Math.min(hp, burnDamage);
      hp -= damage;
      log.push({ t: startMs + b, type: 'burn', damage, health: hp });
      if (hp <= 0) return { kind: 'death', offsetMs: b, health: 0 };
      nextBurn = b + burn!.everyMs;
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
  const tier = getDungeonTier(input.dungeonId, input.tier ?? 1);
  const roomTable = getLootTable(tier.lootTableId);
  const roomArea = { enemies: dungeon.enemies, minLevel: tier.minLevel, maxLevel: tier.maxLevel };
  const { classId } = input.character;
  const equipment = input.equipment ?? [];
  const modifiers = equipmentModifiers(equipment, activity.modifierCaps, lootConfig, {
    classId,
    extraEffects: setBonusInstances(equipment),
  });
  const effects = hasCombatEffects(modifiers.effects) ? modifiers.effects : undefined;
  // Bloodrush stacks (ticket 3.2): a run starts without a streak; walking between rooms lets
  // stacks fade (one per `decayMs` out of combat).
  let momentum = 0;
  const effectContext = (idleMs: number) =>
    effects ? { effects, momentum: momentumAfterIdle(momentum, idleMs, effects) } : undefined;
  const encounterModifiers = {
    xpGain: modifiers.xpGain,
    skillDamage: modifiers.skillDamage,
    bossDamage: modifiers.bossDamage,
  };

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
    fightMomentum: number,
    enrage?: ResolvedEnrage,
    mechanics?: BossMechanics,
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
    const outcome = resolveDungeonFight(setup, health, rng, startMs, events, enrage, mechanics);
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
    if (effects) {
      momentum = Math.min(effects.bloodrush.maxStacks, fightMomentum + 1);
      const heal = Math.min(stats.health - health, lifeOnKillHeal(stats.health, effects));
      if (heal > 0) {
        health += heal;
        events.push({ t: now, type: 'heal', amount: heal, health });
      }
    }
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
      const context = effectContext(k > 0 ? combat.searchMs : dungeon.travelMs);
      const setup = tier.roomScale
        ? rollScaledEncounter(
            rng,
            roomArea,
            tier.roomScale,
            classId,
            characterLevel,
            stats,
            combat,
            encounterModifiers,
            context,
          )
        : rollEncounter(
            rng,
            roomArea,
            classId,
            characterLevel,
            stats,
            combat,
            encounterModifiers,
            context,
          );
      if (!fight(setup, rng, r, context?.momentum ?? 0)) {
        alive = false;
        break;
      }
      const drop = rollLoot(
        {
          rng: createRng(`${input.seed}:loot:${r}:${k}`),
          sourceLevel: setup.enemyLevel,
          lootTable: roomTable,
          goldFind: modifiers.goldFind,
          itemFind: modifiers.itemFind,
          classId,
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
  // Ticket 6.3: the week's modifier reshapes the boss (none: the tier's data as it is).
  // A tier that takes no modifier (crypt tier I, owner decision) ignores one, so it always fights
  // exactly as before 6.3.
  const bossModifier = tier.bossModifiers === false ? null : (input.bossModifier ?? null);
  const boss = applyBossModifier(
    { scale: tier.bossScale, enrage: tier.bossEnrage, mechanics: tier.bossMechanics },
    bossModifier,
  );
  // Ticket 3.6: the enrage moment has its own stream, so it never shifts another draw.
  const enrage = resolveEnrage(boss.enrage, createRng(`${input.seed}:boss-enrage`));
  if (alive) {
    events.push({ t: now, type: 'enter', room: null });
    now += dungeon.travelMs;
    regen(dungeon.travelMs);
    const context = effectContext(dungeon.travelMs);
    const built = buildEncounter(
      scaleEnemy(getEnemy(dungeon.bossId), boss.scale),
      tier.bossLevel,
      classId,
      level,
      stats,
      combat,
      encounterModifiers,
      context,
    );
    const setup: EncounterSetup = {
      ...built,
      ...(boss.attackSpeedMultiplier !== 1
        ? {
            enemyIntervalMs: Math.max(
              1,
              Math.round(built.enemyIntervalMs / boss.attackSpeedMultiplier),
            ),
          }
        : {}),
      maxFightMs: tier.bossMaxFightMs,
    };
    bossDefeated = fight(
      setup,
      createRng(`${input.seed}:boss`),
      null,
      context?.momentum ?? 0,
      enrage,
      boss.mechanics,
    );
    if (bossDefeated) {
      questEvents.push({ type: 'bossDefeated', bossId: dungeon.bossId });
      if (input.bossLootEligible) {
        bossLoot = true;
        const loot = rollBossLoot(
          tier,
          createRng(`${input.seed}:boss-loot`),
          modifiers.goldFind,
          lootConfig,
          classId,
          bossModifier,
        );
        goldLooted += loot.gold;
        drops.push(...loot.items);
        for (const m of dungeon.bossDrops) materials[m] = (materials[m] ?? 0) + 1;
      }
    }
  }
  const outcome: DungeonRunOutcome = bossDefeated ? 'cleared' : 'failed';
  events.push({ t: now, type: 'end', outcome });

  // Loot filter and capacity rule as in farming (ticket 3.7): filtered drops take no space, drops
  // beyond the free space are salvaged to gold, valuable ones kept beyond it (ticket B.2).
  const placer = createDropPlacer(input.inventoryCount, activity.inventory, input.lootFilter);
  for (const item of drops) placer.place(item);
  const { items, overCapacity, salvaged, goldSalvaged, filtered } = placer.result();

  return {
    dungeonId: dungeon.id,
    tier: tier.tier,
    ...(bossModifier ? { bossModifier } : {}),
    enrageAtMs: enrage.atMs,
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
    overCapacity,
    salvaged,
    ...(filtered ? { filtered } : {}),
    materials,
    questEvents,
  };
}

/**
 * Ticket 3.6: one run's enrage moment, a whole second in the tier's window. Data with a fixed
 * moment (`min === max`) draws nothing.
 */
export function resolveEnrage(enrage: BossEnrage, rng: Rng): ResolvedEnrage {
  const { min, max } = enrage.atMs;
  const steps = Math.max(0, Math.floor((max - min) / 1000));
  return {
    atMs: steps > 0 ? min + rng.int(0, steps) * 1000 : min,
    damageMultiplier: enrage.damageMultiplier,
    attackSpeedMultiplier: enrage.attackSpeedMultiplier,
  };
}

/**
 * Ticket 6.3: `rollEncounter` with the drawn foe's stats scaled (the Heroic chambers). The same
 * draws in the same order (the enemy, then the level offset), so the room's stream is unchanged.
 */
function rollScaledEncounter(
  rng: Rng,
  area: { enemies: DungeonDefinition['enemies']; minLevel: number; maxLevel: number },
  scale: EnemyScale,
  classId: ClassId,
  characterLevel: number,
  stats: StatBlock,
  config: CombatConfig,
  modifiers?: Parameters<typeof rollEncounter>[6],
  effects?: Parameters<typeof rollEncounter>[7],
): EncounterSetup {
  const entry = rng.weighted(area.enemies, (e) => e.weight);
  const spread = config.enemyLevelSpread;
  const offset = rng.int(-spread, spread);
  const enemyLevel = Math.min(area.maxLevel, Math.max(area.minLevel, characterLevel + offset));
  return buildEncounter(
    scaleEnemy(getEnemy(entry.enemyId), scale),
    enemyLevel,
    classId,
    characterLevel,
    stats,
    config,
    modifiers,
    effects,
  );
}

/** Ticket 3.6: an enemy with its health and damage scaled (a deeper tier's boss). */
export function scaleEnemy(enemy: EnemyDefinition, scale?: EnemyScale): EnemyDefinition {
  const resistance = scale?.resistance ?? 1;
  const armor = scale?.armor ?? 1;
  if (!scale || (scale.health === 1 && scale.damage === 1 && resistance === 1 && armor === 1))
    return enemy;
  return {
    ...enemy,
    ...(armor !== 1
      ? { armor: { base: enemy.armor.base * armor, perLevel: enemy.armor.perLevel * armor } }
      : {}),
    ...(resistance !== 1
      ? {
          resistance: {
            base: enemy.resistance.base * resistance,
            perLevel: enemy.resistance.perLevel * resistance,
          },
        }
      : {}),
    health: {
      base: enemy.health.base * scale.health,
      perLevel: enemy.health.perLevel * scale.health,
    },
    damage: {
      base: enemy.damage.base * scale.damage,
      perLevel: enemy.damage.perLevel * scale.damage,
    },
  };
}

/** Boss items (fixed count, boosted rarity odds) and the boss purse. */
function rollBossLoot(
  dungeon: DungeonTierDefinition,
  rng: Rng,
  goldFind: number,
  config: LootConfig,
  classId: ClassId,
  modifierId: BossModifierId | null,
): { gold: number; items: GeneratedItem[] } {
  const { bossLoot } = dungeon;
  const base = getLootTable(bossLoot.lootTableId);
  // Ticket 6.3: the week's modifier adds its small focus to the hoard (none: the table as it is).
  const table = modifierId
    ? { ...base, modifierFocus: getBossModifier(modifierId).lootFocus }
    : base;
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
      { seed: rng.int(0, MAX_SEED), itemLevel, lootTable: table, classId },
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
      case 'thorns':
        if (foe) foe = { ...foe, health: e.enemyHealth };
        break;
      case 'enemyAttack':
      case 'heal':
        health = e.health;
        break;
      case 'enrage':
        enraged = true;
        break;
      case 'burn':
        health = e.health;
        break;
      case 'shellBroken':
      case 'wardRaised':
      case 'wardBroken':
      case 'frenzy':
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
